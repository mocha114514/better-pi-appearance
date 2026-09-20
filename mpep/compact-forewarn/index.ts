import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";

/**
 * Compact Forewarn (/m-ask)
 *
 * Fires a forewarning before Pi's own auto-compaction kicks in. When the
 * estimated context usage crosses `contextWindow - reserveTokens - margin`
 * (margin defaults to 30000 tokens, adjustable via /m-ask), the next completed
 * tool execution arms the extension: a short "asking before compact..." entry
 * is shown to the user and a <system-reminder> message is steered into the
 * conversation, asking the model to finish its current atomic unit of work and
 * then call the gated `request_compaction` tool. The tool errors while disarmed
 * and re-locks as soon as Pi reports the compaction (manual, threshold, or
 * overflow).
 */

const COMMAND = "m-ask";
const TOOL_NAME = "request_compaction";
const ENTRY_TYPE = "compact-forewarn";
const DEFAULT_MARGIN_TOKENS = 30_000;
const DEFAULT_RESERVE_TOKENS = 16_384;

function getCompactionReserveTokens(cwd?: string): number {
	const paths = [
		join(getAgentDir(), "settings.json"),
		cwd ? join(cwd, ".pi", "settings.json") : null,
	].filter((p): p is string => Boolean(p));

	let reserveTokens = DEFAULT_RESERVE_TOKENS;
	for (const settingsPath of paths) {
		try {
			const content = readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
			const parsed = JSON.parse(content);
			const reserve = parsed?.compaction?.reserveTokens;
			if (typeof reserve === "number" && reserve >= 0) {
				reserveTokens = reserve;
			}
		} catch {
			// ignore missing or malformed settings files
		}
	}
	return reserveTokens;
}

/**
 * The reminder is always English: it is an instruction for the model, not UI
 * copy, so it stays out of the i18n tables on purpose.
 */
function buildReminder(marginTokens: number): string {
	return [
		"<system-reminder>",
		"This is an automated notice injected by the local environment (compact-forewarn extension), not a message from the user.",
		`A context compaction will trigger soon (approximately ${marginTokens.toLocaleString("en-US")} tokens remaining).`,
		"To keep a sudden compaction from splitting an atomic piece of work, please:",
		`1. If you see this notice while at a clean task boundary (an old task has ended, a new one is starting) or a milestone, call \`${TOOL_NAME}\` immediately before proceeding.`,
		"2. Take stock of the current situation and make a brief plan.",
		"3. Finish the locally coherent unit of work you are in the middle of, so nothing atomic gets cut in half.",
		`4. Before calling \`${TOOL_NAME}\`, state your completed progress and upcoming tasks in your response text, and pass upcoming tasks into the \`next_steps\` parameter of \`${TOOL_NAME}\`.`,
		`5. Proactively call \`${TOOL_NAME}\` to trigger compaction. Once compaction finishes, you will be automatically resumed to continue your remaining work seamlessly.`,
		`If you are not in the middle of anything that needs continuity, call \`${TOOL_NAME}\` right away.`,
		"</system-reminder>",
	].join("\n");
}

export default function compactForewarn(pi: ExtensionAPI): void {
	if (!isPluginEnabled("compact-forewarn")) return;

	// Session-scoped state machine: disarmed -> armed (forewarn sent) -> disarmed
	// (compaction observed). `pending` additionally tracks a compact() request
	// that has been issued but not yet settled, so repeat tool calls are no-ops
	// instead of stacking duplicate compactions.
	let armed = false;
	let pending = false;
	let marginTokens = DEFAULT_MARGIN_TOKENS;

	pi.registerCommand(COMMAND, {
		description: t("forewarn.description"),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.length === 0) {
				ctx.ui.notify(t("forewarn.current", { tokens: marginTokens.toLocaleString("en-US") }), "info");
				return;
			}
			const value = Number(trimmed);
			if (!Number.isInteger(value) || value <= 0) {
				ctx.ui.notify(t("forewarn.invalid"), "warning");
				return;
			}
			marginTokens = value;
			ctx.ui.notify(t("forewarn.set", { tokens: marginTokens.toLocaleString("en-US") }), "info");
		},
	});

	// User-visible marker. Custom entries never enter the LLM context; this is
	// display-only and folds away with the rest of the transcript.
	pi.registerEntryRenderer(ENTRY_TYPE, (_entry, _options, theme) => {
		return new Text(theme.fg("warning", `… ${t("forewarn.asking")}`), 0, 0);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Request Compaction",
		description:
			"Trigger context compaction. Only callable after the environment has issued a compaction forewarning " +
			"(<system-reminder> about the approaching context limit); calls made before that forewarning fail. " +
			"Compaction runs asynchronously and you will be automatically resumed once compaction finishes.",
		promptSnippet: "trigger context compaction once the forewarning asks you to wrap up",
		parameters: Type.Object({
			next_steps: Type.Optional(
				Type.String({
					description:
						"Brief summary of remaining tasks and upcoming plans to preserve into the compaction summary and resume afterwards.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!armed) {
				throw new Error(
					`${TOOL_NAME} is locked: no compaction forewarning has been issued yet. ` +
						"Only call it after the environment's <system-reminder> asks you to wrap up.",
				);
			}
			if (pending) {
				return {
					content: [{ type: "text", text: "Compaction was already requested and is still in progress. No action needed." }],
					details: {},
				};
			}
			pending = true;

			const nextSteps = (params as { next_steps?: string }).next_steps?.trim();
			const customInstructions = nextSteps
				? `Prioritize preserving the current progress and these remaining tasks: ${nextSteps}`
				: undefined;

			// compact() runs asynchronously; onComplete automatically resumes the agent
			// so the model seamlessly continues its remaining tasks after compaction.
			// onError re-arms the tool so the model may retry.
			ctx.compact({
				customInstructions,
				onComplete: () => {
					pending = false;
					pi.sendUserMessage(
						"[System Notice: Context compaction has completed successfully. " +
							"Please review your previous plan and resume your remaining work seamlessly.]",
						{ deliverAs: "followUp" },
					);
				},
				onError: () => {
					pending = false;
				},
			});
			return {
				content: [{
					type: "text",
					text: "Compaction has been triggered and is now running asynchronously. " +
						"Your context will be compacted and you will be automatically resumed to continue your work.",
				}],
				details: {},
			};
		},
	});

	pi.on("session_start", () => {
		armed = false;
		pending = false;
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (armed) return;
		const usage = ctx.getContextUsage();
		// tokens is null right after a compaction, before the next LLM response.
		if (!usage || usage.tokens === null) return;
		const reserveTokens = getCompactionReserveTokens(ctx.cwd);
		const threshold = usage.contextWindow - reserveTokens - marginTokens;
		if (threshold <= 0) return;
		if (usage.tokens <= threshold) return;

		armed = true;
		pi.appendEntry(ENTRY_TYPE, { tokens: usage.tokens, contextWindow: usage.contextWindow });
		pi.sendMessage(
			{
				customType: "compact-forewarn-reminder",
				content: buildReminder(marginTokens),
				display: false,
			},
			{ deliverAs: "steer" },
		);
	});

	// Any successful compaction (ours, /compact, threshold, or overflow) re-locks
	// the tool; a failed or aborted one only clears `pending` so the model may retry.
	pi.on("session_compact", () => {
		armed = false;
		pending = false;
	});
	pi.on("session_compact_failed", () => {
		pending = false;
	});
}
