/**
 * Rendering helpers for the subagent tool: streaming display items, usage
 * stats, and the collapsed/expanded tool renderers. Adapted from Pi's
 * official subagent example, narrowed to the single-instance case.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export interface DisplayItem {
	type: "text" | "toolCall" | "toolResult";
	text: string;
	isError?: boolean;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

const TRUNCATE_LENGTH = 160;
const COLLAPSED_ITEM_COUNT = 8;

export function truncate(text: string, maxLength = TRUNCATE_LENGTH): string {
	const firstLine = text.split("\n")[0] ?? "";
	if (firstLine.length <= maxLength) return firstLine;
	return `${firstLine.slice(0, maxLength)}...`;
}

/** Mimic built-in tool call rendering: `$ cmd`, `read path:1-10`, `grep /x/ in path`. */
export function formatToolCallItem(toolName: string, args: Record<string, unknown>): string {
	const pathArg = typeof args.path === "string" ? args.path : "";
	switch (toolName) {
		case "bash":
		case "powershell":
			return `$ ${truncate(String(args.command ?? ""), 100)}`;
		case "read": {
			const offset = Number(args.offset);
			const limit = Number(args.limit);
			const range = offset > 0 ? `:${offset}${limit > 0 ? `-${offset + limit - 1}` : ""}` : "";
			return `read ${pathArg}${range}`;
		}
		case "write":
		case "edit":
			return `${toolName} ${pathArg}`;
		case "grep":
			return `grep /${String(args.pattern ?? "")}/ ${pathArg || "."}`;
		case "find":
			return `find ${String(args.pattern ?? "")} in ${pathArg || "."}`;
		case "ls":
			return `ls ${pathArg || "."}`;
		default:
			return toolName;
	}
}

/** Sum usage across the assistant messages of an agent_end event. */
export function aggregateUsage(messages: unknown): UsageStats {
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	if (!Array.isArray(messages)) return usage;

	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		const u = record.usage as Record<string, unknown> | undefined;
		if (!u) continue;
		usage.turns++;
		usage.input += Number(u.input) || 0;
		usage.output += Number(u.output) || 0;
		usage.cacheRead += Number(u.cacheRead) || 0;
		usage.cacheWrite += Number(u.cacheWrite) || 0;
		const cost = u.cost as Record<string, unknown> | undefined;
		usage.cost += Number(cost?.total) || 0;
		usage.contextTokens =
			Number(u.totalTokens) ||
			usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return usage;
}

export function formatUsageStats(usage: UsageStats): string | null {
	if (usage.turns === 0) return null;
	const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
	const parts = [
		`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`,
		`↑${formatTokens(usage.input)}`,
		`↓${formatTokens(usage.output)}`,
	];
	if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

/** Extract the text of the last assistant message in an agent_end event. */
export function extractFinalText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		const text = content
			.filter((c): c is { type: string; text: string } =>
				Boolean(c && typeof c === "object" && (c as Record<string, unknown>).type === "text"))
			.map((c) => c.text)
			.join("\n");
		if (text.trim()) return text;
	}
	return "";
}

/**
 * The terminal assistant message's error, if the run ended on stopReason
 * "error". 0.85.x reports provider failures through agent_end (not by
 * rejecting the RPC prompt), and extractFinalText happily walks BACKWARD past
 * the empty error message to earlier prose — so without this check, a failed
 * tail turn would be delivered as a successful partial result.
 */
export function terminalStopError(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;
		if (message.stopReason === "error") {
			return typeof message.errorMessage === "string" && message.errorMessage.trim()
				? message.errorMessage
				: "provider error (the final turn ended with stopReason 'error')";
		}
		return undefined; // The LAST assistant message decides; earlier errors were retried.
	}
	return undefined;
}

interface Theme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

/** Render the tool call line shown while the subagent runs. */
export function renderSubagentCall(args: Record<string, unknown>, theme: Theme): Text {
	const target = typeof args.instance === "string" && args.instance
		? `instance ${args.instance}`
		: `agent ${String(args.agent ?? "?")}`;
	const header = `${theme.fg("accent", theme.bold("subagent"))} ${theme.fg("muted", target)}`;
	const task = typeof args.task === "string" ? args.task : "";
	const preview = task ? `\n${theme.fg("dim", truncate(task, 120))}` : "";
	return new Text(header + preview, 0, 0);
}

interface RenderDetails {
	instanceId: string;
	agent: string;
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: UsageStats;
	isError?: boolean;
	errorMessage?: string;
}

/**
 * Collapsed: status icon, instance id, last few streamed items, usage.
 * Expanded (Ctrl+O): full streamed items and the final output.
 */
export function renderSubagentResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details as RenderDetails | undefined;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text ?? "" : "(no output)", 0, 0);
	}

	const status = details.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const usageStr = formatUsageStats(details.usage);
	const header = `${status} ${theme.bold(details.instanceId)} ${theme.fg("muted", `(${details.agent})`)}${usageStr ? ` ${theme.fg("dim", usageStr)}` : ""}`;

	if (!options.expanded) {
		const items = details.displayItems.slice(-COLLAPSED_ITEM_COUNT);
		const lines = items.map((item) => {
			if (item.type === "toolCall") return theme.fg("toolTitle", `  ${item.text}`);
			if (item.type === "toolResult" && item.isError) return theme.fg("error", `  ⎿ ${truncate(item.text, 100)}`);
			return theme.fg("muted", `  ${truncate(item.text, 120)}`);
		});
		const body = lines.length > 0 ? `\n${lines.join("\n")}` : "";
		const error = details.isError && details.errorMessage ? `\n${theme.fg("error", truncate(details.errorMessage, 200))}` : "";
		return new Text(`${header}${body}${error}\n${theme.fg("muted", "(Ctrl+O to expand)")}`, 0, 0);
	}

	const lines = details.displayItems.map((item) => {
		if (item.type === "toolCall") return theme.fg("toolTitle", `  ${item.text}`);
		if (item.type === "toolResult" && item.isError) return theme.fg("error", `  ⎿ ${item.text}`);
		return theme.fg("muted", `  ${item.text}`);
	});
	const output = details.finalOutput || (result.content[0]?.type === "text" ? result.content[0].text ?? "" : "");
	return new Text(`${header}\n${lines.join("\n")}\n\n${output}`, 0, 0);
}

/**
 * Streaming view used via onUpdate while the subagent is mid-run: a simple
 * Text with the latest items. (Kept separate so the collapsed result view can
 * stay compact after completion.)
 */
export function renderStreamingItems(theme: Theme, header: string, items: DisplayItem[]): Text {
	const tail = items.slice(-COLLAPSED_ITEM_COUNT);
	const lines = tail.map((item) => {
		if (item.type === "toolCall") return theme.fg("toolTitle", `  ${item.text}`);
		return theme.fg("muted", `  ${truncate(item.text, 120)}`);
	});
	return new Text(`${theme.fg("accent", "⏳")} ${header}\n${lines.join("\n")}`, 0, 0);
}
