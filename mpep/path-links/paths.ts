// Path / URL detection, markdown rewriting, and OSC 8 copy expansion.
// Tokens are split on whitespace and backticks.
// Complete paths use file:// so the terminal can open them; relative paths keep mpep-path:.
// Bare URLs glued to CJK prose are repaired before marked parses the line
// (separateAutolinkTails): Pi's GFM autolink keeps everything up to the next
// whitespace, so the Chinese would otherwise land inside the link href.

import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PATH_HREF_PREFIX = "mpep-path:";

const IS_WINDOWS = process.platform === "win32";

const INLINE_CODE = /(`+)((?:(?!\1).|\\.)*)\1/g;
const INLINE_MATH = /(\$(?:\\.|[^$\\\n])+\$|\\\([\s\S]*?\\\))/g;
const MD_LINK = /!?\[(?:[^\[\]\\]|\\.)*\]\((?:<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
const OSC8 = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const DATE_TOKEN = /^\d{1,4}(\/\d{1,2}){1,2}$/;

export type CollapseMode = "all" | "absolute-images";

export interface CollapsibleToken {
	start: number;
	end: number;
	text: string;
	kind: "file" | "url";
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|ico|tif|tiff)$/i;

export function resolveOpenTarget(path: string): string {
	if (path.startsWith("~/") || path.startsWith("~\\")) return `${homedir()}${path.slice(1)}`;
	return path;
}

/** file:// for complete paths so WT/Pi can open them; mpep-path: otherwise to preserve relative text. */
export function encodePathHref(path: string): string {
	if (isCompletePath(path)) {
		// Forward-slash drive paths (`D:/x`) stay literal on Windows:
		// fileURLToPath would hand back backslashes, rewriting the user's
		// original spelling on copy and hover.
		if (!(IS_WINDOWS && /^[A-Za-z]:\//.test(path))) {
			try {
				return pathToFileURL(resolveOpenTarget(path)).href;
			} catch {
				// Fall through to the relative-path encoding.
			}
		}
	}
	return `${PATH_HREF_PREFIX}${encodeURIComponent(path)}`;
}

export function decodePathHref(href: string | undefined): string | undefined {
	if (!href) return undefined;
	if (href.startsWith(PATH_HREF_PREFIX)) {
		try {
			return decodeURIComponent(href.slice(PATH_HREF_PREFIX.length));
		} catch {
			return href.slice(PATH_HREF_PREFIX.length);
		}
	}
	if (/^file:/i.test(href)) {
		try {
			return fileURLToPath(href);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function isCompletePath(path: string): boolean {
	return (
		/^[A-Za-z]:[\\/]/.test(path) ||
		path.startsWith("\\\\") ||
		path.startsWith("~/") ||
		path.startsWith("~\\") ||
		// Unix-root paths are complete only on POSIX. On Windows `/d/...` is a
		// Git Bash spelling: pathToFileURL would resolve it against the current
		// drive (`D:\d\...`), inventing a path that does not exist.
		(!IS_WINDOWS && path.startsWith("/") && !path.startsWith("//"))
	);
}

export function isWebHref(href: string | undefined): boolean {
	return !!href && /^(?:https?:|mailto:|file:|ftp:)/i.test(href);
}

export function normalizeWebUrl(raw: string): string {
	return /^www\./i.test(raw) ? `https://${raw}` : raw;
}

export function displayName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	const last = parts.at(-1);
	return last && last.length > 0 ? last : path;
}

export function displayNameForUrl(raw: string): string {
	const href = normalizeWebUrl(raw);
	if (/^mailto:/i.test(href)) return href.slice("mailto:".length);
	try {
		const url = new URL(href);
		const last = url.pathname.split("/").filter(Boolean).at(-1);
		if (last) {
			try {
				return decodeURIComponent(last);
			} catch {
				return last;
			}
		}
		return url.hostname || raw;
	} catch {
		return displayName(raw);
	}
}

function markdownDestination(href: string): string {
	return href.includes("://") || /[\s()]/.test(href) ? `<${href}>` : href;
}

