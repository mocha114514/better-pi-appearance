// Central terminal-style scrollable modal for browsing captured stderr logs.

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { stderrBuffer } from "./buffer.ts";

export interface StderrModalOptions {
	tui: TUI;
	onClose: () => void;
}

export class StderrModalComponent implements Component {
	private readonly tui: TUI;
	private readonly onClose: () => void;
	private handle?: OverlayHandle;
	private scrollOffset = 0;
	private viewportHeight = 20;
	private viewportWidth = 80;
	private isDisposed = false;
	private unsubscribeBuffer?: () => void;

	constructor(options: StderrModalOptions) {
		this.tui = options.tui;
		this.onClose = options.onClose;

		// Initial scroll position: tail by default (show latest logs)
		this.scrollToBottom();

		// Update if new logs arrive while modal is open
		this.unsubscribeBuffer = stderrBuffer.subscribe(() => {
			this.scrollToBottom();
			this.tui.requestRender();
		});
	}

	setHandle(handle: OverlayHandle): void {
		this.handle = handle;
	}

	private scrollToBottom(): void {
		const count = stderrBuffer.getCount();
		this.scrollOffset = Math.max(0, count - this.viewportHeight);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.isDisposed) return [];

		const entries = stderrBuffer.getEntries();
		const terminalRows = this.tui.terminal.rows || 30;
		const terminalCols = this.tui.terminal.columns || 100;

		// Modal dimensions: 85% of terminal width and 80% of terminal height
		const modalWidth = Math.max(40, Math.min(130, Math.floor(terminalCols * 0.85)));
		const modalHeight = Math.max(12, Math.min(45, Math.floor(terminalRows * 0.80)));
		this.viewportWidth = modalWidth - 4; // 2 cols border, 2 cols padding
		this.viewportHeight = modalHeight - 4; // Top border/header, bottom border/footer

