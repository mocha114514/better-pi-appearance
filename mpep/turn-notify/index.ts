import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";
import { notifyTurnComplete } from "./notify.ts";
import { ensureBubbleSound } from "./sound.ts";

const PLUGIN_ID = "turn-notify";

/**
 * Agent lifecycle handler pair, with the notifier injected for testability.
 * The elapsed time is measured from agent_start, mirroring tps.ts.
 */
export function createTurnNotify(notify: (title: string, body: string, soundPath?: string) => void): { agentStart: () => void; agentEnd: () => void } {
	let startMs: number | null = null;
	return {
		agentStart() { startMs = Date.now(); },
		agentEnd() {
			const seconds = startMs === null ? null : (Date.now() - startMs) / 1000;
			startMs = null;
			const body = seconds === null
				? t("turnNotify.body")
				: t("turnNotify.bodyWithSeconds", { seconds: seconds.toFixed(1) });
			// Synthesized bubble chime from the cache; undefined falls back to system sounds.
			notify(t("turnNotify.title"), body, ensureBubbleSound());
		},
	};
}

/**
 * Pops up a native system notification with a sound after every agent reply
 * (agent_end). Fires regardless of UI focus, per design.
 */
export default function turnNotify(pi: ExtensionAPI): void {
	if (!isPluginEnabled(PLUGIN_ID)) return;
	const handler = createTurnNotify(notifyTurnComplete);
	pi.on("agent_start", handler.agentStart);
	pi.on("agent_end", handler.agentEnd);
}