export function toMarkdownLink(path: string): string {
	const name = displayName(path).replace(/[\[\]]/g, "");
	return `[${name || path}](${markdownDestination(encodePathHref(path))})`;
}

export function toWebMarkdownLink(url: string): string {
	const href = normalizeWebUrl(url);
	const name = displayNameForUrl(href).replace(/[\[\]]/g, "");
	return `[${name || href}](<${href}>)`;
}

function allMatches(text: string, regex: RegExp): RegExpMatchArray[] {
	return [...text.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`))];
}

function overlaps(start: number, end: number, ranges: Array<{ start: number; end: number }>): boolean {
	return ranges.some((range) => start < range.end && end > range.start);
}

function isDelimiter(char: string | undefined): boolean {
	return char === undefined || isNeighborDelimiter(char);
}

/** Space or backtick. Line edges are not delimiters unless `allowEdge` is set. */
function isNeighborDelimiter(char: string | undefined): boolean {
	return char !== undefined && (/\s/.test(char) || char === "`");
}

function isTokenBoundary(char: string | undefined, allowEdge: boolean): boolean {
	return isNeighborDelimiter(char) || (allowEdge && char === undefined);
}

function lastPathSegment(token: string): string {
	const trimmed = token.replace(/[\\/]+$/, "");
	return trimmed.split(/[\\/]/).at(-1) ?? "";
}

/** Drive / UNC / home, or a unix root path with at least two separators, ending in an image extension. */
export function isAbsoluteImagePath(token: string): boolean {
	if (!isCompletePath(token)) return false;
	if (!IMAGE_EXT.test(lastPathSegment(token))) return false;
	// `/logo.png` is technically absolute; two separators are required so line-edge
	// chips stay filesystem paths (`/tmp/x.png`) instead of root-relative names.
	if (token.startsWith("/") && !token.startsWith("//")) return pathSeparatorCount(token) >= 2;
	return true;
}

/** `/` and `\\` both count; a token needs at least two before it is collapsed. */
function pathSeparatorCount(token: string): number {
	return (token.match(/[\\/]/g) ?? []).length;
}

/**
 * English-only collapse rule, judged on the literal token text only:
 * every character must be printable ASCII (A-Z, a-z, digits, English
 * symbols). Any CJK ideograph or full-width punctuation (，、（）～「」 etc.)
 * — as well as any non-Latin script — keeps the token expanded as plain
 * text. Decoded content is irrelevant: a percent-encoded URL stays
 * collapsible even if its short label renders as CJK.
 */
/** Printable ASCII: A-Z, a-z, digits, English symbols, spaces. */
function isPrintableAscii(char: string): boolean {
	const code = char.charCodeAt(0);
	return code >= 0x20 && code <= 0x7e;
}

function isEnglishText(text: string): boolean {
	for (const char of text) {
		if (!isPrintableAscii(char)) return false;
	}
	return true;
}

export function looksLikePathToken(token: string): boolean {
	if (token.length < 3) return false;
	// Hard gate before anything else: mixed chains like `项目/src/文件` no
	// longer collapse, even though they carry English letters.
	if (!isEnglishText(token)) return false;
	if (DATE_TOKEN.test(token)) return false;
	if (/^(?:https?:|mailto:|file:|ftp:)/i.test(token) || /^www\./i.test(token)) return true;
	const shaped =
		/^[A-Za-z]:[\\/]/.test(token) ||
		token.startsWith("\\\\") ||
		token.startsWith("~/") ||
		token.startsWith("~\\") ||
		/[\\/]/.test(token);
	if (!shaped) return false;
	// One `/` or `\` is not a path: `/reload`, `foo/bar.ts`, `C:\a` stay plain text.
	if (pathSeparatorCount(token) < 2) return false;
	return true;
}

function tokenKind(token: string): "file" | "url" {
	return /^(?:https?:|mailto:|file:|ftp:)/i.test(token) || /^www\./i.test(token) ? "url" : "file";
}

function displayForToken(token: CollapsibleToken): string {
	const name = token.kind === "url" ? displayNameForUrl(token.text) : displayName(token.text);
	return name.replace(/[\[\]]/g, "") || token.text;
}

export function findCollapsibleTokens(
	line: string,
	mode: CollapseMode = "all",
	allowEdges?: boolean,
): CollapsibleToken[] {
	if (!line) return [];
	// Codespan inners pass true so a lone path inside backticks still matches.
	// Absolute image paths also treat line edges as delimiters: Pi trims submitted
	// editor text, so a leading space added only to chip a clipboard image is gone
	// in the transcript. Other paths still need a real space or backtick on both sides.
	const edges = allowEdges === true;
	const blocked = allMatches(line, MD_LINK).map((match) => ({
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
	const tokens: CollapsibleToken[] = [];
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (isDelimiter(char)) {
			index++;
			continue;
		}
		let end = index;
		while (end < line.length && !isDelimiter(line[end])) end++;
		const text = line.slice(index, end);
		const kind = tokenKind(text);
		const token = { start: index, end, text, kind };
		const image = kind === "file" && isAbsoluteImagePath(text);
		const display = displayForToken(token);
		// Literal-only rule: the gate is the token text, never the decoded display
		// name. Percent-encoded URLs are ASCII on their face, so they still
		// collapse even though the short label renders as CJK. `all` mode already
		// enforces this inside looksLikePathToken; image chips need it explicitly.
		const allowed =
			mode === "absolute-images" ? image && isEnglishText(text) : looksLikePathToken(text);
		const bounded =
			edges || (isTokenBoundary(line[index - 1], image) && isTokenBoundary(line[end], image));
		if (allowed && bounded && display !== text && !overlaps(index, end, blocked)) {
			tokens.push(token);
		}
		index = end;
	}
	return tokens;
}

export function collapseLineVisual(
	line: string,
	cursor?: number,
	mode: CollapseMode = "all",
): { visual: string; toLogical: number[]; toVisual: number[] } {
	const tokens = findCollapsibleTokens(line, mode);
	const skip = new Set(
		tokens
			.filter((token) => cursor === undefined || cursor < token.start || cursor >= token.end)
			.map((token) => token.start),
	);
	const byStart = new Map(tokens.map((token) => [token.start, token]));
	let visual = "";
	const toLogical: number[] = [];
	const toVisual: number[] = [];
	let logical = 0;
	while (logical < line.length) {
		const token = byStart.get(logical);
		if (token && skip.has(logical)) {
			const display = displayForToken(token);
			const span = Math.max(1, token.end - token.start);
			const visualStart = visual.length;
			visual += display;
			for (let offset = 0; offset < display.length; offset++) {
				toLogical.push(token.start + Math.min(span - 1, Math.floor((offset * span) / display.length)));
			}
			for (let index = 0; index < span; index++) {
				toVisual[token.start + index] =
					visualStart + Math.min(display.length - 1, Math.floor((index * display.length) / span));
			}
			toVisual[token.end] = visualStart + display.length;
			logical = token.end;
			continue;
		}
		toVisual[logical] = visual.length;
		toLogical.push(logical);
		visual += line[logical] ?? "";
		logical++;
	}
	toVisual[line.length] = visual.length;
	toLogical.push(line.length);
	return { visual, toLogical, toVisual };
}

function replacementFor(token: CollapsibleToken): string {
	return token.kind === "url" ? toWebMarkdownLink(token.text) : toMarkdownLink(token.text);
}

function splitInline(line: string): Array<{ start: number; end: number; kind: "code" | "math" | "text"; raw: string }> {
	const segments: Array<{ start: number; end: number; kind: "code" | "math" | "text"; raw: string }> = [];
	const spans: Array<{ start: number; end: number; kind: "code" | "math" }> = [];

	for (const match of allMatches(line, INLINE_CODE)) {
		spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind: "code" });
	}
	for (const match of allMatches(line, INLINE_MATH)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (!spans.some((s) => (start >= s.start && start < s.end) || (end > s.start && end <= s.end))) {
			spans.push({ start, end, kind: "math" });
		}
	}
	spans.sort((a, b) => a.start - b.start);

	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) {
			segments.push({ start: cursor, end: span.start, kind: "text", raw: line.slice(cursor, span.start) });
		}
		segments.push({ start: span.start, end: span.end, kind: span.kind, raw: line.slice(span.start, span.end) });
		cursor = span.end;
	}
	if (cursor < line.length) segments.push({ start: cursor, end: line.length, kind: "text", raw: line.slice(cursor) });
	return segments;
}

