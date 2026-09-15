import { t } from "../shared/i18n/index.ts";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	HStack,
	type OverlayHandle,
	ScrollView,
	type ScrollViewScrollbar,
	type StackEntry,
	type TUI,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { NavigationPanel, type NavigatorTheme, PromptPreview } from "./navigation-panel.ts";
import { activeTurn, NAVIGATOR_COLUMNS, navigationBand, type TurnAnchor } from "./turn-index.ts";

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface LayoutBox {
	component: Component;
	rect: Rect;
	clip: Rect;
	children: LayoutBox[];
	scrollView?: ScrollView;
	scrollContentLines?: readonly string[];
}

// Pi 0.85.x has no transcript-layout extension API. Keep all internal access here.
interface FullscreenInternals {
	layoutRoot?: Component;
	currentLayout?: { root: LayoutBox; primaryScrollView?: ScrollView };
	doRender(): void;
	handleViewportInput(data: string): { consume?: boolean } | undefined;
	isOverlayFocused(): boolean;
}

interface RootInternals {
	entries: StackEntry[];
}

interface RenderedContainerInternals {
	mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };
}

export interface NavigatorOptions {
	theme(): NavigatorTheme;
	error(message: string): void;
}

function findBox(box: LayoutBox, component: Component): LayoutBox | undefined {
	if (box.component === component) return box;
	for (const child of box.children) {
		const found = findBox(child, component);
		if (found) return found;
	}
	return undefined;
}

