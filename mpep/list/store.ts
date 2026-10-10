import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isComplete, parseListState, type ListState } from "./model.ts";

export const LIST_STATE_ENTRY = "mpep.list.state.v1";
type SessionReader = Pick<ExtensionContext["sessionManager"], "getEntries">;

/** The session log is authoritative; the UI is only a projection of this state. */
export class ListStore {
	private value: ListState | undefined;
	private problem: Error | undefined;
	private readonly persist: (state: ListState) => void;
	private readonly changed: () => void;

	constructor(persist: (state: ListState) => void, changed: () => void) {
		this.persist = persist;
		this.changed = changed;
	}

	restore(session: SessionReader): void {
		this.value = undefined;
		this.problem = undefined;
		// The checklist belongs to the session, not a transcript position. Browsing
		// an earlier /tree leaf must not undo work or hide an unfinished checklist.
		const entry = session.getEntries().findLast(candidate =>
			candidate.type === "custom" && candidate.customType === LIST_STATE_ENTRY,
		);
		if (entry?.type === "custom") {
			try {
				this.value = parseListState(entry.data);
			} catch (error) {
				this.problem = new Error(`The saved checklist is invalid: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.changed();
	}

	read(): ListState | undefined {
		if (this.problem) throw this.problem;
		return this.value;
	}

	commit(next: ListState): void {
		const previous = this.read();
		if (next === previous) return;
		if (previous && next.id !== previous.id && !isComplete(previous)) {
			throw new Error("Cannot replace the checklist while it still contains unfinished items.");
		}
		// Do not acknowledge success or repaint a mutation whose persistence failed.
		this.persist(next);
		this.value = next;
		this.changed();
	}
}
