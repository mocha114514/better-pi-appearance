// Floating checklist panel.
//
// The controller measures the free rows above the editor and calls configure
// before showOverlay or a reposition. configure remembers that width and the
// maximum frame height (the two borders count) and returns the height that
// will actually be drawn. Short lists shrink to their content. Long lists use
// the free space and scroll; nothing is dropped and there is no item cap.
//
// Scroll is counted in rendered lines, not items, and it is remembered for
// the current list id. Completing an item keeps the position (clamped if the
// text got shorter). A different list id starts at the top again.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { t } from "../shared/i18n/index.ts";
import { blockedBy, type ListItem, type ListState } from "./model.ts";

/** Preferred frame width. The controller still clamps it to the screen. */
export const PANEL_WIDTH = 64;

// Chalk's strikethrough is a no-op when the color level is 0. The title has
// to stay struck through in the rendered cells, so the SGR is written directly:
// 9 turns it on and 29 turns it off without clearing the theme color.
const STRIKE_ON = "\x1b[9m";
const STRIKE_OFF = "\x1b[29m";

type Ink = Parameters<Theme["fg"]>[0];

function columns(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

// Tabs are three columns in pi-tui's visibleWidth. Expand them before wrapping
// so a terminal tab stop cannot push the right border out of the frame.
// CR becomes a line break; other C0 controls are dropped.
function printable(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "   ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function wrapColumns(text: string, width: number): string[] {
	if (width <= 0) return [];
	return wrapTextWithAnsi(printable(text), width)
		.map(line => truncateToWidth(line, width, ""));
}

export class ListPanel implements Component {
	private readonly readState: () => ListState | undefined;
	private readonly theme: () => Theme;
	private allocatedWidth = PANEL_WIDTH;
	private maxHeight = 0;
	private configured = false;
	private width = PANEL_WIDTH;
	private scrollOffset = 0;
	private listId: string | undefined;

	constructor(readState: () => ListState | undefined, theme: () => Theme) {
		this.readState = readState;
		this.theme = theme;
	}

	/** Remember the allocated frame and return the height render() will use. */
	configure(width: number, maxHeight: number): number {
		this.configured = true;
		this.allocatedWidth = columns(width);
		this.maxHeight = columns(maxHeight);
		return this.layout(this.allocatedWidth).length;
	}

	invalidate(): void {
		// There is no line cache. Scroll belongs to the list the user is
		// reading, so a theme change must not send them back to the top.
	}

	render(width: number): string[] {
		const given = columns(width);
		const used = this.configured ? Math.min(this.allocatedWidth, given) : given;
		return this.layout(used);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const state = this.readState();
			this.sync(state);
			const body = this.measure(state);
			this.scrollOffset += Math.trunc(event.wheelDelta ?? 0);
			this.clamp(body, this.frame(body).viewport);
			// Non-modal: consume the wheel so the transcript behind the panel
			// does not move, but do not take the editor's keyboard focus.
			return { handled: true, focus: false, render: true };
		}
		if (event.type === "click") {
			// A click on the body must not dismiss the panel or focus it.
			return { handled: true, focus: false, render: false };
		}
		// press / drag / release / move stay with the renderer so a drag can
		// select the text. Swallowing them would cancel that gesture.
		return undefined;
	}

	private paint(color: Ink, text: string): string {
		return this.theme().fg(color, text);
	}

	private sync(state: ListState | undefined): void {
		const id = state?.id;
		if (id === this.listId) return;
		this.listId = id;
		this.scrollOffset = 0;
	}

	private frame(bodyLength: number): { height: number; viewport: number } {
		if (this.width <= 0) return { height: 0, viewport: 0 };
		const natural = bodyLength + 2;
		const cap = this.configured ? this.maxHeight : natural;
		const height = Math.min(natural, Math.max(0, cap));
		const viewport = height >= 2 ? height - 2 : 0;
		return { height, viewport };
	}

	private clamp(bodyLength: number, viewport: number): void {
		const max = Math.max(0, bodyLength - Math.max(0, viewport));
		if (this.scrollOffset > max) this.scrollOffset = max;
		if (this.scrollOffset < 0) this.scrollOffset = 0;
	}

	private measure(state: ListState | undefined): number {
		if (this.width < 2) return 0;
		return this.bodyLines(state, this.width - 2).length;
	}

	private layout(width: number): string[] {
		this.width = width;
		const state = this.readState();
		this.sync(state);
		if (width <= 0) return [];

		const inner = width - 2;
		const body = inner > 0 ? this.bodyLines(state, inner) : [];
		const frame = this.frame(body.length);
		this.clamp(body.length, frame.viewport);
		if (frame.height <= 0) return [];
		if (frame.height === 1) return [this.seal(this.top(state, width), width, "╮")];

		const visible = body.slice(this.scrollOffset, this.scrollOffset + frame.viewport);
		while (visible.length < frame.viewport) visible.push("");
		const lines = [
			this.top(state, width),
			...visible.map(line => this.row(line, width)),
			this.bottom(body.length, frame.viewport, width),
		];
		return lines.map((line, index) => {
			const right = index === 0 ? "╮" : index === lines.length - 1 ? "╯" : "│";
			return this.seal(line, width, right);
		});
	}

	private bodyLines(state: ListState | undefined, inner: number): string[] {
		if (!state || state.items.length === 0) {
			const lines: string[] = [];
			if (state && state.title.trim().length > 0) {
				lines.push(...this.wrapped(state.title, inner, "text"));
				lines.push("");
			}
			lines.push(...this.wrapped(t("list.empty"), inner, "dim"));
			return lines;
		}

		const lines: string[] = [];
		const completion = new Map(state.items.map(item => [item.id, item.done] as const));
		if (state.title.trim().length > 0) {
			lines.push(...this.wrapped(state.title, inner, "text"));
			lines.push("");
		}
		let index = 0;
		for (const item of state.items) {
			if (index > 0) lines.push("");
			lines.push(...this.itemLines(state, item, inner, completion));
			index += 1;
		}
		return lines;
	}

	private wrapped(text: string, width: number, color: Ink): string[] {
		return wrapColumns(text, width).map(line => this.paint(color, line));
	}

	private itemLines(
		state: ListState,
		item: ListItem,
		inner: number,
		completion: ReadonlyMap<string, boolean>,
	): string[] {
		const mark = item.done ? "[x]" : "[ ]";
		const prefix = `${this.paint(item.done ? "dim" : "success", mark)} `;
		const gutter = visibleWidth(prefix);
		// The stable id stays visible, including on a struck completed row.
		// Numbering is not implied by order, so the id is not optional chrome.
		const lines = this.hanging(prefix, `${item.id} ${item.title}`, inner, line =>
			item.done
				? `${STRIKE_ON}${this.paint("dim", line)}${STRIKE_OFF}`
				: this.paint("text", line),
		);

		// Completed descriptions stay in full. They are dimmed, not struck
		// through, and blank paragraphs are real rows.
		if (item.description.length > 0) {
			lines.push(...this.indented(
				gutter,
				item.description,
				inner,
				line => this.paint(item.done ? "dim" : "muted", line),
			));
		}

		// The full dependency list stays visible after a prerequisite is done.
		// blockedBy is only the ones that are still open.
		if (item.dependsOn.length > 0) {
			lines.push(...this.indented(
				gutter,
				t("list.dependencies", { ids: item.dependsOn.join(", ") }),
				inner,
				line => this.paint("dim", line),
			));
		}
		const waiting = blockedBy(state, item, completion);
		if (waiting.length > 0) {
			lines.push(...this.indented(
				gutter,
				t("list.waiting", { ids: waiting.join(", ") }),
				inner,
				line => this.paint("warning", line),
			));
		}
		return lines;
	}

	private hanging(
		prefix: string,
		text: string,
		inner: number,
		paint: (line: string) => string,
	): string[] {
		if (inner <= 0) return [];
		const gutter = visibleWidth(prefix);
		if (gutter >= inner) return [truncateToWidth(prefix, inner, "")];
		const wrapped = wrapColumns(text, inner - gutter);
		const content = wrapped.length > 0 ? wrapped : [""];
		const hang = " ".repeat(gutter);
		return content.map((line, index) => (index === 0 ? prefix : hang) + paint(line));
	}

	private indented(
		gutter: number,
		text: string,
		inner: number,
		paint: (line: string) => string,
	): string[] {
		if (inner <= 0 || gutter >= inner) return [];
		const hang = " ".repeat(gutter);
		return wrapColumns(text, inner - gutter).map(line => hang + paint(line));
	}

	private top(state: ListState | undefined, width: number): string {
		const items = state?.items ?? [];
		const done = items.filter(item => item.done).length;
		const progress = t("list.progress", { done, total: items.length });
		const label = ` ${this.paint("accent", "list")} ${this.paint("text", progress)} `;
		return this.rule("╭", "╮", label, width);
	}

	private bottom(total: number, viewport: number, width: number): string {
		const overflow = viewport > 0 && total > viewport;
		const label = overflow
			? ` ${this.paint("dim", t("list.scroll", {
				start: this.scrollOffset + 1,
				end: this.scrollOffset + viewport,
				total,
			}))} `
			: "";
		return this.rule("╰", "╯", label, width);
	}

	private rule(left: string, right: string, label: string, width: number): string {
		if (width <= 0) return "";
		if (width === 1) return this.paint("border", right);
		const inner = width - 2;
		const text = truncateToWidth(label, inner, "");
		const fill = "─".repeat(Math.max(0, inner - visibleWidth(text)));
		return this.paint("border", left) + text + this.paint("border", fill + right);
	}

	private row(content: string, width: number): string {
		if (width <= 0) return "";
		if (width === 1) return this.paint("border", "│");
		const inner = width - 2;
		const text = truncateToWidth(content, inner, "");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
		return this.paint("border", "│") + text + pad + this.paint("border", "│");
	}

	// The right border is the last column even when the content was wider
	// than the allocated frame. A wide character is not allowed to stick out.
	private seal(line: string, width: number, right: string): string {
		if (width <= 0) return "";
		const measured = visibleWidth(line);
		if (measured === width) return line;
		if (measured < width) return line + " ".repeat(width - measured);
		const edge = this.paint("border", right);
		const room = Math.max(0, width - visibleWidth(edge));
		const kept = truncateToWidth(line, room, "");
		const pad = " ".repeat(Math.max(0, room - visibleWidth(kept)));
		return kept + pad + edge;
	}
}