function contains(rect: Rect | undefined, x: number, y: number): boolean {
	return rect !== undefined && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

class ViewportAttachment {
	private readonly tui: TuiAltScreen;
	private readonly internals: FullscreenInternals;
	private readonly root: VStack;
	private readonly rootEntries: StackEntry[];
	private readonly entryIndex: number;
	private readonly originalEntry: StackEntry;
	private readonly scrollView: ScrollView;
	private readonly row: HStack;
	private readonly panel: NavigationPanel;
	private readonly options: NavigatorOptions;
	private readonly restorers: Array<() => void> = [];
	private readonly keys = new WeakMap<Component, number>();
	private nextKey = 0;
	private anchors: readonly TurnAnchor[] = [];
	private panelRect: Rect | undefined;
	private preview: OverlayHandle | undefined;
	private previewTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingPreview: number | undefined;
	private selectedKey: number | undefined;
	private scrollbar: ScrollViewScrollbar;
	private disposed = false;

	constructor(tui: TuiAltScreen, root: VStack, entries: StackEntry[], entryIndex: number, options: NavigatorOptions) {
		this.tui = tui;
		this.internals = tui as unknown as FullscreenInternals;
		this.root = root;
		this.rootEntries = entries;
		this.entryIndex = entryIndex;
		this.originalEntry = entries[entryIndex];
		this.scrollView = this.originalEntry.component as ScrollView;
		this.scrollbar = this.scrollView.scrollbar;
		this.options = options;
		this.panel = new NavigationPanel({
			theme: options.theme,
			jump: (index) => this.jump(index),
			preview: (index, row) => this.showPreview(index, row),
			redraw: () => tui.requestRender(),
		});
		this.row = new HStack([
			{ component: this.scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: this.panel, basis: NAVIGATOR_COLUMNS, shrink: 0, visible: ({ width }) => width >= 20 },
		]);
		entries[entryIndex] = { ...this.originalEntry, component: this.row };
		root.children[entryIndex] = this.row;
		const setScrollbar = this.scrollView.setScrollbar;
		setScrollbar.call(this.scrollView, "hidden");
		this.replace(this.scrollView, "setScrollbar", (mode: ScrollViewScrollbar) => {
			this.scrollbar = mode;
			setScrollbar.call(this.scrollView, "hidden");
		});
		const render = this.internals.doRender;
		this.replace(this.internals, "doRender", () => {
			render.call(tui);
			if (!this.disposed) this.sync();
		});
		const input = this.internals.handleViewportInput;
		this.replace(this.internals, "handleViewportInput", (data: string) => {
			this.observeInput(data);
			return input.call(tui, data);
		});
		tui.requestRender();
	}

	private replace<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		target[key] = value;
		this.restorers.push(() => {
			if (target[key] !== value) return;
			if (descriptor) Object.defineProperty(target, key, descriptor);
			else Reflect.deleteProperty(target, key);
		});
	}

	private indexTurns(width: number, height: number): TurnAnchor[] {
		const anchors: TurnAnchor[] = [];
		const visit = (component: Component, row: number, renderedHeight: number): boolean => {
			if (renderedHeight === 0) return true;
			if (component instanceof UserMessageComponent) {
				const text = (component as unknown as { text?: unknown }).text;
				if (typeof text !== "string") return false;
				let key = this.keys.get(component);
				if (key === undefined) {
					key = this.nextKey++;
					this.keys.set(component, key);
				}
				anchors.push({ key, text, row });
				return true;
			}
			// Only plain vertical containers concatenate child rows without adding their own offsets.
			if (!(component instanceof Container) || component.render !== Container.prototype.render) return true;
			const layout = (component as unknown as RenderedContainerInternals).mouseLayout;
			if (
				layout?.width !== width ||
				layout.children.length !== component.children.length ||
				layout.children.some((child, index) => child.component !== component.children[index]) ||
				layout.children.reduce((sum, child) => sum + child.height, 0) !== renderedHeight
			)
				return false;
			let offset = row;
			for (const child of layout.children) {
				if (!visit(child.component, offset, child.height)) return false;
				offset += child.height;
			}
			return true;
		};
		// Reuse the exact rendered heights; OSC 133 starts also belong to assistant messages.
		const document = this.scrollView.children[0];
		return document && visit(document, 0, height) ? anchors : [];
	}

	private sync(): void {
		const layout = this.internals.currentLayout;
		if (!layout || layout.primaryScrollView !== this.scrollView) return;
		const scrollBox = findBox(layout.root, this.scrollView);
		const panelBox = findBox(layout.root, this.panel);
		if (!scrollBox || !panelBox?.clip.width) {
			this.panelRect = undefined;
			this.hidePreview();
			return;
		}
		// Anchors first: the band height depends on how many markers must fit on one line each.
		this.anchors = this.indexTurns(
			this.scrollView.getContentWidth(scrollBox.rect.width),
			scrollBox.scrollContentLines?.length ?? 0,
		);
		const band = navigationBand(panelBox.clip.height, this.anchors.length);
		this.panelRect = { ...panelBox.clip, y: panelBox.clip.y + band.top, height: band.height };
		let active = activeTurn(this.anchors, this.scrollView.scrollTop, this.scrollView.viewportHeight);
		const maxTop = Math.max(0, (scrollBox.scrollContentLines?.length ?? 0) - this.scrollView.viewportHeight);
		const selected = this.anchors.findIndex((anchor) => anchor.key === this.selectedKey);
		if (selected >= 0 && this.anchors[selected].row > maxTop && this.scrollView.scrollTop === maxTop) {
			// A short final prompt cannot reach the top; keep the explicitly selected, visible target active.
			active = selected;
		} else {
			this.selectedKey = undefined;
			// Scrolled to the very end: the last turn owns the transcript tail even when its
			// header can never cross the focus line (short final turn / streaming follow).
			if (this.scrollView.scrollTop >= maxTop && this.anchors.length > 0) active = this.anchors.length - 1;
		}
		if (this.panel.update(this.anchors, active, panelBox.clip.height)) {
			this.hidePreview();
			this.tui.requestRender();
		}
		if (this.internals.isOverlayFocused()) {
			this.panel.leave();
			this.hidePreview();
		}
	}

	private jump(index: number): void {
		const target = this.anchors[index];
		if (!target) return;
		this.hidePreview();
		this.selectedKey = target.key;
		this.scrollView.scrollTo(target.row, { disableFollow: true });
		this.tui.requestRender();
	}

	private showPreview(index: number | undefined, row = 0): void {
		this.hidePreview();
		if (index === undefined || !this.panelRect || this.internals.isOverlayFocused()) return;
		this.pendingPreview = index;
		this.previewTimer = setTimeout(() => {
			this.previewTimer = undefined;
			const anchor = this.anchors[index];
			const rect = this.panelRect;
			if (this.disposed || !anchor || !rect || this.pendingPreview !== index || this.internals.isOverlayFocused())
				return;
			const width = Math.min(58, rect.x);
			if (width < 12) return;
			const maxHeight = Math.min(10, this.tui.terminal.rows);
			const component = new PromptPreview(anchor, index, maxHeight, this.options.theme);
			const height = component.render(width).length;
			this.preview = this.tui.showOverlay(component, {
				width,
				maxHeight,
				col: rect.x - width,
				row: Math.max(0, Math.min(rect.y + row, this.tui.terminal.rows - height)),
				nonCapturing: true,
			});
		}, 160);
		this.previewTimer.unref();
	}

	private hidePreview(): void {
		if (this.previewTimer) clearTimeout(this.previewTimer);
		this.previewTimer = undefined;
		this.pendingPreview = undefined;
		this.preview?.hide();
		this.preview = undefined;
	}

	private observeInput(data: string): void {
		const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!mouse) {
			this.panel.leave();
			this.hidePreview();
			return;
		}
		const button = Number(mouse[1]);
		const x = Number(mouse[2]) - 1;
		const y = Number(mouse[3]) - 1;
		const bounds = this.preview?.getBounds();
		const insidePreview =
			bounds !== undefined &&
			contains({ x: bounds.col, y: bounds.row, width: bounds.width, height: bounds.height }, x, y);
		const motion = (button & 32) !== 0;
		if (!contains(this.panelRect, x, y) && !insidePreview) {
			this.panel.leave();
			this.hidePreview();
		}
		if (!motion) {
			if ((button & 64) !== 0) this.selectedKey = undefined;
			this.hidePreview();
			if (insidePreview) this.tui.renderNow();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.hidePreview();
		for (const restore of this.restorers.reverse()) restore();
		if (this.rootEntries[this.entryIndex]?.component === this.row)
			this.rootEntries[this.entryIndex] = this.originalEntry;
		if (this.root.children[this.entryIndex] === this.row)
			this.root.children[this.entryIndex] = this.originalEntry.component;
		this.scrollView.setScrollbar(this.scrollbar);
		this.tui.requestRender();
	}
}

