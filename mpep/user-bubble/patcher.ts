import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { UserBubbleBox } from "./bubble_component.ts";

export type BubbleTheme = Pick<Theme, "fg">;

let activeTheme: BubbleTheme | undefined;

export function setUserBubbleTheme(theme: BubbleTheme | undefined): void {
	activeTheme = theme;
}

export function formatBorder(text: string): string {
	if (activeTheme?.fg) {
		try {
			return activeTheme.fg("accent", text);
		} catch {
			try {
				return activeTheme.fg("borderAccent", text);
			} catch {
				// Fallback to ANSI color when theme lookup fails
			}
		}
	}
	return `\x1b[36m${text}\x1b[39m`;
}

const patchSlot = Symbol.for("mpep.user-bubble.patches");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

/**
 * Installs user bubble patches onto UserMessageComponent.prototype.
 * Returns a dispose function to revert all changes cleanly.
 */
export function setupUserBubble(): () => void {
	patches[patchSlot]?.();

	const proto = UserMessageComponent.prototype as unknown as {
		rebuild: () => void;
		clear: () => void;
		addChild: (child: unknown) => void;
		children: unknown[];
		outputPad?: number;
	};

	const originalRebuild = proto.rebuild;

	proto.rebuild = function (this: typeof proto) {
		// Run original rebuild to ensure markdown transformers, styles,
		// and text content components are fully constructed.
		originalRebuild.call(this);

		const originalBox = this.children?.[0] as { children?: unknown[] } | undefined;
		const markdownChild = originalBox?.children?.[0];

		if (markdownChild) {
			this.clear();
			const bubbleBox = new UserBubbleBox(
				this.outputPad ?? 1,
				(text: string) => formatBorder(text),
			);
			bubbleBox.addChild(markdownChild as any);
			this.addChild(bubbleBox);
		}
	};

	const installedRebuild = proto.rebuild;

	const dispose = () => {
		if (proto.rebuild === installedRebuild) {
			proto.rebuild = originalRebuild;
		}
		if (patches[patchSlot] === dispose) {
			delete patches[patchSlot];
		}
	};

	patches[patchSlot] = dispose;
	return dispose;
}
