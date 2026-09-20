// Top-right transient interactive toast notification for intercepted stderr logs.

import {
	type Component,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export interface StderrToastOptions {
	tui: TUI;
	onOpenModal: () => void;
	durationSec?: number;
}

export class StderrToastComponent implements Component {
	private readonly tui: TUI;
	private readonly onOpenModal: () => void;
	private readonly initialDurationSec: number;
	private remainingSec: number;
	private newCount: number;
	private timer?: NodeJS.Timeout;
	private handle?: OverlayHandle;
	private isHovered = false;
	private isDisposed = false;
	private lastRenderedWidth = 0;

	constructor(options: StderrToastOptions) {
		this.tui = options.tui;
		this.onOpenModal = options.onOpenModal;
		this.initialDurationSec = options.durationSec ?? 10;
		this.remainingSec = this.initialDurationSec;
		this.newCount = 0;
	}

	setHandle(handle: OverlayHandle): void {
		this.handle = handle;
	}

	/**
	 * Reset/extend the toast countdown and bump the counter when new logs arrive.
	 */
	bump(addedCount: number): void {
		if (this.isDisposed) return;
		this.newCount += addedCount;
		this.remainingSec = this.initialDurationSec;
		this.startTimer();
		this.tui.requestRender();
	}

	private startTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => {
			this.remainingSec--;
			if (this.remainingSec <= 0) {
				this.dispose();
			}
			this.tui.requestRender();
		}, 1000);
		this.timer.unref();
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.isDisposed || this.remainingSec <= 0) return [];

		// Styled notification label:
		// Hover: bright amber background + underlined text
		// Normal: inverted amber/yellow warning badge
		const countLabel = this.newCount > 1 ? ` (${this.newCount} logs)` : "";
		const rawText = ` ⚠ stderr${countLabel} (Click to view) [${this.remainingSec}s] `;

		let styled: string;
		if (this.isHovered) {
			styled = `\x1b[1;30;43;4m${rawText}\x1b[0m`;
		} else {
			styled = `\x1b[1;33;40m${rawText}\x1b[0m`;
		}

		const rendered = truncateToWidth(styled, Math.max(1, width), "");
		this.lastRenderedWidth = visibleWidth(rendered);
		return [rendered];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		if (this.isDisposed) return { handled: false };

		// Check if mouse is hovering over this component row (row 0 in relative overlay coordinates)
		if (event.y === 0 && event.x >= 0 && event.x < this.lastRenderedWidth) {
			if (event.type === "move" || event.type === "press") {
				if (!this.isHovered) {
					this.isHovered = true;
					this.tui.requestRender();
				}
			}

			if (event.type === "click" || (event.type === "release" && event.button === "left")) {
				// User clicked on the toast: open modal and dismiss toast
				this.dispose();
				this.onOpenModal();
				return { handled: true };
			}
			return { handled: true };
		}

		if (this.isHovered) {
			this.isHovered = false;
			this.tui.requestRender();
		}

		return { handled: false };
	}

	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.handle?.hide();
		this.handle = undefined;
		this.tui.requestRender();
	}
}

/**
 * Helper to show or update the active Stderr Toast overlay.
 */
let activeToast: StderrToastComponent | undefined;

export function showStderrToast(tui: TUI, onOpenModal: () => void, addedCount: number): void {
	if (activeToast) {
		activeToast.bump(addedCount);
		return;
	}

	const toast = new StderrToastComponent({
		tui,
		onOpenModal: () => {
			activeToast = undefined;
			onOpenModal();
		},
		durationSec: 10,
	});
	toast.bump(addedCount);

	const handle = tui.showOverlay(toast, {
		anchor: "top-right",
		margin: 1,
	});
	toast.setHandle(handle);
	activeToast = toast;
}

export function dismissStderrToast(): void {
	if (activeToast) {
		activeToast.dispose();
		activeToast = undefined;
	}
}