// ---------------------------------------------------------------------------
// Bare-URL autolink boundary repair (URL glued to CJK prose)
// ---------------------------------------------------------------------------
// Pi renders markdown with marked's GFM autolink rule
// (`((?:https?|ftp)://|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*`): everything up to the
// next whitespace or `<` becomes the href, and its backpedal only strips
// trailing ASCII punctuation — never CJK. So `…/observation.html"这里的 port
// 要填具体值吗？` becomes ONE link whose text and href both carry the Chinese
// (clicking it opens a percent-encoded nonsense URL).
//
// path-links cannot undo that downstream: its English-only gate only decides
// whether a token is rewritten into a short markdown link, and this token fails
// the gate (contains CJK) so it stays expanded — yet marked links it anyway.
// The boundary is therefore repaired here, before marked parses the line, by
// making the URL boundary explicit: a scheme URL is wrapped in an `<…>`
// autolink and the glued tail stays plain text. Nothing is touched unless a
// non-ASCII character is actually glued to a URL, so pure-ASCII lines
// round-trip byte-identical and percent-encoded URLs stay untouched.
//
// The repair runs *after* the collapse (see transformPathMarkdown): the collapse
// already refused this CJK token, so the token keeps the gate's "stays
// expanded" outcome instead of gaining a fresh short chip from the repair.

