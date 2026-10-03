// Native terminal soft-wrap bridge for the enhancer's selection copy.
//
// The TUI joins visual rows with explicit CRLF, so a terminal emulator's own
// drag-selection copies soft-wrapped prose as separate hard lines. This module makes
// those joins wrap-aware (IBufferLine.isWrapped) without touching the application's
// own selection copy, the clipboard, or any global terminal object.
//
// applyLineResets is patched on TuiMainScreen/TuiAltScreen only: during a render it
// parses the existing selection markers, then tags every normalized row with a
// deterministic zero-width transport marker (ESC]777;mpep-native-wrap;<row>;<fp>BEL).
// doRender temporarily replaces the owner's terminal.write with a streaming decoder
// that strips the marker (it must never reach the terminal) and, for a verified
// continuation row, injects the proven trigger right after the renderer's CSI 2K:
//   CSI 1A  CSI <glyphStart> G  <prev last cell with SGR/link>  <reset> <char> CR
// Reprinting the previous last cell plus one throwaway character makes the terminal
// wrap naturally into the current row (setting isWrapped); CSI 2K after the trigger
// would clear it, so the clear stays before the trigger.
//
// The decoder holds the renderer's CSI 2K back until it sees whether a transport
// marker follows, because that clear's fate depends on the row:
//   - safe rewrite: emit the clear, then the trigger (as above);
//   - verified continuation at the main-screen top edge (safeToMoveUp is false, so
//     the row above is outside the viewport and must never be cursor-ed into): replay
//     `CSI <columns> X` (ECH at column 0) instead, which erases the row in place but
//     keeps its existing isWrapped flag that a CSI 2K would have dropped;
//   - hard row / image / no metadata: preserve the renderer's CSI 2K verbatim.
// Both the clear and its marker can be split across writes, so a bounded tail (a
// partial clear prefix, a trailing clear, or a clear plus a partial marker prefix)
// is held and resolved on the next chunk or at flush.
//
// A row whose visible text contains an ambiguous emoji/presentation sequence is
// never given an edge (see AMBIGUOUS_EMOJI): with a different emoji width table the
// reprint would corrupt the row below, so those rows keep the upstream hard break.
//
// Continuation is claimed only for adjacent rows the enhancer already linked as one
// logical line (wrap markers id/partCount + part+1, or frame body id/src/partCount +
// part+1); hard breaks, table rows, code borders, and unmarked lines are never joined.

import { TuiAltScreen, TuiMainScreen, type Terminal, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { parseSelectionMarkers, type ParsedMarkers } from "./selection-markers.ts";

// Private transport namespace. It deliberately differs from the selection marker
// prefix ("\x1b]777;mpep;") so stripSelectionMarkers never matches it.
const MARKER_START = "\x1b]777;mpep-native-wrap;";
const MARKER_END = "\x07";
// SGR reset plus OSC 8 hyperlink close: neutralizes style/link bleed from a reprint.
const RESET = "\x1b[0m\x1b]8;;\x07";
const KITTY_IMAGE_PREFIX = "\x1b_G";
const ITERM2_IMAGE_PREFIX = "\x1b]1337;File=";
// Erase-in-line (`CSI 2K`). It clears the whole row but, unlike erase-character,
// it also drops the row's isWrapped flag; so it must be replayed verbatim only for
// rows the bridge is allowed to rewrite (hard rows and safe trigger rows).
const CLEAR = "\x1b[2K";

// A row containing any of these has a cell count that depends on the terminal's
// emoji width table, which can disagree with pi-tui (a headless Unicode6/Unicode9
// terminal gives U+1F600 width 1 while pi-tui gives 2). The reprint edge is sliced
// from pi-tui's columns, so under that disagreement it lands at the wrong column
// and the following row's text overwrites the preceding row. Rather than guess a
// width table, the bridge refuses the edge and keeps the upstream hard break:
//   - Extended_Pictographic: emoji and emoji-presentation symbols.
//   - U+1F1E6..U+1F1FF: regional indicators (flag pairs).
//   - U+1F3FB..U+1F3FF: emoji skin-tone modifiers.
//   - U+200D: zero-width joiner (ZWJ emoji sequences).
//   - U+20E3: combining enclosing keycap.
//   - U+FE0E / U+FE0F: text / emoji variation selectors.
//   - U+E0020..U+E007F: emoji tag sequences (including the cancel tag).
const AMBIGUOUS_EMOJI =
	/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u200D\u20E3\uFE0E\uFE0F\u{E0020}-\u{E007F}]/u;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type RenderKind = "main" | "alt";

