// One owner for TuiAltScreen selection hooks. Markdown rendering and path-links
// both hold a reference; the prototype is patched once and restored when the
// last holder goes away. Path expansion is a separate expander so disabling
// path-links does not bring back whole-row table copies.

import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { installSelectionMarkerStrip } from "./selection-markers.ts";
import {
	planSelection,
	readStreamSelection,
	resolveHighlightColumns,
	type HighlightState,
	type SelectionBounds,
	type SelectionPoint,
} from "./selection-plan.ts";

interface LayoutNode {
	scrollView?: unknown;
	scrollContentLines?: readonly string[];
	rect?: { x: number; y: number };
	children?: LayoutNode[];
}

interface SelectionInternals {
	getSelectionBounds?: () => SelectionBounds | undefined;
	previousScreen?: string[];
	currentLayout?: { root: LayoutNode };
}

interface ColumnHost {
	getSelectionColumns: (
		line: string,
		row: number,
		selection: SelectionBounds,
		minColumn?: number,
		maxColumn?: number,
	) => { start: number; end: number };
	applySelection: (screen: string[], layout?: { root: LayoutNode }) => string[];
	getActiveSelectionText: () => string | undefined;
}

interface ContentFrame {
	lines: readonly string[];
	rowOffset: number;
	colOffset: number;
}

const installSlot = Symbol.for("mpep.selection-copy.install");
const planSlot = Symbol.for("mpep.selection-copy.plan");

interface InstallRecord {
	holders: number;
	restore?: () => void;
}

const installs = globalThis as unknown as Record<symbol, InstallRecord | undefined>;

function findScrollBox(box: LayoutNode, scrollView: unknown): LayoutNode | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children ?? []) {
		const found = findScrollBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

function selectionLines(internals: SelectionInternals, selection: SelectionBounds): readonly string[] | undefined {
	if (selection.start.scrollView && internals.currentLayout) {
		const box = findScrollBox(internals.currentLayout.root, selection.start.scrollView);
		if (box?.scrollContentLines) return box.scrollContentLines;
	}
	return internals.previousScreen;
}

function highlightFrame(
	internals: SelectionInternals,
	selection: SelectionBounds,
	layout: { root: LayoutNode } | undefined,
): ContentFrame | undefined {
	if (selection.start.scrollView) {
		const root = layout?.root ?? internals.currentLayout?.root;
		if (!root) return undefined;
		const box = findScrollBox(root, selection.start.scrollView);
		if (!box?.scrollContentLines || !box.rect) return undefined;
		const scrollTop = (selection.start.scrollView as { scrollTop?: number }).scrollTop ?? 0;
		return {
			lines: box.scrollContentLines,
			rowOffset: box.rect.y - scrollTop,
			colOffset: box.rect.x,
		};
	}
	if (!internals.previousScreen) return undefined;
	return { lines: internals.previousScreen, rowOffset: 0, colOffset: 0 };
}

function mount(): (() => void) | undefined {
	const proto = TuiAltScreen.prototype as unknown as ColumnHost;
	const originalText = proto.getActiveSelectionText;
	const originalColumns = proto.getSelectionColumns;
	const originalApply = proto.applySelection;
	if (
		typeof originalText !== "function" ||
		typeof originalColumns !== "function" ||
		typeof originalApply !== "function"
	) {
		return undefined;
	}

	const columnsOf = function (
		this: object,
		line: string,
		row: number,
		selection: SelectionBounds,
	): { start: number; end: number } {
		return originalColumns.call(this, line, row, selection);
	};

	const installedText = function (this: object): string | undefined {
		const internals = this as SelectionInternals;
		const selection = internals.getSelectionBounds?.();
		if (!selection) return originalText.call(this);
		const lines = selectionLines(internals, selection);
		if (!lines) return originalText.call(this);
		const plan = planSelection(lines, selection, columnsOf.bind(this));
		if (plan) {
			const text = plan.lines.join("\n");
			return text.length === 0 ? undefined : text;
		}
		return readStreamSelection(lines, selection, columnsOf.bind(this));
	};

	const installedColumns: ColumnHost["getSelectionColumns"] = function (
		this: object,
		line,
		row,
		selection,
		minColumn = 0,
		maxColumn = visibleWidth(line),
	) {
		const state = (this as Record<symbol, HighlightState | undefined>)[planSlot];
		if (!state) return originalColumns.call(this, line, row, selection, minColumn, maxColumn);
		return resolveHighlightColumns(state, row, minColumn, maxColumn, () =>
			originalColumns.call(this, line, row, selection, minColumn, maxColumn),
		);
	};

	const installedApply: ColumnHost["applySelection"] = function (this: object, screen, layout) {
		const internals = this as SelectionInternals;
		const selection = internals.getSelectionBounds?.();
		const frame = selection ? highlightFrame(internals, selection, layout) : undefined;
		const plan = frame && selection ? planSelection(frame.lines, selection, columnsOf.bind(this)) : null;
		const carrier = this as Record<symbol, HighlightState | undefined>;
		if (!plan || !frame) return originalApply.call(this, screen, layout);
		carrier[planSlot] = { highlight: plan.highlight, rowOffset: frame.rowOffset, colOffset: frame.colOffset };
		try {
			return originalApply.call(this, screen, layout);
		} finally {
			delete carrier[planSlot];
		}
	};

	proto.getActiveSelectionText = installedText;
	proto.getSelectionColumns = installedColumns;
	proto.applySelection = installedApply;
	// Markers have to stay out of the terminal even after the renderer is disabled,
	// because already-built lines can still be on screen for a frame.
	const releaseStrip = installSelectionMarkerStrip();

	return () => {
		releaseStrip();
		if (proto.getActiveSelectionText === installedText) proto.getActiveSelectionText = originalText;
		if (proto.getSelectionColumns === installedColumns) proto.getSelectionColumns = originalColumns;
		if (proto.applySelection === installedApply) proto.applySelection = originalApply;
	};
}

/** Install the shared selection hooks. Dispose releases one holder. */
export function installSelectionCopy(): () => void {
	const state = (installs[installSlot] ??= { holders: 0 });
	if (state.holders === 0) {
		const restore = mount();
		if (!restore) return () => {};
		state.restore = restore;
	}
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

export type { SelectionPoint };
