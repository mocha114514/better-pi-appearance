// Turn a terminal stream selection into table-cell, code-frame, or rejoined-prose
// clipboard text, and into the highlight ranges that match that text.
//
// Stream selection copies the whole middle row. Inside a table that includes
// columns the pointer never touched; inside a code block it includes the border;
// inside prose it keeps the terminal's soft wraps as hard newlines. All three are
// fixed here, and only here: a drag that also covers ordinary unmarked lines keeps
// the stream for those lines, so selecting a paragraph does not suddenly drop
// table columns.

import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	SELECTION_MARKER_PREFIX,
	parseSelectionMarkers,
	stripSelectionMarkers,
	type CellBox,
	type ParsedMarkers,
} from "./selection-markers.ts";

const EXPANDER = Symbol.for("mpep.selection-copy.expander");
const expanders = globalThis as unknown as Record<symbol, ((value: string) => string) | undefined>;

export interface SelectionPoint {
	row: number;
	col: number;
	boundary?: boolean;
	scrollView?: unknown;
}

export interface SelectionBounds {
	start: SelectionPoint;
	end: SelectionPoint;
}

export type ColumnFn = (
	line: string,
	row: number,
	selection: SelectionBounds,
) => { start: number; end: number };

export type HighlightAction =
	| { kind: "stream" }
	| { kind: "none" }
	| { kind: "span"; start: number; end: number };

export interface SelectionPlan {
	highlight: Map<number, HighlightAction>;
	lines: string[];
}

export interface HighlightState {
	highlight: Map<number, HighlightAction>;
	rowOffset: number;
	colOffset: number;
}

/** path-links installs an expander; everyone else just strips ANSI and markers. */
export function setCopiedTextExpander(expand: ((value: string) => string) | null): void {
	if (expand) expanders[EXPANDER] = expand;
	else delete expanders[EXPANDER];
}

export function expandCopiedText(value: string): string {
	return (expanders[EXPANDER] ?? stripTerminalSequences)(value);
}

interface RowRef {
	row: number;
	line: string;
	parsed: ParsedMarkers;
}

interface FramePieceCopy {
	kind: "frame";
	row: number;
	id: number;
	src: number;
	part: number;
	partCount: number;
	full: boolean;
	slice: string;
}

interface WrapPieceCopy {
	kind: "wrap";
	row: number;
	id: number;
	part: number;
	partCount: number;
	full: boolean;
	slice: string;
}

type CopyPiece = { kind: "line"; text: string } | FramePieceCopy | WrapPieceCopy;

function isBlankLine(line: string): boolean {
	return stripSelectionMarkers(line).trim() === "";
}

function includedEdge(point: SelectionPoint): number {
	// A boundary endpoint is the column just after the last included cell.
	return point.boundary ? point.col - 1 : point.col;
}

function horizontalSpan(selection: SelectionBounds): { left: number; right: number } | undefined {
	const left = Math.min(includedEdge(selection.start), includedEdge(selection.end));
	const right = Math.max(includedEdge(selection.start), includedEdge(selection.end));
	if (right < left) return undefined;
	return { left, right };
}

function cellsTouched(cells: readonly CellBox[], left: number, right: number): number[] {
	if (cells.length === 0) return [];
	const hits: number[] = [];
	for (let index = 0; index < cells.length; index++) {
		const cell = cells[index];
		if (!cell) continue;
		if (cell.start <= right && cell.end > left) hits.push(index);
	}
	if (hits.length > 0) return hits;
	const midpoint = (left + right) / 2;
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < cells.length; index++) {
		const cell = cells[index];
		if (!cell) continue;
		const center = (cell.start + cell.end - 1) / 2;
		const distance = Math.abs(center - midpoint);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = index;
		}
	}
	return [best];
}

function streamCopy(line: string, row: number, selection: SelectionBounds, columns: ColumnFn): string {
	const range = columns(line, row, selection);
	const width = Math.max(0, range.end - range.start);
	return expandCopiedText(sliceByColumn(line, range.start, width, true)).trimEnd();
}