		const maxOffset = Math.max(0, entries.length - this.viewportHeight);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));

		const lines: string[] = [];

		// Colors
		const borderStyle = "\x1b[38;5;244m"; // Muted gray
		const titleStyle = "\x1b[1;38;5;214m"; // Amber bold
		const metaStyle = "\x1b[38;5;246m"; // Gray
		const hotkeyStyle = "\x1b[1;37m"; // Bold white
		const timeStyle = "\x1b[38;5;242m"; // Dim timestamp
		const reset = "\x1b[0m";

		// 1. Top Border with Title & Close Action
		const titleText = ` 📟 Captured stderr Logs (${entries.length} lines) `;
		const actionsText = ` [c] Copy  [x] Clear  [Esc/q] Close `;
		const topContentWidth = visibleWidth(titleText) + visibleWidth(actionsText);
		const topFillerWidth = Math.max(0, modalWidth - 2 - topContentWidth);
		const topBorder = `${borderStyle}╭${reset}${titleStyle}${titleText}${reset}${borderStyle}${"─".repeat(topFillerWidth)}${reset}${metaStyle}${actionsText}${reset}${borderStyle}╮${reset}`;
		lines.push(topBorder);

		// 2. Subtitle / Column header
		const subHeader = `${borderStyle}│${reset} ${metaStyle}${"TIME".padEnd(9)} ${"LOG CONTENT".padEnd(this.viewportWidth - 10)}${reset} ${borderStyle}│${reset}`;
		lines.push(truncateToWidth(subHeader, modalWidth, `${borderStyle}│${reset}`));

		// 3. Log Lines Viewport
		const visibleSlice = entries.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);

		for (let i = 0; i < this.viewportHeight; i++) {
			const entry = visibleSlice[i];
			let lineContent = "";

			if (entry) {
				const timePart = `${timeStyle}${entry.timeStr}${reset} `;
				const availableLogWidth = Math.max(10, this.viewportWidth - 10);
				const logPart = truncateToWidth(entry.raw, availableLogWidth, "…");
				lineContent = `${timePart}${logPart}`;
			} else if (entries.length === 0 && i === 2) {
				lineContent = `${metaStyle}  (No stderr output captured yet. System is clean.)${reset}`;
			}

			// Scrollbar indicator calculation
			let scrollbarChar = " ";
			if (entries.length > this.viewportHeight) {
				const thumbStart = Math.floor((this.scrollOffset / entries.length) * this.viewportHeight);
				const thumbHeight = Math.max(1, Math.floor((this.viewportHeight / entries.length) * this.viewportHeight));
				if (i >= thumbStart && i < thumbStart + thumbHeight) {
					scrollbarChar = `${metaStyle}█${reset}`;
				} else {
					scrollbarChar = `${borderStyle}│${reset}`;
				}
			}

			const paddedLine = ` ${truncateToWidth(lineContent, this.viewportWidth, "")} `;
			// Ensure strict column alignment
			const currentVisWidth = visibleWidth(paddedLine);
			const filler = currentVisWidth < modalWidth - 3 ? " ".repeat(modalWidth - 3 - currentVisWidth) : "";
			const row = `${borderStyle}│${reset}${paddedLine}${filler}${scrollbarChar}${borderStyle}│${reset}`;
			lines.push(row);
		}

		// 4. Bottom Footer with Navigation instructions
		const footerLeft = ` ↑/↓: Scroll • PgUp/PgDn: Page • c: Copy • Esc/q: Close `;
		const scrollPercent = entries.length > 0 ? Math.round(((this.scrollOffset + Math.min(entries.length, this.viewportHeight)) / entries.length) * 100) : 100;
		const footerRight = ` [${scrollPercent}%] `;
		const bottomFiller = Math.max(0, modalWidth - 2 - visibleWidth(footerLeft) - visibleWidth(footerRight));
		const bottomBorder = `${borderStyle}╰${reset}${metaStyle}${footerLeft}${reset}${borderStyle}${"─".repeat(bottomFiller)}${reset}${titleStyle}${footerRight}${reset}${borderStyle}╯${reset}`;
		lines.push(bottomBorder);

		return lines;
	}

	handleInput(data: string): boolean {
		if (this.isDisposed) return false;

		// Close triggers
		if (
			matchesKey(data, "escape") ||
			data === "q" ||
			data === "Q" ||
			matchesKey(data, "enter")
		) {
			this.dispose();
			return true;
		}

		// Copy All trigger
		if (data === "c" || data === "C") {
			const text = stderrBuffer.toPlainText();
			if (text) {
				void copyToClipboard(text);
				(this.tui as unknown as { flash?: (msg: string) => void })?.flash?.("Copied!");
			}
			return true;
		}

		// Clear logs trigger
		if (data === "x" || data === "X") {
			stderrBuffer.clear();
			this.scrollOffset = 0;
			this.tui.requestRender();
			return true;
		}

		const entries = stderrBuffer.getEntries();
		const maxOffset = Math.max(0, entries.length - this.viewportHeight);

		// Up
		if (matchesKey(data, "up") || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return true;
		}

		// Down
		if (matchesKey(data, "down") || data === "j") {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
			this.tui.requestRender();
			return true;
		}

		// Page Up
		if (matchesKey(data, "pageUp") || data === "\x1b[5~") {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight);
			this.tui.requestRender();
			return true;
		}

		// Page Down
		if (matchesKey(data, "pageDown") || data === "\x1b[6~") {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + this.viewportHeight);
			this.tui.requestRender();
			return true;
		}

		// Home
		if (matchesKey(data, "home") || data === "\x1b[H" || data === "\x1b[1~") {
			this.scrollOffset = 0;
			this.tui.requestRender();
			return true;
		}

		// End
		if (matchesKey(data, "end") || data === "\x1b[F" || data === "\x1b[4~") {
			this.scrollOffset = maxOffset;
			this.tui.requestRender();
			return true;
		}

		// Consume other input while modal is active to prevent leaking to editor
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		if (this.isDisposed) return { handled: false };

		const entries = stderrBuffer.getEntries();
		const maxOffset = Math.max(0, entries.length - this.viewportHeight);

		// Mouse wheel scrolling
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta !== 0) {
				this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
				this.tui.requestRender();
				return { handled: true };
			}
		}

		// Click inside or close button
		if (event.type === "click" || (event.type === "release" && event.button === "left")) {
			// If clicking on top right [Esc/q] Close area, dismiss
			if (event.y === 0 && event.x >= this.viewportWidth - 10) {
				this.dispose();
				return { handled: true };
			}
			return { handled: true };
		}

		return { handled: true };
	}

	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		if (this.unsubscribeBuffer) {
			this.unsubscribeBuffer();
			this.unsubscribeBuffer = undefined;
		}
		this.handle?.hide();
		this.handle = undefined;
		this.onClose();
		this.tui.requestRender();
	}
}

/**
 * Helper to show the central stderr Log Viewer modal.
 */
let activeModal: StderrModalComponent | undefined;

export function showStderrModal(tui: TUI): void {
	if (activeModal) return;

	const modal = new StderrModalComponent({
		tui,
		onClose: () => {
			activeModal = undefined;
		},
	});

	const handle = tui.showOverlay(modal, {
		anchor: "center",
	});
	modal.setHandle(handle);
	activeModal = modal;
}

export function isStderrModalActive(): boolean {
	return activeModal !== undefined;
}
