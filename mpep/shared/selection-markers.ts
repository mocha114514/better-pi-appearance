// Zero-width markers that tell selection copy which rendered columns belong to a
// table cell or to the inside of a code/math frame.
//
// Terminal selection is a stream: the middle rows of a drag are whole lines, so a
// table drag copies every column and a code-block drag copies the rounded border.
// The markers ride along in the rendered line (visibleWidth ignores OSC) and are
// stripped in applyLineResets before the frame is written. Clipboard text never
// keeps them either: stripTerminalSequences drops the OSC.

import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";

/** Shared prefix. Unknown OSC 777 is ignored by terminals if a marker ever leaks. */
export const SELECTION_MARKER_PREFIX = "\x1b]777;mpep;";

const stripSlot = Symbol.for("mpep.selection-markers.strip");
const installs = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export interface CellBox {
	/** Visible column, inclusive, relative to the marker. */
	start: number;
	/** Visible column, exclusive, relative to the marker. Padding belongs to the cell; the gap does not. */
	end: number;
}

export interface TableMarker {
	id: number;
	/** -1 on a rule line. Header is 0, body rows follow. */
	logicalRow: number;
	cells: CellBox[];
}

export interface FrameMarker {
	id: number;
	role: "top" | "body" | "bottom";
	left: number;
	right: number;
	frameWidth: number;
	src: number;
	part: number;
	partCount: number;
}

export interface ParsedMarkers {
	/** Visible column where the marker sits (after left padding and any leading SGR). */
	origin: number;
	table?: TableMarker;
	tableRows?: string[][];
	frame?: FrameMarker;
	frameSource?: string[];
}

export interface FramePiece {
	role: "top" | "body" | "bottom";
	line: string;
	left: number;
	right: number;
	src: number;
	part: number;
	partCount: number;
}

let nextBlockId = 1;

export function allocSelectionBlockId(): number {
	nextBlockId += 1;
	return nextBlockId;
}

function osc(payload: string): string {
	return `${SELECTION_MARKER_PREFIX}${payload}\x07`;
}

function encodeJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeJson(value: string): unknown {
	return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function asStringMatrix(value: unknown): string[][] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rows: string[][] = [];
	for (const row of value) {
		if (!Array.isArray(row) || row.some((cell) => typeof cell !== "string")) return undefined;
		rows.push(row as string[]);
	}
	return rows;
}

function asStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
	return value as string[];
}

/** Prefix a rendered table line. `rows` is the original cell text, attached once per table. */
export function markTableLine(
	line: string,
	id: number,
	logicalRow: number,
	cells: readonly CellBox[],
	rows?: readonly (readonly string[])[],
): string {
	const geometry = osc(`t|${id}|${logicalRow}|${cells.map((cell) => `${cell.start}.${cell.end}`).join("|")}`);
	const data = rows ? osc(`d|${id}|${encodeJson(rows)}`) : "";
	return geometry + data + line;
}

/**
 * Mark a rounded frame (code block or math card).
 * `sourceLines` is the unwrapped text, one entry per source line, so a multi-line
 * copy can put soft-wrapped visual lines back together when the line is fully selected.
 */
export function decorateFrame(pieces: readonly FramePiece[], frameWidth: number, sourceLines?: readonly string[]): string[] {
	const id = allocSelectionBlockId();
	const source = sourceLines ? osc(`s|${id}|${encodeJson(sourceLines)}`) : "";
	return pieces.map((piece, index) => {
		const role = piece.role === "body" ? "b" : piece.role === "bottom" ? "u" : "t";
		const geometry = osc(
			`f|${id}|${role}|${piece.left}|${piece.right}|${frameWidth}|${piece.src}|${piece.part}|${piece.partCount}`,
		);
		return geometry + (index === 0 ? source : "") + piece.line;
	});
}

export function stripSelectionMarkers(value: string): string {
	if (!value.includes(SELECTION_MARKER_PREFIX)) return value;
	return value.replace(/\x1b\]777;mpep;[^\x07]*\x07/g, "");
}

