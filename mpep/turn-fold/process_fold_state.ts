import type { ProcessFoldState, MessageState } from "./extension_types.ts";

const processes = new Set<ProcessFoldState>();
const pending = new Set<ProcessFoldState>();
let active: ProcessFoldState | undefined;

export function registerProcessFoldMessage(message: MessageState): void {
	if (message.process) return;
	if (!active) {
		active = { messages: [], expanded: false };
		processes.add(active);
		pending.add(active);
	}
	active.messages.push(message);
	message.process = active;
}

/** A user/custom message is a visible boundary, even when queued within one agent run. */
export function separateProcessFold(): void {
	active = undefined;
}

function trailingAnswerIndex(last: MessageState): number {
	// Only a clean stop keeps a final answer outside the disclosure.
	// Abort/error/length/toolUse hide every part, including any that arrive after this seal.
	if (last.message.stopReason !== "stop") return Number.MAX_SAFE_INTEGER;
	let index = last.parts.length;
	while (index > 0 && last.parts[index - 1].type === "text") index--;
	return index;
}

function foldAnchor(process: ProcessFoldState, last: MessageState, finalPartIndex: number): MessageState | undefined {
	return process.messages.find((message) => {
		if (message.parts.length === 0) return false;
		if (message.id !== last.id) return true;
		if (last.message.stopReason !== "stop") return true;
		return finalPartIndex > 0;
	});
}

/**
 * Seal every pending process at a run or user boundary, whether it succeeded or not.
 * `retained` marks the disclosure that holds the messages Pi kept verbatim after a
 * compaction, so its header can carry a tag instead of looking like ordinary history.
 */
export function completeProcessFolds(options?: { retained?: boolean }): void {
	separateProcessFold();
	for (const process of pending) {
		if (process.fold) continue;
		const last = process.messages.at(-1);
		if (!last) continue;
		last.finished = true;
		const finalPartIndex = trailingAnswerIndex(last);
		const anchor = foldAnchor(process, last, finalPartIndex);
		// Direct answers with no preceding work do not need an empty disclosure.
		if (!anchor) continue;
		process.fold = { anchorMessageId: anchor.id, finalMessageId: last.id, finalPartIndex };
		if (options?.retained) process.fold.retained = true;
		process.expanded = false;
		for (const message of process.messages) message.refresh?.();
	}
	pending.clear();
}

export function toggleProcessFold(process: ProcessFoldState): void {
	if (!process.fold) return;
	process.expanded = !process.expanded;
	for (const message of process.messages) message.refresh?.();
}

export function setAllProcessFoldsExpanded(expanded: boolean): void {
	for (const process of processes) {
		if (!process.fold || process.expanded === expanded) continue;
		process.expanded = expanded;
		for (const message of process.messages) message.refresh?.();
	}
}

export function resetProcessFolds(): void {
	processes.clear();
	pending.clear();
	active = undefined;
}
