// Standalone Markdown rendering enhancer, originally part of stylized-design (renamed turn-fold).
// Self-contained: only depends on Pi's public extension API and pi-tui, so it
// can be toggled independently via the markdown-enhancer plugin entry.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const patchSlot = Symbol.for("mpep.markdown-enhancer.markdown-patches");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

/**
 * Bullet hierarchy for nested unordered lists.
 */
const UNORDERED_BULLETS = ["• ", "◦ ", "▪ "];

/**
 * Base left margin (indent) for the first level of lists.
 */
const BASE_INDENT = "  ";

/** Trailing file extension in the fence info string, e.g. `.ts` in `notes src/app.ts`. */
const FENCE_EXTENSION_RE = /\.([A-Za-z][A-Za-z0-9]*)$/;

/**
 * Language id handed to theme.highlightCode.
 *
 * Models often put a file path — sometimes after extra words — in the fence
 * info instead of a language. The last trailing ".ext" on the whole string is
 * used; a bare path segment such as a folder named "py" is left unchanged.
 * highlightCode itself drops unknown extensions (e.g. png) back to plaintext.
 */
export function resolveCodeBlockHighlightLang(raw: string | undefined): string | undefined {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return undefined;
	const extension = FENCE_EXTENSION_RE.exec(trimmed)?.[1];
	return extension ? extension.toLowerCase() : trimmed;
}

/**
 * Patch Markdown.prototype.renderToken at runtime to enhance code blocks
 * with stylish full rounded borders, skipping mermaid diagrams.
 */
function applyCodeBlockPatch(): () => void {
	const proto = Markdown.prototype as any;
	let active = true;

	const originalRenderToken = proto.renderToken;

	proto.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: any): string[] {
		if (active && token?.type === "code") {
			const lang = (token.lang || "").trim().split(/\s+/, 1)[0].toLowerCase();
			// Skip mermaid diagrams: Pi natively captures and renders them
			if (lang === "mermaid") {
				return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
			}

			try {
				if (width < 10) {
					return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
				}

				const lines: string[] = [];
				const border = (text: string) => (this.theme.codeBlockBorder ? this.theme.codeBlockBorder(text) : text);
				const innerWidth = Math.max(1, width - 4);
				const displayLang = token.lang?.trim() ? ` ${token.lang.trim()} ` : "";
				const langWidth = visibleWidth(displayLang);
				const minHeaderWidth = 3 + langWidth;

				let topHeader: string;
				if (langWidth > 0 && width >= minHeaderWidth) {
					const fill = width - minHeaderWidth;
					const styledLang = this.theme.bold ? border(this.theme.bold(displayLang)) : border(displayLang);
					topHeader = border("╭─") + styledLang + border("─".repeat(fill) + "╮");
				} else {
					topHeader = border("╭" + "─".repeat(Math.max(0, width - 2)) + "╮");
				}
				lines.push(topHeader);

				const rawText = token.text ?? "";
				const highlightLang = resolveCodeBlockHighlightLang(token.lang);
				const highlightedLines: string[] = this.theme.highlightCode
					? this.theme.highlightCode(rawText, highlightLang)
					: rawText
							.split("\n")
							.map((line: string) => (this.theme.codeBlock ? this.theme.codeBlock(line) : line));

				for (const hlLine of highlightedLines) {
					const wrapped = wrapTextWithAnsi(hlLine, innerWidth);
					if (wrapped.length === 0) {
						lines.push(border("│ ") + " ".repeat(innerWidth) + border(" │"));
					} else {
						for (const subLine of wrapped) {
							const padLen = Math.max(0, innerWidth - visibleWidth(subLine));
							lines.push(border("│ ") + subLine + " ".repeat(padLen) + border(" │"));
						}
					}
				}

				lines.push(border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯"));

				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}

				return lines;
			} catch {
				return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
			}
		}

		return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
	};
	const installed = proto.renderToken;
	return () => {
		active = false;
		if (proto.renderToken === installed) proto.renderToken = originalRenderToken;
	};
}

/**
 * Patch Markdown.prototype.renderList at runtime to enhance unordered lists
 * with typographic bullet icons (•, ◦, ▪), base indentation, and proper wrapping.
 */
