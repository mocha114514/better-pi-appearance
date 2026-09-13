import { InteractiveMode, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Minimal shape needed to find the cut: session entries already carry this. */
export interface PlacementEntry {
	type: string;
	id: string;
}

const patchSlot = Symbol.for("mpep.turn-fold.compaction-placement");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

/**
 * Pi prepends the latest compaction in buildContextEntries(). Live compaction_end
 * then slices that off and appends a banner at the cut. Session rebuild paints the
 * context list as-is, so the banner jumps to the start of the transcript.
 *
 * Reorder a context list back to chronological UI order: kept entries, compaction,
 * then entries that were recorded after the compaction.
 *
 * Lists that do not start with compaction are left untouched (the live path).
 */
export function placeCompactionAtCut<T extends PlacementEntry>(
	entries: readonly T[],
	branch: readonly PlacementEntry[],
): T[] | readonly T[] {
	const compaction = entries[0];
	if (!compaction || compaction.type !== "compaction") return entries;
	const cut = branch.findIndex((entry) => entry.id === compaction.id);
	if (cut < 0) return entries;
	const afterIds = new Set(branch.slice(cut + 1).map((entry) => entry.id));
	const kept: T[] = [];
	const after: T[] = [];
	for (const entry of entries.slice(1)) {
		if (afterIds.has(entry.id)) after.push(entry);
		else kept.push(entry);
	}
	return [...kept, compaction, ...after];
}

interface RenderHost {
	sessionManager?: { getBranch?: () => readonly PlacementEntry[] };
	renderSessionEntries(entries: SessionEntry[], options?: unknown): void;
}

/** Session surface needed to mirror the entry list Pi paints. */
export interface ContextSession {
	buildContextEntries(): SessionEntry[];
	getBranch(): readonly PlacementEntry[];
}

/**
 * Entries in the order Pi renders them, which is also the list fold state must follow.
 *
 * Pi prepends the latest compaction in buildContextEntries() and omits summarized history.
 * Folding from that list as-is anchors a kept tail's process on messages that are not on
 * screen, so the disclosure header never paints and the whole kept tail collapses to zero
 * visible lines. Ordering the list through the cut keeps every fold anchor on a rendered
 * message; on sessions without compactions this is exactly buildContextEntries().
 */
export function orderedSessionEntries(session: ContextSession): SessionEntry[] {
	return placeCompactionAtCut(session.buildContextEntries(), session.getBranch()) as SessionEntry[];
}

export function installCompactionPlacement(): () => void {
	patches[patchSlot]?.();
	const proto = InteractiveMode.prototype as unknown as RenderHost;
	const original = proto.renderSessionEntries;
	if (typeof original !== "function") return () => {};
	const installed = function (this: RenderHost, entries: SessionEntry[], options?: unknown): void {
		const branch = this.sessionManager?.getBranch?.() ?? [];
		original.call(this, placeCompactionAtCut(entries, branch) as SessionEntry[], options);
	};
	proto.renderSessionEntries = installed;
	const dispose = () => {
		if (proto.renderSessionEntries === installed) proto.renderSessionEntries = original;
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
