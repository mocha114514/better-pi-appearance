export interface TurnAnchor {
	readonly key: number;
	readonly row: number;
	readonly text: string;
}

/** Columns occupied by the right-side turn rail. Matches the single-cell ─ / ═ markers. */
export const NAVIGATOR_COLUMNS = 1;

/**
 * Rows a complete marker list needs: one line per turn plus the top/bottom arrows.
 * Zero markers means "no lower bound" so an empty index keeps the default band.
 */
function bandRows(count: number): number {
	return count > 0 ? count + 2 : 0;
}

/**
 * Vertical slice of the transcript viewport occupied by the rail.
 *
 * Few turns: the middle-lower half of the viewport, unchanged. From the point where
 * every marker already has its own line, the band grows one row per extra turn so the
 * markers stay individually clickable, up to the whole viewport height; only past that
 * limit does markerRows() window the list and the wheel take over.
 */
export function navigationBand(viewportHeight: number, markerCount = 0): { top: number; height: number } {
	const available = Math.max(0, Math.floor(viewportHeight));
	const base = Math.min(available, Math.max(3, Math.round(available * 0.5)));
	const height = Math.max(base, Math.min(available, bandRows(markerCount)));
	// Grow around the default band's centre so the rail stretches symmetrically towards
	// both edges and covers the whole viewport once the growth is complete.
	const center = base / 2 + Math.min(Math.floor(available * 0.3), available - base);
	return { top: Math.round(Math.max(0, Math.min(center - height / 2, available - height))), height };
}

/**
 * Index of the turn owning the viewport's focus line.
 *
 * The focus line sits at the vertical middle of the viewport, so a turn becomes
 * active as soon as its header enters the upper half of the screen (matches the
 * intuitive "the turn I am looking at" feeling, and lights up the streaming turn
 * much earlier than a top-edge rule). With viewportHeight = 0 the focus line
 * degenerates to the viewport top edge (legacy behavior).
 */
export function activeTurn(anchors: readonly TurnAnchor[], scrollTop: number, viewportHeight = 0): number {
	if (anchors.length === 0) return -1;
	const focus = scrollTop + Math.floor(Math.max(0, viewportHeight) / 2);
	let low = 0;
	let high = anchors.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (anchors[middle].row <= focus) low = middle + 1;
		else high = middle;
	}
	return Math.max(0, low - 1);
}

export function markerRows(count: number, height: number, start = 0): Map<number, number> {
	const slots = Math.max(0, height - 2);
	const visible = Math.min(count, slots);
	const first = Math.max(0, Math.min(start, count - visible));
	const result = new Map<number, number>();
	for (let index = 0; index < visible; index++) {
		const row = visible === 1 ? 1 + Math.floor((slots - 1) / 2) : 1 + Math.round((index * (slots - 1)) / (visible - 1));
		result.set(row, first + index);
	}
	return result;
}

export function sameAnchors(left: readonly TurnAnchor[], right: readonly TurnAnchor[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => {
			const other = right[index];
			return item.key === other.key && item.row === other.row && item.text === other.text;
		})
	);
}
