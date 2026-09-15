import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { markerRows, navigationBand, sameAnchors, type TurnAnchor } from "./turn-index.ts";

export type NavigatorTheme = Pick<Theme, "fg" | "bg" | "bold">;

export interface PanelActions {
	theme(): NavigatorTheme;
	jump(index: number): void;
	preview(index: number | undefined, row?: number): void;
	redraw(): void;
}

export class NavigationPanel implements Component {
	private readonly actions: PanelActions;
	private anchors: readonly TurnAnchor[] = [];
	private height = 0;
	private band = navigationBand(0);
	private active = -1;
	private start = 0;
	private hovered: number | undefined;
	private markers = new Map<number, number>();

	constructor(actions: PanelActions) {
		this.actions = actions;
	}

	update(anchors: readonly TurnAnchor[], active: number, height: number): boolean {
		if (height === this.height && active === this.active && sameAnchors(this.anchors, anchors)) return false;
		const recenter = active !== this.active || height !== this.height || !sameAnchors(this.anchors, anchors);
		this.anchors = anchors;
		this.active = active;
		this.height = Math.max(0, height);
		this.band = navigationBand(this.height, anchors.length);
		const capacity = Math.max(0, this.band.height - 2);
		if (recenter) this.start = Math.max(0, Math.min(active - Math.floor(capacity / 2), anchors.length - capacity));
		this.markers = markerRows(anchors.length, this.band.height, this.start);
		this.leave();
		return true;
	}

	leave(): void {
		if (this.hovered === undefined) return;
		this.hovered = undefined;
		this.actions.preview(undefined);
		this.actions.redraw();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.actions.theme();
		return Array.from({ length: this.height }, (_, screenRow) => {
			const row = screenRow - this.band.top;
			if (row < 0 || row >= this.band.height) return " ".repeat(width);
			const index = this.markers.get(row);
			let glyph = "";
			let enabled = false;
			if (this.band.height >= 3 && row === 0) {
				glyph = "\u25b2";
				enabled = this.active > 0;
			} else if (this.band.height >= 3 && row === this.band.height - 1) {
				glyph = "\u25bc";
				enabled = this.active >= 0 && this.active < this.anchors.length - 1;
			} else if (index !== undefined) {
				glyph = index === this.active ? "\u2550" : "\u2500";
				enabled = true;
			}
			glyph = truncateToWidth(glyph, width, "");
			const pad = " ".repeat(Math.max(0, width - visibleWidth(glyph)));
			if (!glyph) return pad;
			const painted =
				this.hovered === row && enabled
					? theme.bg("selectedBg", theme.fg("accent", glyph))
					: theme.fg(index === this.active && index !== undefined ? "accent" : enabled ? "muted" : "dim", glyph);
			return pad + painted;
		});
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const row = event.y - this.band.top;
		if (row < 0 || row >= this.band.height || this.band.height < 3) {
			this.leave();
			return undefined;
		}
		if (event.type === "move") {
			if (this.hovered !== row) {
				this.hovered = row;
				this.actions.preview(this.markers.get(row), row);
				return { handled: true, render: true };
			}
		} else if (event.type === "wheel") {
			const capacity = Math.max(0, this.band.height - 2);
			const delta = Math.sign(event.wheelDelta ?? 0) * 3;
			this.start = Math.max(0, Math.min(this.start + delta, this.anchors.length - capacity));
			this.markers = markerRows(this.anchors.length, this.band.height, this.start);
			this.leave();
			return { handled: true, render: true };
		} else if (event.type === "click" && event.button === "left") {
			const index =
				row === 0 ? this.active - 1 : row === this.band.height - 1 ? this.active + 1 : this.markers.get(row);
			if (index !== undefined && index >= 0 && index < this.anchors.length) this.actions.jump(index);
		}
		return { handled: true };
	}
}

export class PromptPreview implements Component {
	private readonly text: string;
	private readonly label: string;
	private readonly maxHeight: number;
	private readonly theme: () => NavigatorTheme;

	constructor(anchor: TurnAnchor, index: number, maxHeight: number, theme: () => NavigatorTheme) {
		this.text = stripTerminalSequences(anchor.text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
		this.label = ` ${index + 1} `;
		this.maxHeight = Math.max(3, maxHeight);
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 4) return [];
		const theme = this.theme();
		const inner = width - 4;
		const body = wrapTextWithAnsi(this.text, Math.max(1, inner));
		const limit = this.maxHeight - 2;
		const visible = body.slice(0, limit);
		if (body.length > limit) visible[limit - 1] = truncateToWidth(`${visible[limit - 1]}...`, inner, "...");
		const label = truncateToWidth(this.label, width - 2, "");
		const top = `\u250c${label}${"\u2500".repeat(Math.max(0, width - 2 - visibleWidth(label)))}\u2510`;
		return [
			theme.fg("border", top),
			...visible.map((line) => {
				const text = truncateToWidth(line, inner, "");
				return (
					theme.fg("border", "\u2502 ") +
					theme.fg("text", text + " ".repeat(Math.max(0, inner - visibleWidth(text)))) +
					theme.fg("border", " \u2502")
				);
			}),
			theme.fg("border", `\u2514${"\u2500".repeat(width - 2)}\u2518`),
		];
	}
}
