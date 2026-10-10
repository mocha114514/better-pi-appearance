import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { createEditorBorder, type EditorAnchor, type EditorBorderHandle } from "../shared/editor-border.ts";
import { t } from "../shared/i18n/index.ts";
import type { ListState } from "./model.ts";
import { ListPanel, PANEL_WIDTH } from "./panel.ts";

const WIDGET_KEY = "mpep-list-bridge";

export interface ListWidget {
	changed(): void;
	toggle(): void;
	dispose(): void;
}

/** Capture the TUI without replacing the editor, footer, or another plugin's widget. */
export function installListWidget(ctx: ExtensionContext, readState: () => ListState | undefined): ListWidget {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		return { changed() {}, toggle() {}, dispose() {} };
	}
	let tui: TUI | undefined;
	let border: EditorBorderHandle | undefined;
	let panel: ListPanel | undefined;
	let overlay: OverlayHandle | undefined;
	let options: OverlayOptions | undefined;
	let clickAnchor: EditorAnchor | undefined;
	let disposed = false;
	let scheduled = false;

	const close = () => {
		overlay?.hide();
		overlay = undefined;
		options = undefined;
	};

	const position = (): boolean => {
		if (!tui || !panel || !options || tui.mode !== "fullscreen") return false;
		const anchor = border?.getAnchor() ?? clickAnchor;
		if (!anchor) return false;
		const rows = Math.max(0, Math.min(anchor.row, tui.terminal.rows));
		const width = Math.min(PANEL_WIDTH, anchor.width, tui.terminal.columns);
		if (rows < 3 || width < 8) return false;
		const height = panel.configure(width, rows);
		const col = Math.max(0, Math.min(anchor.col + anchor.width - width, tui.terminal.columns - width));
		const row = rows - height;
		const changed = options.row !== row || options.col !== col || options.width !== width || options.maxHeight !== rows;
		// showOverlay retains the options object. Updating it preserves the panel
		// component, its scroll position, and keyboard focus across dock resizes.
		options.row = row;
		options.col = col;
		options.width = width;
		options.maxHeight = rows;
		if (changed) tui.requestRender();
		return true;
	};

	const toggle = () => {
		if (disposed || !tui || !panel) return;
		if (tui.mode !== "fullscreen") {
			ctx.ui.notify(t("list.fullscreenRequired"), "warning");
			return;
		}
		if (overlay) {
			close();
			return;
		}
		options = { margin: 0, minWidth: 1, nonCapturing: true };
		if (!position()) {
			options = undefined;
			ctx.ui.notify(t("list.noRoom"), "warning");
			return;
		}
		overlay = tui.showOverlay(panel, options);
	};

	const onResize = () => {
		// Fullscreen uses live layout; inline mode only has the last click's
		// coordinates, so discard those rather than cover a moved input border.
		clickAnchor = undefined;
		if (overlay && !border?.getAnchor()) close();
	};
	process.stdout.on("resize", onResize);

	ctx.ui.setWidget(WIDGET_KEY, (host) => {
		tui = host;
		panel = new ListPanel(readState, () => ctx.ui.theme);
		border = createEditorBorder(host, {
			position: "right",
			label: () => host.mode === "fullscreen" ? ctx.ui.theme.fg(overlay ? "accent" : "muted", "list") : "",
			onClick(event) {
				clickAnchor = { row: event.screenY, col: event.screenX - event.x, width: event.width };
				toggle();
			},
		});
		return {
			render() {
				border?.sync();
				if (overlay && !scheduled) {
					scheduled = true;
					// Widget measurement precedes final layout. Re-anchor only after the
					// dock has its final bounds, including input-height/content changes.
					queueMicrotask(() => {
						scheduled = false;
						if (!disposed && overlay && !position()) close();
					});
				}
				return [];
			},
			invalidate() { panel?.invalidate(); },
		};
	});

	return {
		changed() {
			panel?.invalidate();
			if (overlay && !position()) close();
			tui?.requestRender();
		},
		toggle,
		dispose() {
			if (disposed) return;
			disposed = true;
			process.stdout.off("resize", onResize);
			close();
			border?.dispose();
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			tui = undefined;
		},
	};
}