/** Bare-URL starts recognised by marked's GFM autolink (`protocol` alternation). */
const AUTOLINK_START = /(?:https?:\/\/|ftp:\/\/|www\.)/gi;

/**
 * Marked's host requirement after the start, reused as a guard: a URL whose own
 * host is non-ASCII (`http://例.com`) is left alone instead of being cut into a
 * broken `<http://>` autolink.
 */
const AUTOLINK_HOST = /^(?:https?|ftp):\/\/(?:[a-zA-Z0-9-]+\.?)+|^www\.(?:[a-zA-Z0-9-]+\.?)+/;

/** Quote characters that prose glues onto a URL but that never end one. */
function isUrlTailQuote(char: string | undefined): boolean {
	return char === '"' || char === "'";
}

/** Marked's autolink run: `[^\s<]*` after the start, i.e. up to a space or `<`. */
function autolinkRunEnd(line: string, start: number): number {
	let end = start;
	while (end < line.length) {
		const char = line[end] ?? "";
		if (char === "<" || /\s/.test(char)) break;
		end++;
	}
	return end;
}

/** Offset of the first non-ASCII character inside [start, end), or -1. */
function firstNonAsciiOffset(line: string, start: number, end: number): number {
	for (let index = start; index < end; index++) {
		if (!isPrintableAscii(line[index] ?? "")) return index;
	}
	return -1;
}

function applyLineEdits(line: string, edits: Array<{ start: number; end: number; text: string }>): string {
	if (edits.length === 0) return line;
	let out = "";
	let cursor = 0;
	for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
		// Overlapping candidates (a URL inside a URL's tail) keep the leftmost one.
		if (edit.start < cursor) continue;
		out += line.slice(cursor, edit.start) + edit.text;
		cursor = edit.end;
	}
	return out + line.slice(cursor);
}

/**
 * Cut a bare URL away from CJK prose glued onto it so marked keeps it a single
 * valid link. Line content inside inline code spans and markdown links is left
 * untouched, as are lines without any glued non-ASCII tail.
 */