function applyListPatch(): () => void {
	const proto = Markdown.prototype as any;
	let active = true;

	const originalRenderList = proto.renderList;

	proto.renderList = function (token: any, depth: number, width: number, styleContext?: any): string[] {
		if (!active) return originalRenderList.call(this, token, depth, width, styleContext);
		try {
			const lines: string[] = [];
			const indent = BASE_INDENT + "    ".repeat(depth);
			const startNumber = typeof token.start === "number" ? token.start : 1;

			for (let i = 0; i < token.items.length; i++) {
				const item = token.items[i];
				const isLastItem = i === token.items.length - 1;

				let bullet: string;
				if (token.ordered) {
					bullet = this.options?.preserveOrderedListMarkers
						? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
						: `${startNumber + i}. `;
				} else if (item.task) {
					bullet = "";
				} else {
					bullet = UNORDERED_BULLETS[Math.min(depth, UNORDERED_BULLETS.length - 1)];
				}

				const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
				const marker = bullet + taskMarker;
				const firstPrefix = indent + this.theme.listBullet(marker);
				const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
				const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
				let renderedAnyLine = false;

				for (const itemToken of item.tokens) {
					if (itemToken.type === "list") {
						lines.push(...this.renderList(itemToken, depth + 1, width, styleContext));
						renderedAnyLine = true;
						continue;
					}

					const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
					for (const line of itemLines) {
						for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
							const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
							lines.push(linePrefix + wrappedLine);
							renderedAnyLine = true;
						}
					}
				}

				if (!renderedAnyLine) {
					lines.push(firstPrefix);
				}

				if (token.loose && !isLastItem) {
					lines.push("");
				}
			}

			return lines;
		} catch {
			return originalRenderList.call(this, token, depth, width, styleContext);
		}
	};
	const installed = proto.renderList;
	return () => {
		active = false;
		if (proto.renderList === installed) proto.renderList = originalRenderList;
	};
}

/**
 * Patch Markdown.prototype to enhance bold rendering with visual emphasis,
 * ensuring bold text is clearly distinguishable in terminal environments
 * regardless of terminal font fallback or weight limitations.
 */
function applyBoldPatch(): () => void {
	const proto = Markdown.prototype as any;
	let active = true;
	const themes = new WeakMap<MarkdownTheme, { original: MarkdownTheme["bold"]; installed: MarkdownTheme["bold"] }>();
	const themeRefs = new Set<WeakRef<MarkdownTheme>>();
	const enhanceThemeBold = (theme: MarkdownTheme) => {
		if (active && theme && !themes.has(theme)) {
			const original = theme.bold;
			const origBold = original ? original.bind(theme) : (s: string) => `\x1b[1m${s}\x1b[22m`;
			const installed = (text: string) => {
				if (!active) return origBold(text);
				const styled = text.includes("\x1b[39m") ? text.replaceAll("\x1b[39m", "\x1b[39m\x1b[97m") : text;
				return origBold(`\x1b[97m${styled}\x1b[39m`);
			};
			themes.set(theme, { original, installed });
			// Retain rollback information without keeping discarded message themes alive.
			themeRefs.add(new WeakRef(theme));
			theme.bold = installed;
		}
	};

	const originalRender = proto.render;
	proto.render = function (width: number): string[] {
		enhanceThemeBold(this.theme);
		return originalRender.call(this, width);
	};

	const originalRenderToken = proto.renderToken;
	proto.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: any): string[] {
		enhanceThemeBold(this.theme);
		return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
	};
	const installedRender = proto.render;
	const installedRenderToken = proto.renderToken;
	return () => {
		active = false;
		if (proto.render === installedRender) proto.render = originalRender;
		if (proto.renderToken === installedRenderToken) proto.renderToken = originalRenderToken;
		for (const reference of themeRefs) {
			const theme = reference.deref();
			if (!theme) continue;
			const patch = themes.get(theme);
			if (patch && theme.bold === patch.installed) theme.bold = patch.original;
			themes.delete(theme);
		}
		themeRefs.clear();
	};
}

/**
 * Patch Markdown.prototype.renderTable at runtime to render tables as classic
 * "three-line" (booktabs-style) tables: a heavy top rule, a thin rule under
 * the header, a heavy bottom rule, no vertical lines, and a light theme-styled
 * separator between adjacent body rows. Each separator spans from the center
 * of the first column to the center of the last column, leaving breathing
 * room at both ends of the table.
 * Column width computation, cell wrapping and narrow-width fallbacks are kept
 * 1:1 with Pi's native table renderer (pi/packages/tui/src/components/markdown.ts
 * renderTable), so only the border output differs from the default style.
 */
