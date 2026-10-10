import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

interface BorderStatus {
	renderInBorder(width: number): string;
	renderSpinnerInBorder(width: number): string;
}

interface EditorInternals {
	workingStatusIndicator?: BorderStatus;
	ctrlCPending?: boolean;
	borderColor(text: string): string;
	renderTopBorder(width: number, hiddenLineCount: number): string;
}

interface LayoutBox {
	component: Component;
	rect: { x: number; y: number; width: number; height: number };
	children: LayoutBox[];
}

export interface EditorAnchor {
	row: number;
	col: number;
	width: number;
}

export interface EditorBorderContribution {
	position: "idle-left" | "right";
	label(): string;
	onClick?(event: TuiMouseEvent): void;
}

export interface EditorBorderHandle {
	sync(): boolean;
	getAnchor(): EditorAnchor | undefined;
	dispose(): void;
}

interface BorderMount {
	contributions: Map<symbol, EditorBorderContribution>;
	remove(token: symbol): void;
}

const REGISTRY = Symbol.for("mpep.editor-border.mounts.v1");
const shared = globalThis as typeof globalThis & {
	[REGISTRY]?: WeakMap<CustomEditor, BorderMount>;
};
// Pi may evaluate this shared source separately for each extension. One registry
// gives the cooking label and list button a single, independently disposable hook.
const mounts = shared[REGISTRY] ??= new WeakMap<CustomEditor, BorderMount>();

function findEditor(components: readonly Component[]): CustomEditor | undefined {
	for (let index = components.length - 1; index >= 0; index--) {
		const component = components[index];
		if (component instanceof CustomEditor) return component;
		if (component instanceof Container && !(component instanceof ScrollView)) {
			const editor = findEditor(component.children);
			if (editor) return editor;
		}
	}
	return undefined;
}

function restoreMethod(
	editor: CustomEditor,
	name: "renderTopBorder" | "handleMouse",
	wrapper: unknown,
	descriptor: PropertyDescriptor | undefined,
): boolean {
	if (Reflect.get(editor, name) !== wrapper) return false;
	if (descriptor) Object.defineProperty(editor, name, descriptor);
	else Reflect.deleteProperty(editor, name);
	return true;
}

function mountEditor(editor: CustomEditor): BorderMount {
	const existing = mounts.get(editor);
	if (existing) return existing;
	const internals = editor as unknown as EditorInternals;
	const originalRender = internals.renderTopBorder;
	const originalMouse = editor.handleMouse;
	const renderDescriptor = Object.getOwnPropertyDescriptor(editor, "renderTopBorder");
	const mouseDescriptor = Object.getOwnPropertyDescriptor(editor, "handleMouse");
	const contributions = new Map<symbol, EditorBorderContribution>();
	let hit: { start: number; end: number; contribution: EditorBorderContribution } | undefined;

	const render = function (this: EditorInternals, width: number, hidden: number): string {
		hit = undefined;
		// An exit-confirmation border is safety UI, not an available status slot.
		if (this.ctrlCPending || contributions.size === 0) {
			return originalRender.call(this, width, hidden);
		}
		const values = [...contributions.values()];
		const left = values.findLast(value => value.position === "idle-left");
		const right = values.findLast(value => value.position === "right");
		const rightLabel = right?.label() ?? "";
		const rightWidth = visibleWidth(rightLabel);
		const suffixWidth = rightWidth + 4;
		const showRight = rightWidth > 0 && width >= suffixWidth + 5;
		const available = showRight ? width - suffixWidth : width;
		const idleLabel = !this.workingStatusIndicator && editor.embedWorkingStatus ? left?.label() : undefined;
		const status: BorderStatus | undefined = idleLabel ? {
			renderInBorder: space => truncateToWidth(idleLabel, space, ""),
			renderSpinnerInBorder: () => "",
		} : undefined;
		if (status) this.workingStatusIndicator = status;
		let base: string;
		try {
			base = originalRender.call(this, available, hidden);
		} finally {
			if (status && this.workingStatusIndicator === status) this.workingStatusIndicator = undefined;
		}
		if (!showRight || !right) return base;
		const clipped = truncateToWidth(base, available, "");
		const padding = Math.max(0, available - visibleWidth(clipped));
		hit = { start: available + 1, end: available + 1 + rightWidth, contribution: right };
		return clipped + this.borderColor("─".repeat(padding) + " ") + rightLabel + this.borderColor(" ──");
	};

	const handleMouse = function (
		this: CustomEditor,
		event: TuiMouseEvent,
	): TuiMouseEventResult | undefined {
		if (
			hit && event.button === "left" && event.y === 0 &&
			event.x >= hit.start && event.x < hit.end && hit.contribution.onClick
		) {
			// Claim the press before fullscreen word selection sees it. Otherwise a
			// quick second click inside the label may copy text instead of toggling.
			if (event.type === "press") return { handled: true, capture: true, focus: false };
			if (event.type === "release" || event.type === "drag") return { handled: true, focus: false };
			if (event.type === "click") {
				hit.contribution.onClick(event);
				return { handled: true, focus: false };
			}
		}
		return originalMouse.call(this, event);
	};

	internals.renderTopBorder = render;
	editor.handleMouse = handleMouse;
	const mount: BorderMount = {
		contributions,
		remove(token) {
			if (hit?.contribution === contributions.get(token)) hit = undefined;
			contributions.delete(token);
			if (contributions.size > 0) return;
			hit = undefined;
			// Restore both hooks together. If another extension wrapped either one,
			// leave a dormant mount so later attachment reuses that wrapper chain.
			if (internals.renderTopBorder !== render || editor.handleMouse !== handleMouse) return;
			restoreMethod(editor, "renderTopBorder", render, renderDescriptor);
			restoreMethod(editor, "handleMouse", handleMouse, mouseDescriptor);
			mounts.delete(editor);
		},
	};
	mounts.set(editor, mount);
	return mount;
}

/** Isolate Pi's non-public editor-border and fullscreen-layout adaptation here. */
export function createEditorBorder(
	tui: TUI,
	contribution: EditorBorderContribution,
): EditorBorderHandle {
	const token = Symbol("editor-border-contribution");
	let current: CustomEditor | undefined;
	let mount: BorderMount | undefined;
	let disposed = false;
	return {
		sync() {
			if (disposed) return false;
			const found = findEditor(tui.children ?? []);
			const next = contribution.position === "idle-left" && !found?.embedWorkingStatus ? undefined : found;
			if (next === current) return current !== undefined;
			mount?.remove(token);
			current = next;
			mount = next ? mountEditor(next) : undefined;
			mount?.contributions.set(token, contribution);
			return next !== undefined;
		},
		getAnchor() {
			if (!current || disposed) return undefined;
			const host = tui.valueOf() as TUI & { currentLayout?: { root: LayoutBox } };
			const visit = (box: LayoutBox): LayoutBox | undefined => {
				if (box.component === current) return box;
				for (const child of box.children) {
					const found = visit(child);
					if (found) return found;
				}
				return undefined;
			};
			const root = host.currentLayout?.root;
			const box = root ? visit(root) : undefined;
			return box ? { row: box.rect.y, col: box.rect.x, width: box.rect.width } : undefined;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			mount?.remove(token);
			mount = undefined;
			current = undefined;
		},
	};
}