export function separateAutolinkTails(line: string): string {
	if (!line || (!line.includes("://") && !/www\./i.test(line))) return line;
	const blocked = allMatches(line, MD_LINK).map((match) => ({
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
	const edits: Array<{ start: number; end: number; text: string }> = [];
	for (const segment of splitInline(line)) {
		if (segment.kind === "code") continue;
		for (const match of segment.raw.matchAll(AUTOLINK_START)) {
			const start = segment.start + (match.index ?? 0);
			const end = autolinkRunEnd(line, start);
			// `<-url>` is already an explicit autolink; md links own their destination.
			if (line[start - 1] === "<" || overlaps(start, end, blocked)) continue;
			const tail = firstNonAsciiOffset(line, start, end);
			if (tail < 0) continue;
			let urlEnd = tail;
			while (urlEnd > start && isUrlTailQuote(line[urlEnd - 1])) urlEnd--;
			const url = line.slice(start, urlEnd);
			if (!AUTOLINK_HOST.test(url)) continue;
			// `www.` has no scheme to wrap; a space is enough for marked to stop there.
			const prefix = /^www\./i.test(url) ? `${url} ` : `<${url}>`;
			edits.push({ start, end: tail, text: prefix + line.slice(urlEnd, tail) });
		}
	}
	return applyLineEdits(line, edits);
}

// ---------------------------------------------------------------------------
// Explicit-link destination repair (local paths written as markdown links)
// ---------------------------------------------------------------------------
// Models routinely reference code with `[name](/D:/repo/file.rs:146)`: the
// destination is a local path, not a URI. The collapse above deliberately
// leaves explicit markdown links alone, so this raw path reaches the terminal
// as the OSC 8 href — where a scheme-less `/D:/...` spelling (Git Bash drive)
// with a glued `:line` suffix is an invalid URI: hover shows "invalid URI"
// and Ctrl+click dies. Repair the destination in place: genuine URIs
// (scheme present) and anchors pass through untouched, local paths are
// re-encoded through encodePathHref (Git Bash drives un-`/`ed, `:line` suffix
// dropped) so hover previews and click-to-open work again. Image
// destinations are left alone: mpep-path:/file: rewrites could break Pi's own
// image rendering.

/** Explicit markdown links, capturing image bang, label, destination, title. */
const EXPLICIT_LINK = /(!?)\[((?:[^\[\]\\]|\\.)*)\]\((<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?)\)/g;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
const GIT_BASH_DRIVE = /^\/[A-Za-z]:[\\/]/;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/** Repaired destination for an explicit link, or undefined to leave it as-is. */
function normalizeLinkDestination(raw: string): string | undefined {
	const dest = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
	if (!dest || /^[#?]/.test(dest)) return undefined;
	// `[x](www.example.com)` is a web link missing its scheme, not a path.
	if (/^www\./i.test(dest)) return markdownDestination(normalizeWebUrl(dest));
	let path: string;
	// Drive checks run before the scheme check: `D:\x` matches URI_SCHEME (`D:`).
	if (WIN_DRIVE.test(dest)) {
		path = dest;
	} else if (IS_WINDOWS && GIT_BASH_DRIVE.test(dest)) {
		path = dest.slice(1);
	} else if (URI_SCHEME.test(dest)) {
		return undefined; // Genuine URI: http:, file:, mpep-path:, mailto:, data: ...
	} else if (!dest.startsWith("~") && !/[\\/]/.test(dest)) {
		return undefined; // Not path-shaped (single-segment relative name).
	} else {
		path = dest;
	}
	// `[file.go:372](…/file.go:372)`: the label keeps the line number; the
	// target must not, or the OS would look for a file literally named `…:372`.
	path = path.replace(LINE_SUFFIX, "");
	if (!path) return undefined;
	return markdownDestination(encodePathHref(path));
}

/** Normalize local-path destinations of explicit markdown links, in place. */
export function normalizeExplicitLinks(line: string): string {
	if (!line || !line.includes("](")) return line;
	const edits: Array<{ start: number; end: number; text: string }> = [];
	for (const segment of splitInline(line)) {
		if (segment.kind === "code") continue;
		for (const match of segment.raw.matchAll(EXPLICIT_LINK)) {
			const start = segment.start + (match.index ?? 0);
			if (match[1] === "!") continue; // Image destinations stay untouched.
			const dest = normalizeLinkDestination(match[3] ?? "");
			if (dest === undefined) continue;
			edits.push({
				start,
				end: start + match[0].length,
				text: `[${match[2] ?? ""}](${dest}${match[4] ?? ""})`,
			});
		}
	}
	return applyLineEdits(line, edits);
}

function transformLine(line: string): string {
	if (!line) return line;
	let out = "";
	for (const segment of splitInline(line)) {
		if (segment.kind === "math") {
			out += segment.raw;
			continue;
		}
		if (segment.kind === "code") {
			const fence = /^(`+)([\s\S]*)\1$/.exec(segment.raw);
			const inner = fence?.[2] ?? "";
			const innerTokens = findCollapsibleTokens(inner, "all", true);
			out +=
				innerTokens.length === 1 && innerTokens[0].start === 0 && innerTokens[0].end === inner.length
					? replacementFor(innerTokens[0])
					: segment.raw;
			continue;
		}
		const tokens = findCollapsibleTokens(segment.raw);
		if (tokens.length === 0) {
			out += segment.raw;
			continue;
		}
		let cursor = 0;
		for (const token of tokens) {
			out += segment.raw.slice(cursor, token.start);
			out += replacementFor(token);
			cursor = token.end;
		}
		out += segment.raw.slice(cursor);
	}
	return out;
}

/** Rewrite space/backtick-delimited path and URL tokens into short markdown links. */
export function transformPathMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const transformed: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let inMathBlock = false;
	let mathDelimiter = "";
	for (const line of lines) {
		const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
		if (fenceMatch) {
			const char = fenceMatch[2][0] ?? "";
			if (!inFence) {
				inFence = true;
				fenceChar = char;
			} else if (char === fenceChar) {
				inFence = false;
				fenceChar = "";
			}
			transformed.push(line);
			continue;
		}
		if (inFence) {
			transformed.push(line);
			continue;
		}

		// Preserve block-level math ($$ ... $$ or \[ ... \])
		const trimmed = line.trim();
		if (!inMathBlock) {
			if (/^\$\$(.*)\$\$$/.test(trimmed) && trimmed.length > 2) {
				transformed.push(line);
				continue;
			}
			if (/^\\\[(.*)\\\]$/.test(trimmed) && trimmed.length > 4) {
				transformed.push(line);
				continue;
			}
			if (trimmed.startsWith("$$")) {
				inMathBlock = true;
				mathDelimiter = "$$";
				transformed.push(line);
				continue;
			}
			if (trimmed.startsWith("\\[")) {
				inMathBlock = true;
				mathDelimiter = "\\]";
				transformed.push(line);
				continue;
			}
		} else {
			if (
				(mathDelimiter === "$$" && (trimmed === "$$" || trimmed.endsWith("$$"))) ||
				(mathDelimiter === "\\]" && (trimmed === "\\]" || trimmed.endsWith("\\]")))
			) {
				inMathBlock = false;
				mathDelimiter = "";
			}
			transformed.push(line);
			continue;
		}

		transformed.push(normalizeExplicitLinks(separateAutolinkTails(transformLine(line))));
	}
	return transformed.join("\n");
}

function emitChunk(chunk: string, active: string | undefined, strip: (value: string) => string): string {
	const visible = strip(chunk);
	if (!visible) return "";
	return decodePathHref(active) ?? (isWebHref(active) ? (active as string) : visible);
}

/** Replace visible short names of OSC 8 links with the original href/path. */
export function expandPathLinks(ansi: string, strip: (value: string) => string): string {
	if (!ansi.includes("\x1b]8;")) return strip(ansi);
	let result = "";
	// Stack, not a single slot: sliceByColumn replays escape codes from before
	// the selection (pendingAnsi) *after* codes emitted at the selection start
	// column, so a stale close from a previous chip can land between this chip's
	// own open and its text. Stack pairing lets that close pop its own open
	// instead of clearing the chip's href.
	const stack: string[] = [];
	let last = 0;
	for (const match of allMatches(ansi, OSC8)) {
		result += emitChunk(ansi.slice(last, match.index ?? 0), stack.at(-1), strip);
		if (match[1]) stack.push(match[1]);
		else stack.pop();
		last = (match.index ?? 0) + match[0].length;
	}
	result += emitChunk(ansi.slice(last), stack.at(-1), strip);
	return result;
}
