import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { setupUserBubble, setUserBubbleTheme } from "./patcher.ts";

/**
 * User Bubble extension:
 * Wraps user messages in full-width rounded borders instead of solid color blocks.
 */
export default function userBubble(pi: ExtensionAPI): void {
	if (!isPluginEnabled("user-bubble")) {
		return;
	}

	const dispose = setupUserBubble();

	pi.on("session_start", (_event, ctx) => {
		setUserBubbleTheme(ctx.ui.theme);
	});

	pi.on("session_shutdown", () => {
		dispose();
		setUserBubbleTheme(undefined);
	});
}
