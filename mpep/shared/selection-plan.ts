// Turn a terminal stream selection into table-cell or code-frame clipboard text,
// and into the highlight ranges that match that text.
//
// Stream selection copies the whole middle row. Inside a table that includes
// columns the pointer never touched; inside a code block it includes the border.
// Both are fixed here, and only here: a drag that also covers ordinary prose keeps
// the stream, so selecting a paragraph does not suddenly drop table columns.

import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
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

type CopyPiece = { kind: "line"; text: string } | FramePieceCopy;

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

function planTable(lines: readonly string[], rows: readonly RowRef[], selection: SelectionBounds): SelectionPlan | null {
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
	const highlight = new Map<number, HighlightAction>();
	const copied: string[] = [];
	const seenRows = new Set<number>();
	const firstCol = cols[0] ?? 0;
	const lastCol = cols[cols.length - 1] ?? firstCol;

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
		highlight.set(row.row, {
			kind: "span",
			start: row.parsed.origin + first.start,
			end: row.parsed.origin + last.end,
		});
		if (seenRows.has(marker.logicalRow)) continue;
		seenRows.add(marker.logicalRow);
		const source = payload?.[marker.logicalRow];
		if (source) {
			copied.push(cols.map((index) => plainCell(source[index] ?? "")).join("\t"));
			continue;
		}
		const visual = cols.map((index) => {
			const cell = marker.cells[index];
			if (!cell) return "";
			return plainCell(sliceByColumn(row.line, row.parsed.origin + cell.start, cell.end - cell.start, true));
		});
		copied.push(visual.join("\t"));
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

function planFrame(
	lines: readonly string[],
	rows: readonly RowRef[],
	selection: SelectionBounds,
	columns: ColumnFn,
): SelectionPlan | null {
	if (selection.end.row <= selection.start.row) return null;
	if (!rows.some((row) => row.parsed.frame)) return null;

	const highlight = new Map<number, HighlightAction>();
	const pieces: CopyPiece[] = [];
	for (const row of rows) {
		const frame = row.parsed.frame;
		const inner = frameInner(row.parsed);
		if (!frame || !inner) {
			if (frame) highlight.set(row.row, { kind: "none" });
			else pieces.push({ kind: "line", text: streamCopy(row.line, row.row, selection, columns) });
			continue;
		}
		const stream = columns(row.line, row.row, selection);
		const start = Math.max(stream.start, inner.start);
		const end = Math.min(stream.end, inner.end);
		if (end <= start) {
			highlight.set(row.row, { kind: "none" });
			continue;
		}
		highlight.set(row.row, { kind: "span", start, end });
		pieces.push({
			kind: "frame",
			row: row.row,
			id: frame.id,
			src: frame.src,
			part: frame.part,
			partCount: frame.partCount,
			full: stream.start <= inner.start && stream.end >= inner.end,
			slice: expandCopiedText(sliceByColumn(row.line, start, end - start, true)).trimEnd(),
		});
	}

	return { highlight, lines: collapseFramePieces(lines, pieces) };
}

function groupIsComplete(group: readonly FramePieceCopy[], source: string[] | undefined): boolean {
	const first = group[0];
	if (!first || !source || source.length <= first.src || group.length !== first.partCount) return false;
	return group.every(
		(piece, index) => piece.full && piece.part === index && piece.src === first.src && piece.id === first.id,
	);
}

function collapseFramePieces(lines: readonly string[], pieces: readonly CopyPiece[]): string[] {
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

	const collapsed: string[] = [];
	let index = 0;
	while (index < pieces.length) {
		const piece = pieces[index];
		if (!piece || piece.kind === "line") {
			collapsed.push(piece?.kind === "line" ? piece.text : "");
			index += 1;
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
	return planTable(lines, rows, selection) ?? planFrame(lines, rows, selection, columns);
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