interface EdgeFull {
	kind: "full";
	/** 1-indexed terminal column where the reprinted grapheme starts. */
	startColumn: number;
	/** The last cell re-sliced from the normalized row, with SGR/link state restored. */
	slice: string;
}

interface EdgeBlank {
	kind: "blank";
}

type Edge = EdgeFull | EdgeBlank;

interface WrapSession {
	kind: RenderKind;
	columns: number;
	/** Viewport top at the start of a main-screen render; used to guard CSI 1A. */
	startViewportTop: number;
	/** row -> edge of that row, stored only when row+1 is a verified continuation. */
	edges: Map<number, Edge>;
	/** Row whose transport marker was most recently consumed in this render. */
	lastEmittedRow: number;
}

interface WrapHost {
	terminal: Terminal;
	previousHeight?: number;
	previousViewportTop?: number;
}

type ApplyLineResets = (this: unknown, lines: string[]) => string[];
type Proto = Record<string, unknown>;

// Sessions are attached to the TUI owner only for the duration of one synchronous
// doRender, so a decoder can never observe a stale session.
const sessions = new WeakMap<object, WrapSession>();

const installSlot = Symbol.for("mpep.native-terminal-wrap.install");

interface InstallState {
	holders: number;
	restore?: () => void;
}

const installs = globalThis as unknown as Record<symbol, InstallState | undefined>;

function isImageContentLine(line: string): boolean {
	return line.includes(KITTY_IMAGE_PREFIX) || line.includes(ITERM2_IMAGE_PREFIX);
}

function sameWrap(prev: ParsedMarkers, cur: ParsedMarkers): boolean {
	const a = prev.wrap;
	const b = cur.wrap;
	return !!a && !!b && a.id === b.id && a.partCount === b.partCount && b.part === a.part + 1;
}

function sameFrameBody(prev: ParsedMarkers, cur: ParsedMarkers): boolean {
	const a = prev.frame;
	const b = cur.frame;
	return (
		!!a &&
		!!b &&
		a.role === "body" &&
		b.role === "body" &&
		a.id === b.id &&
		a.src === b.src &&
		a.partCount === b.partCount &&
		b.part === a.part + 1
	);
}

/** Adjacent rows are one logical line only when the enhancer linked them as such. */
function isContinuation(prev: ParsedMarkers, cur: ParsedMarkers): boolean {
	if (prev.wrap !== undefined || cur.wrap !== undefined) return sameWrap(prev, cur);
	return sameFrameBody(prev, cur);
}

/**
 * Describe how to reproduce this row's last rendered cell. Returns undefined when
 * the row is too wide or otherwise malformed; the next row then skips its trigger.
 */
function computeEdge(line: string, columns: number): Edge | undefined {
	const clean = stripTerminalSequences(line);
	// An ambiguous emoji/presentation sequence anywhere on the row makes the
	// terminal's column model unreliable, so skip the reprint and let the renderer's
	// own hard break stand (see AMBIGUOUS_EMOJI). This keeps the layout intact; the
	// only cost is that such a row does not join on native copy.
	if (AMBIGUOUS_EMOJI.test(clean)) return undefined;

	const width = visibleWidth(line);
	if (width > columns) return undefined;
	// A row shorter than the terminal never wrapped physically: the last cell is blank.
	if (width < columns) return { kind: "blank" };

	// Exactly full: find the last complete nonzero-width grapheme and re-slice it so
	// its SGR colors and OSC 8 hyperlinks are restored on reprint.
	let glyph = "";
	for (const segment of graphemeSegmenter.segment(clean)) {
		if (visibleWidth(segment.segment) > 0) glyph = segment.segment;
	}
	if (!glyph) return undefined;
	const glyphWidth = visibleWidth(glyph);
	if (glyphWidth <= 0 || glyphWidth > columns) return undefined;
	const start = columns - glyphWidth;
	const slice = sliceByColumn(line, start, glyphWidth, true);
	if (!slice || visibleWidth(slice) !== glyphWidth) return undefined;
	return { kind: "full", startColumn: start + 1, slice };
}

