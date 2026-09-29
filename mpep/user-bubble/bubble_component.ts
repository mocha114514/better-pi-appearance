import { type Component, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Bubble box container that wraps child components in a rounded border
 * without solid background filling, creating a clean, modern prompt bubble.
 */
export class UserBubbleBox implements Component {
	children: Component[] = [];
	private outputPad: number;
	private borderFn: (text: string) => string;

	constructor(outputPad = 1, borderFn?: (text: string) => string) {
		this.outputPad = outputPad;
		this.borderFn = borderFn ?? ((text: string) => text);
	}

	addChild(component: Component): void {
		this.children.push(component);
	}

	clear(): void {
		this.children = [];
	}

	setBorderFn(borderFn: (text: string) => string): void {
		this.borderFn = borderFn;
	}

	setOutputPad(pad: number): void {
		this.outputPad = pad;
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const padX = Math.max(0, this.outputPad);
		const effectivePad = event.width > 6 ? padX : 0;
		const boxWidth = Math.max(4, event.width - effectivePad * 2);
		const contentWidth = Math.max(1, boxWidth - 4);
		const contentX = event.x - effectivePad - 2;
		const contentY = event.y - 1;

		if (contentX < 0 || contentX >= contentWidth || contentY < 0) {
			return undefined;
		}

		let childY = 0;
		for (const child of this.children) {
			const childHeight = child.render(contentWidth).length;
			if (contentY >= childY && contentY < childY + childHeight) {
				return child.handleMouse?.({
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: childHeight,
				});
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		// When width is extremely narrow, fall back to child output without border decorations
		if (width < 6) {
			const fallbackLines: string[] = [];
			for (const child of this.children) {
				fallbackLines.push(...child.render(width));
			}
			return fallbackLines;
		}

		const padX = Math.max(0, this.outputPad);
		const effectivePad = width > 6 ? padX : 0;
		const boxWidth = Math.max(4, width - effectivePad * 2);
		const innerWidth = boxWidth - 2;
		const contentWidth = Math.max(1, boxWidth - 4);

		const childLines: string[] = [];
		for (const child of this.children) {
			childLines.push(...child.render(contentWidth));
		}

		if (childLines.length === 0) {
			childLines.push("");
		}

		const border = this.borderFn;
		const leftMargin = " ".repeat(effectivePad);
		const rightMargin = " ".repeat(Math.max(0, width - effectivePad - boxWidth));

		const topBorder = leftMargin + border(`╭${"─".repeat(innerWidth)}╮`) + rightMargin;
		const bottomBorder = leftMargin + border(`╰${"─".repeat(innerWidth)}╯`) + rightMargin;

		const result: string[] = [topBorder];
		for (const line of childLines) {
			const visLen = visibleWidth(line);
			const padNeeded = Math.max(0, contentWidth - visLen);
			const borderedLine =
				leftMargin +
				border("│ ") +
				line +
				" ".repeat(padNeeded) +
				border(" │") +
				rightMargin;
			result.push(borderedLine);
		}
		result.push(bottomBorder);

		return result;
	}
}