export function applyTablePatch(): () => void {
	const proto = Markdown.prototype as any;
	let active = true;

	const originalRenderTable = proto.renderTable;

	proto.renderTable = function (token: any, availableWidth: number, nextTokenType?: string, styleContext?: any): string[] {
		if (!active) {
			return originalRenderTable.call(this, token, availableWidth, nextTokenType, styleContext);
		}
		try {
			const numCols = token.header.length;
			if (numCols === 0) {
				return originalRenderTable.call(this, token, availableWidth, nextTokenType, styleContext);
			}

			// Layout: " cellA  cellB " -> 2 edge padding chars + 2 gap chars per column gap.
			// (Native uses "│ " / " │ " borders = 3n + 1; three-line tables only need 2n + 2.)
			const borderOverhead = 2 * numCols + 2;
			const availableForCells = availableWidth - borderOverhead;
			if (availableForCells < numCols) {
				// Too narrow to render a stable table. Fall back to Pi's native renderer.
				return originalRenderTable.call(this, token, availableWidth, nextTokenType, styleContext);
			}

			const maxUnbrokenWordWidth = 30;

			// --- Column width computation, kept identical to Pi's native table renderer ---
			const naturalWidths: number[] = [];
			const minWordWidths: number[] = [];
			for (let i = 0; i < numCols; i++) {
				const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
				naturalWidths[i] = visibleWidth(headerText);
				minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
			}
			for (const row of token.rows) {
				for (let i = 0; i < row.length; i++) {
					const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
					naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
					minWordWidths[i] = Math.max(
						minWordWidths[i] || 1,
						this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
					);
				}
			}

			let minColumnWidths = minWordWidths;
			let minCellsWidth = minColumnWidths.reduce((a: number, b: number) => a + b, 0);

			if (minCellsWidth > availableForCells) {
				minColumnWidths = new Array(numCols).fill(1);
				const remaining = availableForCells - numCols;

				if (remaining > 0) {
					const totalWeight = minWordWidths.reduce((total: number, width: number) => total + Math.max(0, width - 1), 0);
					const growth = minWordWidths.map((width: number) => {
						const weight = Math.max(0, width - 1);
						return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
					});

					for (let i = 0; i < numCols; i++) {
						minColumnWidths[i] += growth[i] ?? 0;
					}

					const allocated = growth.reduce((total: number, width: number) => total + width, 0);
					let leftover = remaining - allocated;
					for (let i = 0; leftover > 0 && i < numCols; i++) {
						minColumnWidths[i]++;
						leftover--;
					}
				}

				minCellsWidth = minColumnWidths.reduce((a: number, b: number) => a + b, 0);
			}

			const totalNaturalWidth = naturalWidths.reduce((a: number, b: number) => a + b, 0) + borderOverhead;
			let columnWidths: number[];

			if (totalNaturalWidth <= availableWidth) {
				// Everything fits naturally
				columnWidths = naturalWidths.map((width: number, index: number) => Math.max(width, minColumnWidths[index]));
			} else {
				// Need to shrink columns to fit
				const totalGrowPotential = naturalWidths.reduce((total: number, width: number, index: number) => {
					return total + Math.max(0, width - minColumnWidths[index]);
				}, 0);
				const extraWidth = Math.max(0, availableForCells - minCellsWidth);
				columnWidths = minColumnWidths.map((minWidth: number, index: number) => {
					const naturalWidth = naturalWidths[index];
					const minWidthDelta = Math.max(0, naturalWidth - minWidth);
					let grow = 0;
					if (totalGrowPotential > 0) {
						grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
					}
					return minWidth + grow;
				});

				// Adjust for rounding errors - distribute remaining space
				const allocated = columnWidths.reduce((a: number, b: number) => a + b, 0);
				let remaining = availableForCells - allocated;
				while (remaining > 0) {
					let grew = false;
					for (let i = 0; i < numCols && remaining > 0; i++) {
						if (columnWidths[i] < naturalWidths[i]) {
							columnWidths[i]++;
							remaining--;
							grew = true;
						}
					}
					if (!grew) {
						break;
					}
				}
			}

			// --- Three-line border output ---
			const columnGap = "  ";
			const ruleWidth = borderOverhead + columnWidths.reduce((a: number, b: number) => a + b, 0);
			const heavyRule = "━".repeat(ruleWidth);
			const thinRule = "─".repeat(ruleWidth);

			// Inter-row separator: a light rule between adjacent body rows, spanning
			// from the center of the first column to the center of the last column so
			// both ends of the table keep breathing room. Styled via theme.hr to
			// follow the active theme.
			// Positions are cell indices within a row line " cellA  cellB ": column i
			// starts at 1 + sum(widths before i) + 2 * i.
			const lastColStart = 1 + columnWidths.slice(0, -1).reduce((a: number, b: number) => a + b, 0) + 2 * (numCols - 1);
			const rowRuleStart = 1 + Math.floor(columnWidths[0] / 2);
			const rowRuleEnd = lastColStart + Math.floor(columnWidths[numCols - 1] / 2);
			const rowRuleStyle = (text: string) => (this.theme.hr ? this.theme.hr(text) : text);
			const rowRule = " ".repeat(rowRuleStart) + rowRuleStyle("─".repeat(rowRuleEnd - rowRuleStart + 1));

			const lines: string[] = [];

			// Emit one visual row (possibly multi-line after per-column wrapping).
			const pushRowLines = (cellLines: string[][], bold: boolean) => {
				const rowLineCount = Math.max(...cellLines.map((c) => c.length));
				for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
					const parts = cellLines.map((cellColLines, colIdx) => {
						const text = cellColLines[lineIdx] || "";
						const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
						return bold ? this.theme.bold(padded) : padded;
					});
					lines.push(` ${parts.join(columnGap)} `);
				}
			};

			const wrapRowCells = (row: any[]): string[][] =>
				row.map((cell, i) => {
					const text = this.renderInlineTokens(cell.tokens || [], styleContext);
					return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
				});

			lines.push(heavyRule);
			pushRowLines(wrapRowCells(token.header), true);
			lines.push(thinRule);
			token.rows.forEach((row: any[], rowIndex: number) => {
				// The separator is inserted after the whole visual row, so multi-line
				// cells are crossed by at most one separator.
				if (rowIndex > 0) {
					lines.push(rowRule);
				}
				pushRowLines(wrapRowCells(row), false);
			});
			lines.push(heavyRule);

			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after table
			}
			return lines;
		} catch {
			return originalRenderTable.call(this, token, availableWidth, nextTokenType, styleContext);
		}
	};

	const installed = proto.renderTable;
	return () => {
		active = false;
		if (proto.renderTable === installed) proto.renderTable = originalRenderTable;
	};
}

