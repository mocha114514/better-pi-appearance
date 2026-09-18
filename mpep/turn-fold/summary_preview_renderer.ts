import { t } from "../shared/i18n/index.ts";
import { homedir } from "node:os";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
	// Folded custom notes carry no stream of their own; preview the latest real work.
	for (let i = group.activities.length - 1; i >= 0; i--) {
		const latest = group.activities[i];
		if (latest.type === "custom" || latest.type === "customEntry") continue;
		if (latest.type === "thinking")
			return { type: "thinking", header: t("activity.thinking"), output: latest.output, isError: false };
		const tool = group.tools.get(latest.toolCallId);
		if (tool) return { type: "tool", header: toolHeader(tool), output: tool.output, isError: tool.isError };
		return undefined;
	}
}

export function renderSummary(group: TurnState, theme: DisplayTheme): string {
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
	const customCount = group.activities.filter((activity) => activity.type === "custom").length;
	// Archival entries without a renderer stay invisible, so only view-bound ones count.
	const entryCount = group.activities.filter((activity) => activity.type === "customEntry" && activity.view).length;
	if (customCount + entryCount)
		parts.push(`${theme.bold(t("activity.custom"))} ${theme.fg("accent", String(customCount + entryCount))}`);
	for (const [name, stat] of stats) {
		parts.push(
			`${theme.bold(name)} ${theme.fg("accent", String(stat.successes))}${stat.errors ? theme.fg("error", ` ${stat.errors}`) : ""}`,
		);
	}
	const lastWork = group.activities.findLast((activity) => activity.type !== "custom" && activity.type !== "customEntry");
	const running =
		[...group.tools.values()].some((tool) => tool.isPartial) || (!group.sealed && lastWork?.type === "thinking");
	const failed = [...group.tools.values()].some((tool) => tool.isError);
	const icon = running ? theme.fg("warning", "⋯ ") : failed ? theme.fg("error", "! ") : theme.fg("success", "✓ ");
	return icon + parts.join(theme.fg("muted", " • ")) + theme.fg("muted", t("activity.expandHint"));
}
