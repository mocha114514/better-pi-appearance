/**
 * TUI presence for live subagent instances.
 *
 * Two pieces:
 *   - Indicator: a one-row widget above the editor ("● N subagents"), colored
 *     by the most urgent status present. Hidden entirely when the pool is
 *     empty. Click toggles the overlay.
 *   - Overlay: a floating, non-focus-capturing panel anchored bottom-left
 *     (just above the editor), one row per instance with a colored status dot,
 *     id, model and thinking level. Capped height with mouse-wheel scrolling.
 *
 * Status colors: running=green, awaiting decision=yellow, kept=blue,
 * recovered leftover=gray.
 */

import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { t } from "../shared/i18n/index.ts";
import type { Instance, InstancePool, InstanceStatus } from "./pool.ts";

const WIDGET_KEY = "mpep-subagent";
/** Content rows visible before wheel scrolling kicks in. */
const MAX_VIEWPORT_ROWS = 8;

const STATUS_COLOR: Record<InstanceStatus, ThemeColor> = {
	running: "success",
	awaiting_decision: "warning",
	kept: "accent",
	recovered: "dim",
};

const STATUS_LABEL: Record<InstanceStatus, string> = {
	running: "running",
	awaiting_decision: "awaiting",
	kept: "kept",
	recovered: "leftover",
};

/** Indicator dot follows the most urgent status in the pool. */
const STATUS_PRIORITY: InstanceStatus[] = ["running", "awaiting_decision", "kept", "recovered"];

/** Strip the provider prefix for compact display: "local-x/flash" -> "flash". */
function shortModel(model: string | undefined): string {
	if (!model) return "default";
	const slash = model.lastIndexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}

class SubagentOverlay implements Component {
	private scrollOffset = 0;

	constructor(
		private readonly tui: TUI,
		private readonly ctx: ExtensionContext,
		private readonly pool: InstancePool,
	) {}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		const maxOffset = Math.max(0, this.pool.list().length - MAX_VIEWPORT_ROWS);
		// wheelDelta is in logical lines; negative scrolls up.
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + event.wheelDelta));
		return { handled: true };
	}

	render(_width: number): string[] {
		const theme = this.ctx.ui.theme;
		const items = this.pool.list();
		if (items.length === 0) return [];

		const title = ` ${t("subagent.overlayTitle")} (${items.length}) `;
		const rows = items.map((item) => {
			const dot = theme.fg(STATUS_COLOR[item.meta.status], "●");
			const id = item.meta.id;
			const model = shortModel(item.meta.model);
			const thinking = item.meta.thinking ?? "default";
			const status = theme.fg(STATUS_COLOR[item.meta.status], STATUS_LABEL[item.meta.status]);
			return { dot, id, model, thinking, status };
		});

		// Column widths from content, clamped to the terminal.
		const termCols = this.tui.terminal.columns || 100;
		const plain = (s: string) => visibleWidth(s);
		const idW = Math.max(...rows.map((r) => plain(r.id)));
		const modelW = Math.max(...rows.map((r) => plain(r.model)));
		const thinkW = Math.max(...rows.map((r) => plain(r.thinking)));
		const natural = idW + modelW + thinkW + 8 + 12;
		const boxWidth = Math.max(36, Math.min(natural, termCols - 6));

		const border = (s: string) => theme.fg("dim", s);
		const lines: string[] = [];

		const topInner = Math.max(0, boxWidth - 2 - plain(title));
		lines.push(border("╭") + theme.fg("accent", title) + border("─".repeat(topInner) + "╮"));

		const slice = rows.slice(this.scrollOffset, this.scrollOffset + MAX_VIEWPORT_ROWS);
		for (const row of slice) {
			const content = ` ${row.dot} ${row.id.padEnd(idW)}  ${row.model.padEnd(modelW)}  ${row.thinking.padEnd(thinkW)}  ${row.status}`;
			lines.push(truncateToWidth(`${border("│")}${content}`, boxWidth - 1, "") + border("│"));
		}

		const scrolled = items.length > MAX_VIEWPORT_ROWS;
		const hint = scrolled ? ` ${this.scrollOffset + 1}-${Math.min(items.length, this.scrollOffset + MAX_VIEWPORT_ROWS)}/${items.length} ` : "";
		const bottomInner = Math.max(0, boxWidth - 2 - plain(hint));
		lines.push(border(`╰${"─".repeat(bottomInner)}`) + theme.fg("dim", hint) + border("╯"));
		return lines;
	}
}

class SubagentIndicator implements Component {
	constructor(
		private readonly ctx: ExtensionContext,
		private readonly pool: InstancePool,
		private readonly toggleOverlay: () => void,
	) {}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click" && event.button === "left" && event.y === 0) {
			this.toggleOverlay();
			return { handled: true };
		}
		return undefined;
	}

	render(width: number): string[] {
		const items = this.pool.list();
		if (items.length === 0) return [];
		const theme = this.ctx.ui.theme;
		const top = STATUS_PRIORITY.find((s) => items.some((i) => i.meta.status === s)) ?? "kept";
		const dot = theme.fg(STATUS_COLOR[top], "●");
		const label = theme.fg("dim", t("subagent.indicator", { count: items.length }));
		return [truncateToWidth(` ${dot} ${label}`, Math.max(1, width))];
	}
}

export interface SubagentWidgetController {
	dispose(): void;
}

/** Mount the indicator widget and wire the click-to-toggle overlay. */
export function installSubagentWidget(ctx: ExtensionContext, pool: InstancePool): SubagentWidgetController {
	if (!ctx.hasUI || ctx.mode !== "tui") return { dispose() {} };

	let tui: TUI | undefined;
	let overlayHandle: OverlayHandle | undefined;

	const closeOverlay = () => {
		overlayHandle?.hide();
		overlayHandle = undefined;
	};
	const toggleOverlay = () => {
		if (!tui) return;
		if (overlayHandle) {
			closeOverlay();
		} else if (pool.list().length > 0) {
			overlayHandle = tui.showOverlay(new SubagentOverlay(tui, ctx, pool), {
				anchor: "bottom-left",
				margin: 1,
				maxHeight: MAX_VIEWPORT_ROWS + 2,
				nonCapturing: true,
			});
		}
	};

	ctx.ui.setWidget(WIDGET_KEY, (tuiInstance) => {
		tui = tuiInstance;
		return new SubagentIndicator(ctx, pool, toggleOverlay);
	});

	// Live refresh; auto-close the overlay when the last instance goes away.
	const unsubscribe = pool.onChange(() => {
		if (pool.list().length === 0) closeOverlay();
		tui?.requestRender();
	});

	return {
		dispose() {
			unsubscribe();
			closeOverlay();
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			tui = undefined;
		},
	};
}