/**
 * Replace ASCII symbols with typographic Unicode characters,
 * strictly skipping inline code blocks wrapped in backticks.
 */
function enhanceInlineSymbols(text: string): string {
	const segments = text.split(/(`[^`]*`)/g);

	for (let i = 0; i < segments.length; i += 2) {
		let seg = segments[i];
		seg = seg.replaceAll("<=>", "⇔");
		seg = seg.replaceAll("==>", "⇒");
		seg = seg.replaceAll("-->", "→");
		seg = seg.replaceAll("->", "→");
		seg = seg.replaceAll("=>", "⇒");
		seg = seg.replaceAll("<-", "←");
		seg = seg.replaceAll("<=", "≤");
		seg = seg.replaceAll(">=", "≥");
		seg = seg.replaceAll("!=", "≠");
		segments[i] = seg;
	}

	return segments.join("");
}

/**
 * Transform GitHub-style admonition callouts to clean badges.
 */
function enhanceCallouts(line: string): string {
	return line
		.replace(/^(\s*>\s*)\[!NOTE\]/i, "$1**[Note]**")
		.replace(/^(\s*>\s*)\[!TIP\]/i, "$1**[Tip]**")
		.replace(/^(\s*>\s*)\[!IMPORTANT\]/i, "$1**[Important]**")
		.replace(/^(\s*>\s*)\[!WARNING\]/i, "$1**[Warning]**")
		.replace(/^(\s*>\s*)\[!CAUTION\]/i, "$1**[Caution]**");
}

/**
 * Transform headings to attach a level-distinctive prefix symbol, so heading
 * levels stay distinguishable in the terminal without relying on raw '#'.
 *
 * Symbol shapes alternate solid/hollow to remain legible at small font sizes:
 *   H1 `◆` (solid diamond)
 *   H2 `◇` (hollow diamond)
 *   H3 `▸` (solid triangle)
 *   H4 `▷` (hollow triangle)
 *   H5 `▪` (small square)
 *   H6+ `·` (middot)
 *
 * H1/H2 keep their native level because Pi already strips the '#' marker and
 * applies heading styling for them; H3 and below are demoted to H2 so Pi's H2
 * styling (marker stripped, heading color + bold) applies to them too.
 */
export function enhanceHeadings(line: string): string {
	// Exact-count patterns are self-disambiguating: "#{n}\s" cannot match a
	// longer run of '#' because the next char must be whitespace.
	if (/^(\s*)#\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)#\s+(.*)$/, "$1# ◆ $2");
	}
	if (/^(\s*)##\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)##\s+(.*)$/, "$1## ◇ $2");
	}
	if (/^(\s*)###\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)###\s+(.*)$/, "$1## ▸ $2");
	}
	if (/^(\s*)####\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)####\s+(.*)$/, "$1## ▷ $2");
	}
	if (/^(\s*)#####\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)#####\s+(.*)$/, "$1## ▪ $2");
	}
	if (/^(\s*)#{6,}\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)#{6,}\s+(.*)$/, "$1## · $2");
	}
	return line;
}

/**
 * Bracket and quotation pairs to lift outside bold markers when wrapping bold text,
 * ensuring CommonMark delimiter flanking rules are satisfied in CJK contexts.
 */
const BOLD_BRACKET_PAIRS: [string, string][] = [
	["“", "”"],
	["‘", "’"],
	["《", "》"],
	["（", "）"],
	["【", "】"],
	["「", "」"],
	["『", "』"],
	["〈", "〉"],
	["(", ")"],
	["[", "]"],
	['"', '"'],
	["'", "'"],
];
const BOLD_BRACKET_PATTERNS = BOLD_BRACKET_PAIRS.map(([open, close]) => {
	const escOpen = open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escClose = close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return { open, close, pattern: new RegExp(`\\*\\*${escOpen}([\\s\\S]*?)${escClose}\\*\\*`, "g") };
});

/**
 * Clean up accidental spaces inside bold markers (e.g. `** text **` -> `**text**`),
 * strictly preserving inline code spans wrapped in backticks.
 */
function enhanceBoldSyntax(text: string): string {
	if (!text.includes("**")) return text;
	const segments = text.split(/(`[^`]*`)/g);

	for (let i = 0; i < segments.length; i += 2) {
		let seg = segments[i];

		// 1. Clean up accidental spaces inside bold markers: ** text ** -> **text**
		seg = seg.replace(/\*\*\s*([^\*\n]+?)\s*\*\*/g, (match, p1) => {
			return p1.trim() ? `**${p1.trim()}**` : match;
		});

		// 2. Lift matching outer quotation marks or brackets: **“text”** -> “**text**”
		for (const { open, close, pattern } of BOLD_BRACKET_PATTERNS) {
			seg = seg.replace(pattern, (_match, inner) => {
				return `${open}**${inner.trim()}**${close}`;
			});
		}

		// 3. Fix boundary conflicts where bold isn't bracket-wrapped:
		// If opening ** is preceded by non-space/non-punct (e.g. Hanzi) and inner starts with punct,
		// or closing ** is followed by non-space/non-punct and inner ends with punct,
		// insert boundary spaces so CommonMark satisfies left/right flanking rules.
		let result = "";
		let lastIndex = 0;
		const boldRegex = /\*\*([^\*\n]+?)\*\*/g;
		let match: RegExpExecArray | null;

		while ((match = boldRegex.exec(seg)) !== null) {
			const matchStart = match.index;
			const matchEnd = boldRegex.lastIndex;
			const inner = match[1];

			const preChar = matchStart > 0 ? seg[matchStart - 1] : "";
			const postChar = matchEnd < seg.length ? seg[matchEnd] : "";

			let prefix = "";
			let suffix = "";

			if (preChar && /[^\s\p{P}]/u.test(preChar) && /^\p{P}/u.test(inner)) {
				prefix = " ";
			}

			if (postChar && /[^\s\p{P}]/u.test(postChar) && /\p{P}$/u.test(inner)) {
				suffix = " ";
			}

			result += seg.slice(lastIndex, matchStart) + prefix + `**${inner}**` + suffix;
			lastIndex = matchEnd;
		}
		result += seg.slice(lastIndex);
		seg = result;

		segments[i] = seg;
	}

	return segments.join("");
}

