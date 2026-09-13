// HTML rendering for /m-export: blocks from collect.ts become a single self-contained page.
import { readFileSync } from "node:fs";
import { timestampText, type ExportBlock, type ExportItem, type ExportModel } from "./collect.ts";

/** Palette handed to the page: taken from the active Pi theme, with MPEP defaults as fallback. */
export interface ExportPalette {
	bg: string;
	card: string;
	fg: string;
	muted: string;
	dim: string;
	accent: string;
	title: string;
	heading: string;
	warn: string;
	err: string;
	ok: string;
	rule: string;
	hover: string;
	userBg: string;
	markBg: string;
	markFg: string;
}

export interface ExportLabels {
	[placeholder: string]: string;
}

export interface RenderInput {
	model: ExportModel;
	labels: ExportLabels;
	title: string;
	lang: string;
	palette: ExportPalette;
	/** Optional vendored browser libraries; the page degrades to escaped text without them. */
	markdownLib?: string;
	highlightLib?: string;
}

const templateDirectory = new URL("./template/", import.meta.url);

function readTemplate(name: string): string {
	return readFileSync(new URL(name, templateDirectory), "utf8");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Markdown source stays escaped in the DOM; page.js parses it in the browser. */
function markdown(text: string): string {
	return `<div class="md" data-md>${escapeHtml(text)}</div>`;
}

function code(text: string, className = ""): string {
	const suffix = className ? ` class="${className}"` : "";
	return `<pre${suffix}>${escapeHtml(text)}</pre>`;
}

function hintHtml(labels: ExportLabels): string {
	return `<span class="hint"><span class="hint-open">${escapeHtml(labels.expandHint)}</span><span class="hint-close">${escapeHtml(labels.collapseHint)}</span></span>`;
}

/** Fold head: caret + label + counts + optional tag, mirroring the terminal's one-line rows. */
function head(label: string, counts: string, labels: ExportLabels, tag = ""): string {
	const tagHtml = tag ? `<span class="tag">${escapeHtml(tag)}</span>` : "";
	return `<button class="head" type="button"><span class="caret"></span><span class="label">${escapeHtml(label)}</span><span class="counts">${escapeHtml(counts)}</span>${tagHtml}${hintHtml(labels)}</button>`;
}

function itemHtml(item: ExportItem, labels: ExportLabels): string {
	if (item.kind === "text") return markdown(item.text);
	if (item.kind === "thinking") {
		return `<div class="item thinking" data-fold="1" data-open="0"><button class="head" type="button"><span class="caret"></span><span class="label">${escapeHtml(labels.thinking)}</span><span class="counts"></span>${hintHtml(labels)}</button><div class="body">${markdown(item.text)}</div></div>`;
	}
	const flags = `data-error="${item.isError ? 1 : 0}" data-pending="${item.pending ? 1 : 0}"`;
	const outputLabel = item.pending ? labels.pending : labels.output;
	const output = item.pending ? "" : code(item.output || labels.empty, "out");
	return `<div class="item tool" data-fold="1" data-open="0" ${flags}><button class="head" type="button"><span class="caret"></span><span class="tool-name">${escapeHtml(item.name)}</span><span class="preview">${escapeHtml(item.preview)}</span>${hintHtml(labels)}</button><div class="body"><div class="label">${escapeHtml(labels.args)}</div>${code(item.args)}<div class="label">${escapeHtml(outputLabel)}</div>${output}</div></div>`;
}

function runCounts(block: Extract<ExportBlock, { kind: "run" }>, labels: ExportLabels): string {
	const parts = block.tools.map((tool) => `${tool.name} ${tool.count}`);
	if (block.thinking > 0) parts.push(`${labels.thinking} ${block.thinking}`);
	return parts.join(" \u00b7 ");
}

function runHtml(block: Extract<ExportBlock, { kind: "run" }>, labels: ExportLabels): string {
	const answer = block.answer.map((text) => markdown(text)).join("");
	const notice = block.notice ? `<div class="notice">${escapeHtml(block.notice)}</div>` : "";
	const tail = answer || notice ? `<div class="tail">${answer ? `<div class="rule"></div>` : ""}${answer}${notice}</div>` : "";
	if (!block.foldable) return `<section class="block run">${tail}</section>`;
	const items = block.items.map((item) => itemHtml(item, labels)).join("");
	const tag = block.kept ? labels.keptTag : "";
	return `<section class="block run" data-fold="1" data-open="0" data-kept="${block.kept ? 1 : 0}">${head(labels.cookingProcess, runCounts(block, labels), labels, tag)}<div class="body">${items}</div>${tail}</section>`;
}

function blockHtml(block: ExportBlock, labels: ExportLabels): string {
	switch (block.kind) {
		case "run":
			return runHtml(block, labels);
		case "user":
			return `<section class="block user" id="b-${block.id}" data-user="1"><div class="meta"><span class="who">${escapeHtml(labels.user)}</span><time>${escapeHtml(timestampText(block.timestamp))}</time></div>${markdown(block.text)}</section>`;
		case "compaction":
			return `<section class="block compaction" data-fold="1" data-open="0">${head(labels.compaction, labels.tokens.replace("{count}", block.tokensBefore.toLocaleString()), labels)}<div class="body">${markdown(block.summary)}</div></section>`;
		case "branchSummary":
			return `<section class="block summary" data-fold="1" data-open="0">${head(labels.branchSummary, timestampText(block.timestamp), labels)}<div class="body">${markdown(block.summary)}</div></section>`;
		case "custom":
			return `<section class="block custom" data-fold="1" data-open="0">${head(`${labels.custom} \u00b7 ${block.customType}`, timestampText(block.timestamp), labels)}<div class="body">${code(block.text)}</div></section>`;
	}
}

function compactNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function statsLine(model: ExportModel, labels: ExportLabels): string {
	const { stats } = model;
	const cost = stats.cost > 0 ? `$${stats.cost.toFixed(2)}` : "-";
	return labels.stats
		.replace("{messages}", String(stats.messages))
		.replace("{tools}", String(stats.tools))
		.replace("{tokens}", compactNumber(stats.tokens))
		.replace("{cost}", cost);
}

function tocHtml(blocks: readonly ExportBlock[], labels: ExportLabels): string {
	const items = blocks
		.filter((block): block is Extract<ExportBlock, { kind: "user" }> => block.kind === "user")
		.map((block, index) => {
			const firstLine = block.text.split("\n").find((line) => line.trim()) ?? "";
			const label = firstLine.length > 90 ? `${firstLine.slice(0, 90)}...` : firstLine;
			return `<li><a href="#b-${block.id}" data-target="b-${block.id}"><span class="i">${index + 1}</span><span class="t">${escapeHtml(label)}</span><span class="time">${escapeHtml(timestampText(block.timestamp))}</span></a></li>`;
		})
		.join("");
	return items || `<li><span class="t">${escapeHtml(labels.empty)}</span></li>`;
}

/**
 * Custom properties for the page. No trailing semicolon here on purpose: `page.css` terminates the
 * generated block, so the stylesheet stays correct even when an older renderer is still loaded in
 * the running Pi process (templates are re-read on every export, JS modules are not).
 */
function themeVars(palette: ExportPalette): string {
	return [
		`--bg:${palette.bg}`,
		`--card:${palette.card}`,
		`--fg:${palette.fg}`,
		`--muted:${palette.muted}`,
		`--dim:${palette.dim}`,
		`--accent:${palette.accent}`,
		`--title:${palette.title}`,
		`--heading:${palette.heading}`,
		`--warn:${palette.warn}`,
		`--err:${palette.err}`,
		`--ok:${palette.ok}`,
		`--rule:${palette.rule}`,
		`--hover:${palette.hover}`,
		`--user-bg:${palette.userBg}`,
		`--mark-bg:${palette.markBg}`,
		`--mark-fg:${palette.markFg}`,
	].join(";");
}

/** Inline a script payload without letting it terminate its own <script> element. */
function inlineScript(source: string): string {
	return source.replace(/<\/script/gi, "<\\/script");
}

/** Render the whole page. Every replacement uses a function so `$&` in assets stays literal. */
export function renderExport(input: RenderInput): string {
	const html = readTemplate("page.html");
	const css = readTemplate("page.css").replace("{{THEME_VARS}}", () => themeVars(input.palette));
	const js = readTemplate("page.js");
	const body = input.model.blocks.map((block) => blockHtml(block, input.labels)).join("\n");
	const replacements: Record<string, string> = {
		LANG: escapeHtml(input.lang),
		TITLE: escapeHtml(input.title),
		CSS: css,
		TOC_TITLE: escapeHtml(input.labels.toc),
		TOC: tocHtml(input.model.blocks, input.labels),
		EXPAND_ALL: escapeHtml(input.labels.expandAll),
		COLLAPSE_ALL: escapeHtml(input.labels.collapseAll),
		SEARCH: escapeHtml(input.labels.search),
		STATS: escapeHtml(statsLine(input.model, input.labels)),
		BODY: body,
		KBD: escapeHtml(input.labels.kbd),
		MD_LIB: inlineScript(input.markdownLib ?? ""),
		HLJS_LIB: inlineScript(input.highlightLib ?? ""),
		LABELS: JSON.stringify(input.labels).replace(/</g, "\\u003c"),
		JS: inlineScript(js),
	};
	return html.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => (key in replacements ? replacements[key] : match));
}
