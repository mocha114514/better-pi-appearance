// /m-export — write the current session branch as a self-contained interactive HTML page
// that keeps the terminal's disclosure style: one-line runs, expandable details, and the
// pre-compaction history on the same timeline.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { getLocale, t } from "../shared/i18n/index.ts";
import { readHighlightLibrary, readMarkdownLibrary } from "./assets.ts";
import { collectSession } from "./collect.ts";
import { openInBrowser } from "./open.ts";
import { readPalette } from "./palette.ts";
import { renderExport, type ExportLabels } from "./render.ts";

const COMMAND = "m-export";

interface CommandOptions {
	path?: string;
	open: boolean;
}

/** `/m-export [path] [--no-open]`: first bare argument wins as the output path. */
function parseArguments(input: string): CommandOptions {
	const options: CommandOptions = { open: true };
	for (const token of input.trim().split(/\s+/).filter(Boolean)) {
		if (token === "--no-open") options.open = false;
		else if (!options.path) options.path = token;
	}
	return options;
}

function defaultOutputPath(cwd: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return join(cwd, `mpep-session-${stamp}.html`);
}

/** Page labels. Terminal wording is reused so HTML and TUI read the same. */
function pageLabels(): ExportLabels {
	return {
		toc: t("export.toc"),
		expandAll: t("export.expandAll"),
		collapseAll: t("export.collapseAll"),
		search: t("export.search"),
		matches: t("export.matches", { count: "{count}" }),
		noMatches: t("export.noMatches"),
		kbd: t("export.kbd"),
		cookingProcess: t("activity.cookingProcess"),
		keptTag: t("activity.retainedTail"),
		compaction: t("activity.compaction"),
		tokens: t("activity.tokens", { count: "{count}" }),
		thinking: t("activity.thinking"),
		user: t("export.user"),
		args: t("export.args"),
		output: t("export.output"),
		pending: t("export.pending"),
		empty: t("export.empty"),
		branchSummary: t("export.branchSummary"),
		custom: t("export.custom"),
		expandHint: t("export.expandHint"),
		collapseHint: t("export.collapseHint"),
		copy: t("export.copy"),
		copied: t("export.copied"),
		stats: t("export.stats", { messages: "{messages}", tools: "{tools}", tokens: "{tokens}", cost: "{cost}" }),
	};
}

export default function exportExtension(pi: ExtensionAPI): void {
	if (!isPluginEnabled("export")) return;
	pi.registerCommand(COMMAND, {
		description: t("export.description"),
		handler: async (args, ctx) => {
			try {
				const entries = ctx.sessionManager.getBranch();
				if (entries.length === 0) {
					ctx.ui.notify(t("export.emptySession"), "warning");
					return;
				}
				const options = parseArguments(args);
				const cwd = ctx.sessionManager.getCwd();
				const target = options.path ? resolve(cwd, options.path) : defaultOutputPath(cwd);
				const html = renderExport({
					model: collectSession(entries),
					labels: pageLabels(),
					title: t("export.pageTitle", { name: ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId() }),
					lang: getLocale(),
					palette: readPalette(ctx.ui.theme?.sourcePath),
					markdownLib: readMarkdownLibrary(),
					highlightLib: readHighlightLibrary(),
				});
				// Parent directories are created so `--path out/session.html` works on a fresh directory.
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, html, "utf8");
				ctx.ui.notify(t("export.done", { path: target }), "info");
				if (options.open && !openInBrowser(target)) {
					ctx.ui.notify(t("export.openFailed", { path: target }), "warning");
				}
			} catch (error) {
				ctx.ui.notify(t("export.failed", { error: error instanceof Error ? error.message : String(error) }), "error");
			}
		},
	});
}