/**
 * Patch Markdown.prototype.renderToken at runtime to render headings with the
 * theme's mdHeading color preserved. Pi's native heading style composes
 * `heading(bold(text))`, and the bold patch above wraps theme.bold with a
 * bright-white lift (\x1b[97m) that sits *inside* the heading color, so native
 * headings end up bright white and indistinguishable from bold body text.
 * This patch re-implements the heading branch with a pure ANSI bold, keeping
 * the heading color on the outside where it wins.
 * Layout logic (spacing after headings, raw '#' prefix for level >= 3) mirrors
 * Pi's native renderer 1:1; level >= 3 rarely occurs because enhanceHeadings
 * already demotes those to H2.
 */
export function applyHeadingPatch(): () => void {
	const proto = Markdown.prototype as any;
	let active = true;

	const originalRenderToken = proto.renderToken;

	proto.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: any): string[] {
		if (!active || token?.type !== "heading") {
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		}
		try {
			const headingLevel: number = token.depth;
			// Pure ANSI bold: deliberately bypasses theme.bold so the bold patch's
			// bright-white lift does not override the heading color. All levels share
			// one style (heading color + bold); levels are told apart by the prefix
			// symbols that enhanceHeadings injects, not by underline.
			const pureBold = (text: string) => `\x1b[1m${text}\x1b[22m`;
			const headingStyleFn = (text: string) => this.theme.heading(pureBold(text));

			// Heading-specific inline context so codespan/bold/etc. inside the
			// heading restore heading styling after their own ANSI resets.
			const headingStyleContext = {
				applyText: headingStyleFn,
				stylePrefix: this.getStylePrefix(headingStyleFn),
			};

			const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
			const headingPrefix = `${"#".repeat(headingLevel)} `;
			const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
			const lines = [styledHeading];
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after headings (unless space token follows)
			}
			return lines;
		} catch {
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		}
	};
	const installed = proto.renderToken;
	return () => {
		active = false;
		if (proto.renderToken === installed) proto.renderToken = originalRenderToken;
	};
}