export function installNavigator(options: NavigatorOptions): { attach(tui: TUI): boolean; dispose(): void } {
	const attachments = new Map<TuiAltScreen, ViewportAttachment>();
	const original = TuiAltScreen.prototype.setLayoutRoot;
	let disposed = false;
	let reported = false;
	const attach = (reference: TUI): boolean => {
		// InteractiveMode's stable Proxy binds methods, including valueOf, to its active renderer.
		const tui = reference.valueOf();
		if (disposed || !(tui instanceof TuiAltScreen)) return false;
		if (attachments.has(tui)) return true;
		const internals = tui as unknown as FullscreenInternals;
		const root = internals.layoutRoot;
		if (!(root instanceof VStack)) return false;
		const entries = (root as unknown as RootInternals).entries;
		const index = Array.isArray(entries)
			? entries.findIndex((entry) => entry.component instanceof ScrollView && entry.component.primary)
			: -1;
		if (index < 0 || typeof internals.doRender !== "function" || typeof internals.handleViewportInput !== "function") {
			if (!reported) options.error(t("navigator.unsupported"));
			reported = true;
			return false;
		}
		attachments.set(tui, new ViewportAttachment(tui, root, entries, index, options));
		return true;
	};
	const setLayoutRoot = function (this: TuiAltScreen, component: Component | undefined): void {
		attachments.get(this)?.dispose();
		attachments.delete(this);
		original.call(this, component);
		if (component) attach(this);
	};
	TuiAltScreen.prototype.setLayoutRoot = setLayoutRoot;
	return {
		attach,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (TuiAltScreen.prototype.setLayoutRoot === setLayoutRoot) TuiAltScreen.prototype.setLayoutRoot = original;
			for (const attachment of attachments.values()) attachment.dispose();
			attachments.clear();
		},
	};
}