function plainCell(value: string): string {
	return expandCopiedText(value).replace(/\t/g, " ").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

function findMarkedAbove(
	lines: readonly string[],
	fromRow: number,
	accept: (parsed: ParsedMarkers) => boolean,
): ParsedMarkers | undefined {
	for (let row = fromRow; row >= 0; row--) {
		const line = lines[row] ?? "";
		if (!line.includes(SELECTION_MARKER_PREFIX)) {
			if (line.trim() === "") continue;
			return undefined;
		}
		const parsed = parseSelectionMarkers(line);
		if (accept(parsed)) return parsed;
	}
	return undefined;
}

/** One selected visual row of a table plus the native column range the pointer earned on it. */
interface SelectedTableRow {
	row: RowRef;
	native: { start: number; end: number };
}

/**
 * Whether `native` contains the whole visible content of `cell` on one visual row.
 * Cell boxes are sized from the column width, so they include trailing padding; a
 * pointer that stops on the last real character leaves that padding unselected.
 * Trimming both slices keeps a padding-only gap from defeating the full-payload copy.
 */
function cellContentCovered(
	line: string,
	native: { start: number; end: number },
	origin: number,
	cell: CellBox,
): boolean {
	const boxStart = origin + cell.start;
	const boxEnd = origin + cell.end;
	if (native.start > boxStart) return false;
	const clipEnd = Math.min(native.end, boxEnd);
	const fragment = clipEnd > boxStart ? plainCell(sliceByColumn(line, boxStart, clipEnd - boxStart, true)) : "";
	const whole = plainCell(sliceByColumn(line, boxStart, boxEnd - boxStart, true));
	return fragment === whole;
}

/** The visible characters of one cell that `native` actually covers on a visual row. */
function cellFragment(
	line: string,
	native: { start: number; end: number },
	origin: number,
	cell: CellBox,
): string {
	const start = Math.max(native.start, origin + cell.start);
	const end = Math.min(native.end, origin + cell.end);
	if (end <= start) return "";
	return plainCell(sliceByColumn(line, start, end - start, true));
}

/**
 * Completeness of one logical table row for a drag: true only when no part of the row
 * sits outside the selected visual rows. The renderer emits a logical row's visual rows
 * consecutively, so the check stays local: the entry count must match the selected span
 * (a cheap defensive contiguity guard), and neither neighbour may carry the same table id
 * and logical row. That keeps a partial drag on a very tall wrapped cell O(1) instead of
 * walking the whole cell.
 */
function logicalRowComplete(
	lines: readonly string[],
	tableId: number,
	logicalRow: number,
	firstSelected: number,
	lastSelected: number,
	entryCount: number,
): boolean {
	if (entryCount !== lastSelected - firstSelected + 1) return false;
	const sameLogicalRow = (row: number): boolean => {
		if (row < 0 || row >= lines.length) return false;
		const marker = parseSelectionMarkers(lines[row] ?? "").table;
		return !!marker && marker.id === tableId && marker.logicalRow === logicalRow;
	};
	return !sameLogicalRow(firstSelected - 1) && !sameLogicalRow(lastSelected + 1);
}

function planTable(
	lines: readonly string[],
	rows: readonly RowRef[],
	selection: SelectionBounds,
	columns: ColumnFn,
): SelectionPlan | null {
	let tableId: number | undefined;
	for (const row of rows) {
		if (isBlankLine(row.line)) continue;
		const table = row.parsed.table;
		if (!table) return null;
		if (tableId === undefined) tableId = table.id;
		else if (tableId !== table.id) return null;
	}
	if (tableId === undefined) return null;

	const sample = rows.find((row) => row.parsed.table?.id === tableId && row.parsed.table.cells.length > 0);
	const table = sample?.parsed.table;
	const span = horizontalSpan(selection);
	if (!sample || !table || !span) return null;

	const cols = cellsTouched(table.cells, span.left - sample.parsed.origin, span.right - sample.parsed.origin);
	if (cols.length === 0) return null;
	// A single line that stays inside one cell keeps the characters the user actually dragged.
	if (selection.start.row === selection.end.row && cols.length <= 1) return null;

	const payload = findMarkedAbove(
		lines,
		selection.start.row,
		(parsed) => parsed.table?.id === tableId && parsed.tableRows !== undefined,
	)?.tableRows;
	const firstCol = cols[0] ?? 0;
	const lastCol = cols[cols.length - 1] ?? firstCol;

	const highlight = new Map<number, HighlightAction>();
	const groups: Array<{ logicalRow: number; entries: SelectedTableRow[]; covered: boolean }> = [];
	const groupByLogical = new Map<number, (typeof groups)[number]>();

	for (const row of rows) {
		const marker = row.parsed.table;
		if (!marker || marker.id !== tableId || marker.logicalRow < 0) {
			highlight.set(row.row, { kind: "none" });
			continue;
		}
		const first = marker.cells[firstCol];
		const last = marker.cells[lastCol];
		if (!first || !last) {
			highlight.set(row.row, { kind: "none" });
			continue;
		}
		// Highlight and copy both stop where the pointer stopped: the native per-row
		// range is clipped to the first..last selected cell.
		const native = columns(row.line, row.row, selection);
		const blockStart = row.parsed.origin + first.start;
		const blockEnd = row.parsed.origin + last.end;
		const clipStart = Math.max(native.start, blockStart);
		const clipEnd = Math.min(native.end, blockEnd);
		highlight.set(row.row, clipEnd > clipStart ? { kind: "span", start: clipStart, end: clipEnd } : { kind: "none" });

		let covered = true;
		for (const index of cols) {
			const cell = marker.cells[index];
			if (!cell || !cellContentCovered(row.line, native, row.parsed.origin, cell)) covered = false;
		}

		let group = groupByLogical.get(marker.logicalRow);
		if (!group) {
			group = { logicalRow: marker.logicalRow, entries: [], covered: true };
			groupByLogical.set(marker.logicalRow, group);
			groups.push(group);
		}
		group.entries.push({ row, native });
		group.covered = group.covered && covered;
	}

	const copied: string[] = [];
	for (const group of groups) {
		// A logical row is complete only when every one of its visual rows is inside the
		// drag. logicalRowComplete only inspects the neighbouring rows, so a partially
		// covered wrapped cell cannot borrow text from rows outside the pointer.
		const firstRow = group.entries[0]?.row.row ?? 0;
		const lastRow = group.entries[group.entries.length - 1]?.row.row ?? firstRow;
		const complete =
			group.covered && logicalRowComplete(lines, tableId, group.logicalRow, firstRow, lastRow, group.entries.length);
		const source = payload?.[group.logicalRow];
		// The logical payload holds the original cell text (real spacing, unwrapped
		// content). It may only stand in once every visual row and every selected cell
		// is covered, so it can never smuggle in text the pointer did not cross.
		if (complete && source) {
			copied.push(cols.map((index) => plainCell(source[index] ?? "")).join("\t"));
			continue;
		}
		// Otherwise copy exactly the visible cells the pointer covered. Partial wrap
		// rows stay separate: no dedupe, and no text from rows outside the drag.
		for (const entry of group.entries) {
			const marker = entry.row.parsed.table;
			const fields = cols.map((index) => {
				const cell = marker?.cells[index];
				return cell ? cellFragment(entry.row.line, entry.native, entry.row.parsed.origin, cell) : "";
			});
			copied.push(fields.join("\t"));
		}
	}

	// A drag that only touched rules has no cell to snap to; keep the glyphs the user selected.
	if (copied.length === 0) return null;
	return { highlight, lines: copied };
}

/** Stream copy used when no table or code frame claims the selection. */
export function readStreamSelection(
	lines: readonly string[],
	selection: SelectionBounds,
	columns: ColumnFn,
): string | undefined {
	if (selection.end.row < selection.start.row) return undefined;
	const copied: string[] = [];
	for (let row = selection.start.row; row <= selection.end.row; row++) {
		copied.push(streamCopy(lines[row] ?? "", row, selection, columns));
	}
	const text = copied.join("\n");
	return text.length === 0 ? undefined : text;
}

function frameInner(parsed: ParsedMarkers): { start: number; end: number } | undefined {
	const frame = parsed.frame;
	if (!frame || frame.role !== "body" || frame.frameWidth <= 0) return undefined;
	const start = parsed.origin + frame.left;
	const end = parsed.origin + frame.frameWidth - frame.right;
	if (end <= start) return undefined;
	return { start, end };
}

/** Visible column just after the last non-padding character. Margins sit left of the marker, so this is measured from column 0. */
function wrapContentEnd(line: string): number {
	return visibleWidth(stripTerminalSequences(stripSelectionMarkers(line)).trimEnd());
}

/** Indent, list marker, or quote border that renderers place before the wrap marker. */
function wrapPrefix(line: string): string {
	const markerAt = line.indexOf(SELECTION_MARKER_PREFIX);
	if (markerAt <= 0) return "";
	return stripTerminalSequences(line.slice(0, markerAt));
}

function planBlocks(
	lines: readonly string[],
	rows: readonly RowRef[],
	selection: SelectionBounds,
	columns: ColumnFn,
): SelectionPlan | null {
	if (selection.end.row <= selection.start.row) return null;
	if (!rows.some((row) => row.parsed.frame || row.parsed.wrap)) return null;

	const highlight = new Map<number, HighlightAction>();
	const pieces: CopyPiece[] = [];
	for (const row of rows) {
		const frame = row.parsed.frame;
		const inner = frameInner(row.parsed);
		if (frame && !inner) {
			highlight.set(row.row, { kind: "none" });
			continue;
		}
		if (frame && inner) {
			const stream = columns(row.line, row.row, selection);
			const start = Math.max(stream.start, inner.start);
			const end = Math.min(stream.end, inner.end);
			if (end <= start) {
				highlight.set(row.row, { kind: "none" });
				continue;
			}
			highlight.set(row.row, { kind: "span", start, end });
			const slice = expandCopiedText(sliceByColumn(row.line, start, end - start, true)).trimEnd();
			const full = stream.start <= inner.start && stream.end >= inner.end;
			// Prose inside a bubble or other frame still rejoins, but the slice stays
			// inside the border. The frame marker is the line prefix, so the wrap
			// payload must not pick the bars back up.
			const wrap = row.parsed.wrap;
			if (wrap) {
				pieces.push({
					kind: "wrap",
					row: row.row,
					id: wrap.id,
					part: wrap.part,
					partCount: wrap.partCount,
					full,
					slice,
				});
				continue;
			}
			pieces.push({
				kind: "frame",
				row: row.row,
				id: frame.id,
				src: frame.src,
				part: frame.part,
				partCount: frame.partCount,
				full,
				slice,
			});
			continue;
		}
		const wrap = row.parsed.wrap;
		if (!wrap) {
			pieces.push({ kind: "line", text: streamCopy(row.line, row.row, selection, columns) });
			continue;
		}
		// Wrap rows keep the stream highlight; only the clipboard text changes.
		const stream = columns(row.line, row.row, selection);
		pieces.push({
			kind: "wrap",
			row: row.row,
			id: wrap.id,
			part: wrap.part,
			partCount: wrap.partCount,
			full: stream.start <= row.parsed.origin && stream.end >= wrapContentEnd(row.line),
			slice: streamCopy(row.line, row.row, selection, columns),
		});
	}

	return { highlight, lines: collapsePieces(lines, pieces) };
}

/**
 * A one-row drag normally stays a stream slice, which is what a partial code
 * line needs. Frame chrome is the exception: a drag that runs into the border
 * still copies only the inside. A drag already inside the frame returns null.
 */
function planSingleFrameRow(
	lines: readonly string[],
	selection: SelectionBounds,
	columns: ColumnFn,
): SelectionPlan | null {
	if (selection.start.row !== selection.end.row) return null;
	const row = selection.start.row;
	const line = lines[row] ?? "";
	const parsed = parseSelectionMarkers(line);
	const inner = frameInner(parsed);
	if (!parsed.frame || !inner) return null;
	const stream = columns(line, row, selection);
	if (stream.start >= inner.start && stream.end <= inner.end) return null;
	const start = Math.max(stream.start, inner.start);
	const end = Math.min(stream.end, inner.end);
	const highlight = new Map<number, HighlightAction>();
	if (end <= start) {
		highlight.set(row, { kind: "none" });
		return { highlight, lines: [] };
	}
	highlight.set(row, { kind: "span", start, end });
	const wrap = parsed.wrap;
	const coversInside = stream.start <= inner.start && stream.end >= inner.end;
	if (wrap && coversInside && wrap.part === 0 && wrap.partCount === 1 && parsed.wrapText !== undefined) {
		return { highlight, lines: [expandCopiedText(parsed.wrapText).replace(/\r$/, "")] };
	}
	return {
		highlight,
		lines: [expandCopiedText(sliceByColumn(line, start, end - start, true)).trimEnd()],
	};
}

function groupIsComplete(group: readonly FramePieceCopy[], source: string[] | undefined): boolean {
	const first = group[0];
	if (!first || !source || source.length <= first.src || group.length !== first.partCount) return false;
	return group.every(
		(piece, index) => piece.full && piece.part === index && piece.src === first.src && piece.id === first.id,
	);
}

function collapsePieces(lines: readonly string[], pieces: readonly CopyPiece[]): string[] {
	const sources = new Map<number, string[] | undefined>();
	const sourceFor = (piece: FramePieceCopy): string[] | undefined => {
		const cached = sources.get(piece.id);
		if (cached !== undefined || sources.has(piece.id)) return cached;
		const found = findMarkedAbove(
			lines,
			piece.row,
			(parsed) => parsed.frame?.id === piece.id && parsed.frameSource !== undefined,
		)?.frameSource;
		sources.set(piece.id, found);
		return found;
	};
	const wrapTexts = new Map<number, string | undefined>();
	const wrapTextFor = (piece: WrapPieceCopy): string | undefined => {
		const cached = wrapTexts.get(piece.id);
		if (cached !== undefined || wrapTexts.has(piece.id)) return cached;
		// Parts of one logical line are consecutive rows sharing the id; stop at the first
		// row that belongs to something else instead of scanning the whole document.
		let found: string | undefined;
		for (let row = piece.row; row >= 0; row--) {
			const line = lines[row] ?? "";
			if (!line.includes(SELECTION_MARKER_PREFIX)) break;
			const parsed = parseSelectionMarkers(line);
			if (parsed.wrap?.id !== piece.id) break;
			if (parsed.wrapText !== undefined) {
				found = parsed.wrapText;
				break;
			}
		}
		wrapTexts.set(piece.id, found);
		return found;
	};

	const collapsed: string[] = [];
	let index = 0;
	while (index < pieces.length) {
		const piece = pieces[index];
		if (!piece || piece.kind === "line") {
			collapsed.push(piece?.kind === "line" ? piece.text : "");
			index += 1;
			continue;
		}
		if (piece.kind === "wrap") {
			const group: WrapPieceCopy[] = [piece];
			index += 1;
			while (index < pieces.length) {
				const next = pieces[index];
				if (!next || next.kind !== "wrap" || next.id !== piece.id) break;
				group.push(next);
				index += 1;
			}
			const text = wrapTextFor(piece);
			const complete =
				text !== undefined &&
				group.length === piece.partCount &&
				group.every((part, partIndex) => part.full && part.part === partIndex);
			if (complete) {
				// Keep the first visual line's prefix (list bullet, quote border, padding) once;
				// continuation lines repeat only indent, which the payload already replaces.
				// A frame around the wrap (user bubble, code card) owns that prefix; its
				// bars are not part of the logical text.
				const head = lines[group[0]?.row ?? -1] ?? "";
				const prefix = parseSelectionMarkers(head).frame ? "" : wrapPrefix(head);
				collapsed.push(expandCopiedText(prefix + text).replace(/\r$/, ""));
				continue;
			}
			for (const part of group) collapsed.push(part.slice);
			continue;
		}
		const group: FramePieceCopy[] = [piece];
		index += 1;
		while (index < pieces.length) {
			const next = pieces[index];
			if (!next || next.kind !== "frame" || next.id !== piece.id || next.src !== piece.src) break;
			group.push(next);
			index += 1;
		}
		const source = sourceFor(piece);
		if (groupIsComplete(group, source) && source) {
			collapsed.push(expandCopiedText(source[piece.src] ?? "").replace(/\r$/, ""));
			continue;
		}
		for (const part of group) collapsed.push(part.slice);
	}
	return collapsed;
}

/**
 * Returns null when the selection should keep the normal stream copy.
 * A non-null plan is the whole clipboard (already expanded and trimmed) plus
 * one highlight instruction per content row.
 */
export function planSelection(
	lines: readonly string[],
	selection: SelectionBounds,
	columns: ColumnFn,
): SelectionPlan | null {
	if (selection.end.row < selection.start.row) return null;
	const rows: RowRef[] = [];
	let sawMarker = false;
	for (let row = selection.start.row; row <= selection.end.row; row++) {
		const line = lines[row] ?? "";
		if (line.includes(SELECTION_MARKER_PREFIX)) sawMarker = true;
		rows.push({ row, line, parsed: parseSelectionMarkers(line) });
	}
	if (!sawMarker) return null;
	return (
		planTable(lines, rows, selection, columns) ??
		planBlocks(lines, rows, selection, columns) ??
		planSingleFrameRow(lines, selection, columns)
	);
}

export function resolveHighlightColumns(
	state: HighlightState,
	screenRow: number,
	minColumn: number,
	maxColumn: number,
	fallback: () => { start: number; end: number },
): { start: number; end: number } {
	const action = state.highlight.get(screenRow - state.rowOffset);
	if (!action || action.kind === "stream") return fallback();
	if (action.kind === "none") return { start: minColumn, end: minColumn };
	const start = Math.max(minColumn, action.start + state.colOffset);
	const end = Math.min(maxColumn, action.end + state.colOffset);
	return { start, end: Math.max(start, end) };
}