function applyPayload(parsed: ParsedMarkers, payload: string): void {
	const bits = payload.split("|");
	const kind = bits[0];
	if (kind === "t") {
		const id = Number.parseInt(bits[1] ?? "", 10);
		const logicalRow = Number.parseInt(bits[2] ?? "", 10);
		if (!Number.isFinite(id) || !Number.isFinite(logicalRow)) return;
		const cells: CellBox[] = [];
		for (const spec of bits.slice(3)) {
			if (!spec) continue;
			const [startText, endText] = spec.split(".");
			const start = Number.parseInt(startText ?? "", 10);
			const end = Number.parseInt(endText ?? "", 10);
			if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
			cells.push({ start, end });
		}
		parsed.table = { id, logicalRow, cells };
		return;
	}
	if (kind === "d") {
		const id = Number.parseInt(bits[1] ?? "", 10);
		if (!Number.isFinite(id)) return;
		try {
			const rows = asStringMatrix(decodeJson(bits.slice(2).join("|")));
			if (!rows || (parsed.table && parsed.table.id !== id)) return;
			parsed.tableRows = rows;
		} catch {
			// Ignore a damaged payload and let copy fall back to the visible line.
		}
		return;
	}
	if (kind === "s") {
		try {
			const source = asStringList(decodeJson(bits.slice(2).join("|")));
			if (source) parsed.frameSource = source;
		} catch {
			// Same fallback as table data: visual slices still work.
		}
		return;
	}
	if (kind === "f") {
		const id = Number.parseInt(bits[1] ?? "", 10);
		const left = Number.parseInt(bits[3] ?? "", 10);
		const right = Number.parseInt(bits[4] ?? "", 10);
		const frameWidth = Number.parseInt(bits[5] ?? "", 10);
		const src = Number.parseInt(bits[6] ?? "", 10);
		const part = Number.parseInt(bits[7] ?? "", 10);
		const partCount = Number.parseInt(bits[8] ?? "", 10);
		if ([id, left, right, frameWidth, src, part, partCount].some((value) => !Number.isFinite(value))) return;
		const role = bits[2] === "b" ? "body" : bits[2] === "u" ? "bottom" : "top";
		parsed.frame = { id, role, left, right, frameWidth, src, part, partCount };
	}
}

export function parseSelectionMarkers(line: string): ParsedMarkers {
	const parsed: ParsedMarkers = { origin: 0 };
	if (!line.includes(SELECTION_MARKER_PREFIX)) return parsed;
	const markerAt = line.indexOf(SELECTION_MARKER_PREFIX);
	parsed.origin = markerAt <= 0 ? 0 : visibleWidth(line.slice(0, markerAt));
	for (const match of line.matchAll(/\x1b\]777;mpep;([^\x07]*)\x07/g)) {
		applyPayload(parsed, match[1] ?? "");
	}
	return parsed;
}

interface ResetHost {
	applyLineResets: (lines: string[]) => string[];
}

function ownerOf(proto: object, method: string): ResetHost | undefined {
	let current: object | null = proto;
	while (current) {
		if (Object.prototype.hasOwnProperty.call(current, method)) return current as ResetHost;
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

/**
 * Remove markers after selection highlighting and before the frame hits the terminal.
 * applySelection runs first, so the highlighter still sees the markers.
 */
export function installSelectionMarkerStrip(): () => void {
	installs[stripSlot]?.();
	const host = ownerOf(TuiAltScreen.prototype, "applyLineResets");
	const original = host?.applyLineResets;
	if (!host || typeof original !== "function") return () => {};

	const installed: ResetHost["applyLineResets"] = function (this: unknown, lines) {
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (line?.includes(SELECTION_MARKER_PREFIX)) lines[index] = stripSelectionMarkers(line);
		}
		return original.call(this, lines);
	};
	host.applyLineResets = installed;

	const dispose = () => {
		if (host.applyLineResets === installed) host.applyLineResets = original;
		if (installs[stripSlot] === dispose) delete installs[stripSlot];
	};
	installs[stripSlot] = dispose;
	return dispose;
}