/** FNV-1a over the edge so a changed previous edge re-diffs the continuation row. */
function hash32(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function edgeFingerprint(edge: Edge): string {
	const key = edge.kind === "blank" ? "b" : `f${edge.startColumn}:${edge.slice}`;
	return hash32(key).toString(36);
}

function transportMarker(row: number, fingerprint: string): string {
	return `${MARKER_START}${row};${fingerprint}${MARKER_END}`;
}

/** Emit the verified wrap trigger. `blank` needs one cell plus one throwaway space. */
function wrapTrigger(edge: Edge, columns: number, kind: RenderKind): string {
	const trigger =
		edge.kind === "blank"
			? `\x1b[1A\x1b[${columns}G${RESET}  \r`
			: `\x1b[1A\x1b[${edge.startColumn}G${edge.slice}${RESET} \r`;
	// Fullscreen deliberately disables DECAWM. Enable it only for this synthetic
	// wrap, then restore the mode before writing the actual row or any overlay.
	return kind === "alt" ? `\x1b[?7h${trigger}\x1b[?7l` : trigger;
}

/** Longest suffix of `value` that is a strict prefix of the transport marker. */
function partialMarkerSuffixLength(value: string): number {
	const max = Math.min(value.length, MARKER_START.length - 1);
	for (let length = max; length > 0; length--) {
		if (value.endsWith(MARKER_START.slice(0, length))) return length;
	}
	return 0;
}

/** Longest suffix of `value` that is a strict prefix of the erase-in-line clear. */
function partialClearSuffixLength(value: string): number {
	const max = Math.min(value.length, CLEAR.length - 1);
	for (let length = max; length > 0; length--) {
		if (value.endsWith(CLEAR.slice(0, length))) return length;
	}
	return 0;
}

/** True when a complete `CSI 2K` sits immediately before `at`. */
function clearImmediatelyBefore(value: string, at: number): boolean {
	return at >= CLEAR.length && value.startsWith(CLEAR, at - CLEAR.length);
}

/**
 * Streaming decoder for the transport marker plus the renderer clear that precedes
 * it. It tolerates markers and clears split across BoundedTerminalWriter chunks by
 * holding back only a bounded tail (at most a partial clear prefix, a trailing
 * clear, or a clear plus a partial marker prefix). It never buffers arbitrary
 * transcript data.
 */
class NativeWrapDecoder {
	private tail = "";
	private readonly session: WrapSession;

	constructor(session: WrapSession) {
		this.session = session;
	}

	/**
	 * How many trailing code units must be held because they may still change the
	 * output: a partial marker prefix, a trailing clear, or a clear immediately
	 * before a partial marker prefix.
	 */
	private holdLength(value: string): number {
		const markerHold = partialMarkerSuffixLength(value);
		if (markerHold > 0) {
			const before = value.slice(0, value.length - markerHold);
			// Keep the clear that may be replaced by ECH once the row is known.
			return before.endsWith(CLEAR) ? markerHold + CLEAR.length : markerHold;
		}
		if (value.endsWith(CLEAR)) return CLEAR.length;
		return partialClearSuffixLength(value);
	}

	push(chunk: string, emit: (data: string) => void): void {
		let rest = this.tail.length > 0 ? this.tail + chunk : chunk;
		this.tail = "";
		while (rest.length > 0) {
			const at = rest.indexOf(MARKER_START);
			if (at === -1) {
				const hold = this.holdLength(rest);
				if (hold > 0) {
					if (rest.length > hold) emit(rest.slice(0, rest.length - hold));
					this.tail = rest.slice(rest.length - hold);
				} else {
					emit(rest);
				}
				return;
			}
			// Hold the renderer's clear back only when it directly precedes our marker:
			// its fate (verbatim, ECH, or trigger) is chosen once the row is decoded.
			const hasClear = clearImmediatelyBefore(rest, at);
			const contentEnd = hasClear ? at - CLEAR.length : at;
			if (contentEnd > 0) emit(rest.slice(0, contentEnd));
			const body = rest.slice(at + MARKER_START.length);
			const end = body.indexOf(MARKER_END);
			if (end === -1) {
				// Marker (and any clear in front of it) continues in a later chunk; hold
				// both so neither the token nor the pending clear decision can leak.
				this.tail = rest.slice(contentEnd);
				return;
			}
			this.handleMarker(body.slice(0, end), hasClear, emit);
			rest = body.slice(end + 1);
		}
	}

	/** Flush a held tail at the end of a render without leaking a native token. */
	flush(emit: (data: string) => void): void {
		const tail = this.tail;
		this.tail = "";
		if (!tail) return;
		if (tail.startsWith(CLEAR)) {
			// A bare trailing clear is the renderer's own output; a clear in front of an
			// unterminated marker belongs to an aborted row and is dropped with it.
			if (tail.length === CLEAR.length) emit(tail);
			return;
		}
		if (tail.includes(MARKER_START)) return;
		// A partial marker prefix must never reach the terminal; a partial clear prefix
		// (or any other ordinary bytes) is re-emitted.
		if (partialMarkerSuffixLength(tail) === tail.length) return;
		emit(tail);
	}

	private handleMarker(payload: string, hasClear: boolean, emit: (data: string) => void): void {
		const separator = payload.indexOf(";");
		const row = Number.parseInt(separator === -1 ? payload : payload.slice(0, separator), 10);
		if (!Number.isInteger(row) || row < 0) {
			if (hasClear) emit(CLEAR);
			return;
		}

		const session = this.session;
		const edge = session.edges.get(row - 1);
		if (edge && this.safeToMoveUp(row, session)) {
			// Safe rewrite: clear the row, then reprint the edge so the terminal wraps.
			if (hasClear) emit(CLEAR);
			emit(wrapTrigger(edge, session.columns, session.kind));
		} else if (edge && session.kind === "main" && hasClear) {
			// Verified continuation whose previous row is the main-screen top edge: the
			// row cannot cursor-up past the viewport, but replaying CSI 2K would drop the
			// isWrapped flag the row already has. ECH erases the cells in place (cursor is
			// already at column 0) and keeps the existing soft-wrap boundary intact.
			// Alt screens never reach here: every edge row there is safe to rewrite.
			emit(`\x1b[${session.columns}X`);
		} else if (hasClear) {
			// Hard row, image, or no metadata: preserve the renderer's own clear.
			emit(CLEAR);
		}
		session.lastEmittedRow = row;
	}

	/** Only rewrite the row above when it is the real previous content row. */
	private safeToMoveUp(row: number, session: WrapSession): boolean {
		const previous = row - 1;
		if (previous < 0) return false;
		if (session.kind === "alt") return row > 0;
		// Main screen: the previous row is safe when this render just wrote it, or when
		// it already sits inside the initial viewport and was not scrolled away.
		return previous === session.lastEmittedRow || row > session.startViewportTop;
	}
}

function createSession(kind: RenderKind, host: WrapHost, terminal: Terminal): WrapSession {
	const columns = Math.max(1, terminal.columns);
	let startViewportTop = 0;
	if (kind === "main") {
		const height = Math.max(1, terminal.rows);
		const previousHeight = typeof host.previousHeight === "number" ? host.previousHeight : 0;
		const previousTop = typeof host.previousViewportTop === "number" ? host.previousViewportTop : 0;
		// Mirror TuiMainScreen.doRender's viewport recomputation so a height change
		// during a Termux-style render keeps the CSI 1A guard honest.
		const heightChanged = previousHeight !== 0 && previousHeight !== height;
		const previousBufferLength = previousHeight > 0 ? previousTop + previousHeight : height;
		startViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : previousTop;
	}
	return { kind, columns, startViewportTop, edges: new Map(), lastEmittedRow: -1 };
}

/** Parse markers, normalize, then tag every row with its deterministic transport marker. */
function annotateLines(
	session: WrapSession,
	host: WrapHost,
	original: ApplyLineResets,
	lines: string[],
): string[] {
	// Selection metadata must be read before the strip hook erases it below.
	const parsed = new Array<ParsedMarkers>(lines.length);
	for (let index = 0; index < lines.length; index++) {
		parsed[index] = parseSelectionMarkers(lines[index] ?? "");
	}
	const normalized = original.call(host, lines);

	session.edges.clear();
	for (let index = 0; index + 1 < normalized.length; index++) {
		if (!isContinuation(parsed[index], parsed[index + 1])) continue;
		const row = normalized[index] ?? "";
		if (isImageContentLine(row)) continue;
		const edge = computeEdge(row, session.columns);
		if (edge) session.edges.set(index, edge);
	}

	const output = new Array<string>(normalized.length);
	for (let index = 0; index < normalized.length; index++) {
		const line = normalized[index] ?? "";
		if (isImageContentLine(line)) {
			output[index] = line;
			continue;
		}
		const edge = session.edges.get(index - 1);
		output[index] = transportMarker(index, edge ? edgeFingerprint(edge) : "") + line;
	}
	return output;
}

function runRender(
	host: WrapHost,
	terminal: Terminal,
	session: WrapSession,
	originalDoRender: (this: unknown) => void,
): void {
	sessions.set(host as object, session);
	const originalWrite = terminal.write;
	const hadOwnWrite = Object.prototype.hasOwnProperty.call(terminal, "write");
	const writeDescriptor = hadOwnWrite ? Object.getOwnPropertyDescriptor(terminal, "write") : undefined;
	const decoder = new NativeWrapDecoder(session);
	const emit = (data: string): void => {
		if (data) originalWrite.call(terminal, data);
	};
	try {
		terminal.write = (data: string): void => {
			// Preserve the upstream writer's batching instead of turning each row
			// marker into a separate stdout write during a large transcript redraw.
			const parts: string[] = [];
			decoder.push(data, (part) => parts.push(part));
			emit(parts.join(""));
		};
		originalDoRender.call(host);
	} finally {
		try {
			decoder.flush(emit);
		} finally {
			// Restore even when the underlying writer itself throws while flushing.
			if (hadOwnWrite && writeDescriptor) Object.defineProperty(terminal, "write", writeDescriptor);
			else delete (terminal as unknown as Proto).write;
			sessions.delete(host as object);
		}
	}
}

/** Swap one method on a prototype, restoring own-vs-inherited descriptors exactly. */
function replaceMethod(proto: Proto, name: string, installed: unknown): () => void {
	const hadOwn = Object.prototype.hasOwnProperty.call(proto, name);
	const descriptor = hadOwn ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
	proto[name] = installed;
	return () => {
		if (hadOwn && descriptor) Object.defineProperty(proto, name, descriptor);
		else delete proto[name];
	};
}

function installOnPrototype(proto: Proto, kind: RenderKind): (() => void) | undefined {
	const originalDoRender = proto.doRender;
	const originalApply = proto.applyLineResets;
	if (typeof originalDoRender !== "function" || typeof originalApply !== "function") return undefined;
	const doRender = originalDoRender as (this: unknown) => void;
	const applyLineResets = originalApply as ApplyLineResets;

	const installedDoRender = function (this: WrapHost): void {
		const terminal = this?.terminal;
		// A one-row viewport has no previous visible row to reprint safely.
		if (!terminal || terminal.rows < 2 || typeof terminal.write !== "function") {
			doRender.call(this);
			return;
		}
		runRender(this, terminal, createSession(kind, this, terminal), doRender);
	};

	const installedApply = function (this: unknown, lines: string[]): string[] {
		const session = sessions.get(this as object);
		if (!session || !Array.isArray(lines) || lines.length === 0) {
			return applyLineResets.call(this, lines);
		}
		return annotateLines(session, this as WrapHost, applyLineResets, lines);
	};

	const restoreApply = replaceMethod(proto, "applyLineResets", installedApply);
	const restoreDoRender = replaceMethod(proto, "doRender", installedDoRender);
	return () => {
		restoreApply();
		restoreDoRender();
	};
}

function mount(): () => void {
	const restores = [
		installOnPrototype(TuiMainScreen.prototype as unknown as Proto, "main"),
		installOnPrototype(TuiAltScreen.prototype as unknown as Proto, "alt"),
	].filter((restore): restore is () => void => restore !== undefined);
	return () => {
		for (const restore of restores) restore();
	};
}

/**
 * Install the shared native-wrap bridge. Dispose releases one holder; the concrete
 * renderer prototypes are restored when the last holder goes away. Must be installed
 * after installSelectionMarkerStrip: the bridge parses the selection markers and then
 * calls the strip it captured, so the strip has to already wrap applyLineResets.
 */
export function installNativeTerminalWrap(): () => void {
	const state = (installs[installSlot] ??= { holders: 0 });
	if (state.holders === 0) state.restore = mount();
	state.holders += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		state.holders = Math.max(0, state.holders - 1);
		if (state.holders === 0) {
			state.restore?.();
			state.restore = undefined;
		}
	};
}