/**
 * Setup Markdown enhancements:
 * - Prototype patches on Markdown component (lists, code blocks, tables, headings, bold text)
 * - Markdown transformer registration (callouts, headings, bold syntax, inline symbols)
 */
export function setupMarkdownEnhancements(pi: ExtensionAPI): () => void {
	patches[patchSlot]?.();
	const disposeList = applyListPatch();
	const disposeCodeBlock = applyCodeBlockPatch();
	const disposeTable = applyTablePatch();
	const disposeBold = applyBoldPatch();
	const disposeHeading = applyHeadingPatch();
	let active = true;
	const dispose = () => {
		if (!active) return;
		active = false;
		// Each patch wraps renderToken after the previous one, so unwind in reverse order.
		disposeHeading();
		disposeBold();
		disposeTable();
		disposeCodeBlock();
		disposeList();
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;

	pi.registerMarkdownTransformer((markdown, context) => {
		// Only transform assistant and user messages (avoid interfering with internal thinking blocks)
		if (!active || context.messageType === "assistant-thinking") {
			return markdown;
		}

		const lines = markdown.split("\n");
		const transformed: string[] = [];

		let inCodeBlock = false;
		let codeBlockChar = "";

		for (const line of lines) {
			const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
			if (fenceMatch) {
				const char = fenceMatch[2][0];
				if (!inCodeBlock) {
					inCodeBlock = true;
					codeBlockChar = char;
				} else if (char === codeBlockChar) {
					inCodeBlock = false;
					codeBlockChar = "";
				}
				transformed.push(line);
				continue;
			}

			if (inCodeBlock) {
				// Keep code block content 100% intact
				transformed.push(line);
				continue;
			}

			// 1. Transform callouts
			let processed = enhanceCallouts(line);

			// 2. Transform headings to avoid raw '#' display
			processed = enhanceHeadings(processed);

			// 3. Clean up loose spaces in bold markers outside inline code
			processed = enhanceBoldSyntax(processed);

			// 4. Enhance typographic symbols outside inline code
			processed = enhanceInlineSymbols(processed);

			transformed.push(processed);
		}

		return transformed.join("\n");
	});
	return dispose;
}
