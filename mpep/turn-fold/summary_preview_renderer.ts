import { t } from "../shared/i18n/index.ts";
import { homedir } from "node:os";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivePreview, ToolRecord, TurnState } from "./extension_types.ts";

export type DisplayTheme = Pick<Theme, "fg" | "bold" | "italic">;
let latestTheme: DisplayTheme = { fg: (_key, text) => text, bold: (text) => text, italic: (text) => text };

export function setLatestTheme(theme: DisplayTheme): void {
	latestTheme = theme;
}
export function getLatestTheme(): DisplayTheme {
	return latestTheme;
}
export function safeThemeFg(key: ThemeColor, text: string): string {
	return latestTheme.fg(key, text);
}
export function safeThemeBold(text: string): string {
	return latestTheme.bold(text);
}

export function shortenPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)
		? `~${path.slice(home.length)}`
		: path;
}

export function sanitizeCommand(cmd: string): string {
	return (cmd || "...").replace(/[\r\n]+/g, " ").trim();
}

export function toolLabel(name: string): string {
	return /^mcp(?:$|[_.:/])/.test(name) ? "mcp" : name;
}

export function toolHeader(tool: ToolRecord): string {
	const args = tool.args;
	const detail =
		typeof args.command === "string"
			? sanitizeCommand(args.command)
			: typeof args.path === "string"
				? shortenPath(args.path)
				: typeof args.pattern === "string"
					? args.pattern
					: "";
	return `${tool.name}${detail ? ` ${detail}` : ""}`;
}

export const PREVIEW_FIXED_LINES = 5;

export function formatPreview(preview: ActivePreview, theme: DisplayTheme, width: number): string[] {
	const fit = (text: string) => truncateToWidth(text.replace(/[\r\n\t]/g, " "), Math.max(1, width), "...");
	const lines = [fit(`  ↳ ${preview.header}`)];
	const output = preview.output
		.split("\n")
		.filter((line) => line.trim())
		.slice(-(PREVIEW_FIXED_LINES - 1));
	for (const line of output) {
		const text = theme.fg(
			preview.isError ? "error" : preview.type === "thinking" ? "thinkingText" : "toolOutput",
			fit(`  ${line}`),
		);
		lines.push(preview.type === "thinking" ? theme.italic(text) : text);
	}
	while (lines.length < PREVIEW_FIXED_LINES) lines.push("");
	return lines;
}

export function getActivePreview(group: TurnState): ActivePreview | undefined {
	if (group.sealed || group.expanded) return;
	// Folded custom notes and notifications carry no stream of their own; preview the latest real work.
	for (let i = group.activities.length - 1; i >= 0; i--) {
		const latest = group.activities[i];
		if (latest.type === "custom" || latest.type === "customEntry" || latest.type === "notification") continue;
		if (latest.type === "thinking")
			return { type: "thinking", header: t("activity.thinking"), output: latest.output, isError: false };
		const tool = group.tools.get(latest.toolCallId);
		if (tool) return { type: "tool", header: toolHeader(tool), output: tool.output, isError: tool.isError };
		return undefined;
	}
}

interface SummaryContent {
	icon: string;
	parts: string[];
}

function buildSummaryContent(group: TurnState, theme: DisplayTheme): SummaryContent {
	const stats = new Map<string, { successes: number; errors: number }>();
	for (const tool of group.tools.values()) {
		const name = toolLabel(tool.name);
		const stat = stats.get(name) ?? { successes: 0, errors: 0 };
		if (!tool.isPartial) {
			if (tool.isError) stat.errors++;
			else stat.successes++;
		}
		stats.set(name, stat);
	}
	const parts: string[] = [];
	const thinkingCount = group.activities.filter((activity) => activity.type === "thinking").length;
	if (thinkingCount) parts.push(`${theme.bold(t("activity.thinking"))} ${theme.fg("accent", String(thinkingCount))}`);
	// Notifications fold under the same umbrella as extension custom notes.
	const customCount = group.activities.filter(
		(activity) => activity.type === "custom" || activity.type === "notification",
	).length;
	// Archival entries without a renderer stay invisible, so only view-bound ones count.
	const entryCount = group.activities.filter((activity) => activity.type === "customEntry" && activity.view).length;
	if (customCount + entryCount)
		parts.push(`${theme.bold(t("activity.custom"))} ${theme.fg("accent", String(customCount + entryCount))}`);
	for (const [name, stat] of stats) {
		parts.push(
			`${theme.bold(name)} ${theme.fg("accent", String(stat.successes))}${stat.errors ? theme.fg("error", ` ${stat.errors}`) : ""}`,
		);
	}
	const lastWork = group.activities.findLast(
		(activity) => activity.type !== "custom" && activity.type !== "customEntry" && activity.type !== "notification",
	);
	const running =
		[...group.tools.values()].some((tool) => tool.isPartial) || (!group.sealed && lastWork?.type === "thinking");
	const failed = [...group.tools.values()].some((tool) => tool.isError);
	const icon = running ? theme.fg("warning", "⋯ ") : failed ? theme.fg("error", "! ") : theme.fg("success", "✓ ");
	return { icon, parts };
}

export function renderSummary(group: TurnState, theme: DisplayTheme): string {
	const summary = buildSummaryContent(group, theme);
	return summary.icon + summary.parts.join(theme.fg("muted", " • ")) + theme.fg("muted", t("activity.expandHint"));
}

/**
 * Wrap at whole summary-item boundaries so a tool name and its counts never split.
 * Continuation lines align with the first character after the status icon.
 */
export function renderSummaryLines(group: TurnState, theme: DisplayTheme, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const summary = buildSummaryContent(group, theme);
	const iconWidth = visibleWidth(summary.icon);
	const continuationIndent = " ".repeat(Math.min(iconWidth, Math.max(0, maxWidth - 1)));
	const lines: string[] = [];
	let line = truncateToWidth(summary.icon, maxWidth, "");
	let lineWidth = visibleWidth(line);
	let hasContent = false;

	const startNewLine = () => {
		lines.push(line);
		line = continuationIndent;
		lineWidth = visibleWidth(line);
		hasContent = false;
	};
	const appendSegment = (inlineSegment: string, lineStartSegment: string, separator = "") => {
		if (!hasContent) {
			const availableWidth = Math.max(1, maxWidth - lineWidth);
			const fitted = truncateToWidth(lineStartSegment, availableWidth, "...");
			line += fitted;
			lineWidth += visibleWidth(fitted);
			hasContent = true;
			return;
		}
		const candidate = separator + inlineSegment;
		if (lineWidth + visibleWidth(candidate) > maxWidth) {
			startNewLine();
			appendSegment(lineStartSegment, lineStartSegment);
			return;
		}
		line += candidate;
		lineWidth += visibleWidth(candidate);
	};

	for (const part of summary.parts) appendSegment(part, part, theme.fg("muted", " • "));
	const hintText = t("activity.expandHint");
	appendSegment(theme.fg("muted", hintText), theme.fg("muted", hintText.trimStart()));
	lines.push(line);
	return lines;
}
