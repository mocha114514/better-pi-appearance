import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { installSelectionCopy } from "../shared/selection-copy.ts";
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
	// Own a selection-copy holder so the bubble markers are stripped before the
	// frame is written even when the markdown enhancer is disabled.
	const releaseSelection = installSelectionCopy();

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

		const firstChild = this.children?.[0] as { children?: unknown[] } | undefined;
		// Component tree differs across pi versions:
		//   pi < 1.0:  UserMessageComponent -> Box -> Markdown
		//   pi >= 1.0: UserMessageComponent -> Markdown
		// (upstream commit e792ba131 removed the Box wrapper; the Markdown
		// now paints its own background and padding instead).
		const markdownChild = (firstChild?.children?.[0] ?? firstChild) as
			| {
					paddingX?: number;
					paddingY?: number;
					defaultTextStyle?: { bgColor?: (text: string) => string };
					invalidate?: () => void;
				}
			| undefined;

		if (markdownChild) {
			// On pi >= 1.0 the Markdown fills a solid userMessageBg background
			// and adds output padding on its own. Strip both so the bubble keeps
			// its original transparent look; the border provides the framing.
			// These are no-ops on older versions (no bgColor, padding already 0).
			// The defaultTextStyle object is freshly created per rebuild, so
			// mutating it affects only this message instance.
			if (markdownChild.defaultTextStyle) {
				delete markdownChild.defaultTextStyle.bgColor;
			}
			markdownChild.paddingX = 0;
			markdownChild.paddingY = 0;
			markdownChild.invalidate?.();

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
		releaseSelection();
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
