import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";
import { notifyTurnComplete } from "./notify.ts";
import { ensureBubbleSound } from "./sound.ts";

const PLUGIN_ID = "turn-notify";

/**
 * Agent lifecycle handler pair, with the notifier injected for testability.
 * The elapsed time is measured from the first agent_start and reported only
 * when Pi has no retry, compaction retry, or queued follow-up left to run.
 */
export function createTurnNotify(notify: (title: string, body: string, soundPath?: string) => void): { agentStart: () => void; agentSettled: () => void } {
	let startMs: number | null = null;
	return {
		agentStart() {
			// Retries can emit another agent_start before agent_settled. Keep the original clock.
			if (startMs === null) startMs = Date.now();
		},
		agentSettled() {
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
 * Pops up a native system notification with a sound after the full agent run
 * settles. agent_end can fire before automatic retries or compaction retries,
 * so it must not trigger the completion notification.
 */
export default function turnNotify(pi: ExtensionAPI): void {
	if (!isPluginEnabled(PLUGIN_ID)) return;
	const handler = createTurnNotify(notifyTurnComplete);
	pi.on("agent_start", handler.agentStart);
	pi.on("agent_settled", handler.agentSettled);
}
