import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	completeProcessFolds,
	registerProcessFoldMessage,
	resetProcessFolds,
	setAllProcessFoldsExpanded,
} from "./process_fold_state.ts";
import type { CustomMessageRecord, MessageState, ToolView, TurnState } from "./extension_types.ts";

export const turnStates = new Map<number, TurnState>();
export const toolCallTurnMap = new Map<string, number>();
export const toolViews = new Map<string, ToolView>();
/** Claimed custom messages by customMessageKey; their components render empty in place. */
export const customClaims = new Map<string, CustomMessageRecord>();
export const liveState = { globalExpanded: false };

let messages = new WeakMap<AssistantMessage, MessageState>();
const timestamps = new Map<number, MessageState[]>();
let activeMessage: MessageState | undefined;
let activeGroup: TurnState | undefined;
let nextMessageId = 0;
let nextGroupId = 0;

export function resetTurnState(): void {
	resetProcessFolds();
	turnStates.clear();
	toolCallTurnMap.clear();
	toolViews.clear();
	messages = new WeakMap();
	timestamps.clear();
	customClaims.clear();
	activeMessage = undefined;
	activeGroup = undefined;
	nextMessageId = 0;
	nextGroupId = 0;
	liveState.globalExpanded = false;
}

export function getMessageState(message: AssistantMessage): MessageState | undefined {
	const exact = messages.get(message);
	if (exact) return exact;
	const candidates = timestamps.get(message.timestamp);
	if (candidates?.length === 1) return candidates[0];
	// Timestamps are not identifiers: two responses may start in the same millisecond.
	return candidates?.find((candidate) =>
		message.content.some(
			(block) =>
				block.type === "toolCall" &&
				candidate.message.content.some((other) => other.type === "toolCall" && other.id === block.id),
		),
	);
}

export function getTurnId(toolCallId: string): number | undefined {
	return toolCallTurnMap.get(toolCallId);
}

export function customMessageKey(customType: string | undefined, timestamp: number | undefined): string {
	return `${customType ?? "custom"}@${timestamp ?? 0}`;
}

/**
 * Fold an extension custom message into the active group. Only mid-run displayable
 * messages qualify: a live group means the agent is between agent_start/agent_end,
 * which is exactly where steered and turn-deferred notes land. Idle notifications
 * (no active group) and invisible context injections (display:false) stay outside.
 */
export function observeCustomMessage(message: {
	customType?: string;
	display?: boolean;
	timestamp?: number;
}): boolean {
	if (message.display === false || !activeGroup) return false;
	const group = activeGroup;
	const record: CustomMessageRecord = {
		type: "custom",
		key: customMessageKey(message.customType, message.timestamp),
		label: message.customType ?? "custom",
		refresh: () => group.refresh?.(),
	};
	group.activities.push(record);
	customClaims.set(record.key, record);
	group.refresh?.();
	return true;
}

export function sealActiveGroup(): void {
	const group = activeGroup;
	activeGroup = undefined;
	if (!group) return;
	group.sealed = true;
	group.refresh?.();
}

/** Only protocol events allocate groups. Rendering never changes activity ownership. */
export function observeAssistant(message: AssistantMessage, start = false): void {
	let state = start ? undefined : (messages.get(message) ?? activeMessage);
	if (!state) {
		state = { id: ++nextMessageId, message, parts: [], blocks: new Map(), finished: false };
		registerProcessFoldMessage(state);
		const candidates = timestamps.get(message.timestamp) ?? [];
		candidates.push(state);
		timestamps.set(message.timestamp, candidates);
	}
	messages.set(message, state);
	state.message = message;
	activeMessage = state;
	const changed = new Set<TurnState>();
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		const existing = state.blocks.get(index);
		if (block.type === "text") {
			if (block.text.trim() && !existing) {
				sealActiveGroup();
				state.blocks.set(index, "text");
				state.parts.push({ type: "text", index });
			}
			continue;
		}
		if (block.type === "thinking" && !block.thinking.trim()) continue;
		if (existing) {
			if (block.type === "thinking" && typeof existing !== "string" && existing.output !== block.thinking) {
				existing.output = block.thinking;
				if (activeGroup) changed.add(activeGroup);
			} else if (block.type === "toolCall") {
				const groupId = toolCallTurnMap.get(block.id);
				const group = groupId === undefined ? undefined : turnStates.get(groupId);
				const tool = group?.tools.get(block.id);
				if (tool) tool.args = block.arguments;
			}
			continue;
		}
		if (!activeGroup) {
			activeGroup = {
				id: ++nextGroupId,
				tools: new Map(),
				activities: [],
				expanded: liveState.globalExpanded,
				sealed: false,
			};
			turnStates.set(activeGroup.id, activeGroup);
			state.parts.push({ type: "group", groupId: activeGroup.id });
		}
		const group = activeGroup;
		if (block.type === "thinking") {
			const activity = {
				type: "thinking" as const,
				key: `${state.id}:${index}`,
				output: block.thinking,
				isExpanded: false,
			};
			group.activities.push(activity);
			state.blocks.set(index, activity);
		} else if (block.type === "toolCall") {
			if (!toolCallTurnMap.has(block.id)) {
				toolCallTurnMap.set(block.id, group.id);
				group.tools.set(block.id, {
					id: block.id,
					name: block.name,
					args: block.arguments,
					output: "",
					isPartial: true,
					isError: false,
					isExpanded: false,
				});
				group.activities.push({ type: "tool", toolCallId: block.id });
			}
			state.blocks.set(index, "tool");
		}
		changed.add(group);
	}
	for (const group of changed) group.refresh?.();
}

export function observeToolResult(toolCallId: string, result: unknown, isPartial: boolean, isError: boolean): void {
	const groupId = toolCallTurnMap.get(toolCallId);
	const group = groupId === undefined ? undefined : turnStates.get(groupId);
	const tool = group?.tools.get(toolCallId);
	if (!tool || !group) return;
	// Late partial output cannot undo a completed (or interrupted) execution.
	if (!tool.isPartial && isPartial) return;
	tool.isPartial = isPartial;
	tool.isError = isError;
	tool.output = getResultText(result);
	group.refresh?.();
}

export function getResultText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
	return result.content
		.flatMap((block: unknown) =>
			block &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

export function endLiveCollection(): void {
	for (const group of turnStates.values()) {
		let changed = false;
		for (const tool of group.tools.values()) {
			if (!tool.isPartial) continue;
			tool.isPartial = false;
			tool.isError = true;
			tool.output ||= "Execution ended without a result";
			changed = true;
		}
		if (changed) group.refresh?.();
	}
	sealActiveGroup();
	activeMessage = undefined;
	completeProcessFolds();
}

export function finishAssistant(message: AssistantMessage): void {
	observeAssistant(message);
	const state = getMessageState(message);
	if (state) state.finished = true;
	if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			observeToolResult(
				block.id,
				{ content: [{ type: "text", text: message.errorMessage || message.stopReason }] },
				false,
				true,
			);
		}
		sealActiveGroup();
	}
	activeMessage = undefined;
}

export function syncFromSessionHistory(
	entries: readonly { type: string; message?: unknown }[],
	isRunning = false,
): void {
	resetTurnState();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "compaction") {
			sealActiveGroup();
			// The process sealed by a compaction boundary is the tail Pi kept verbatim for
			// the model context, so its disclosure gets the "kept" tag.
			completeProcessFolds({ retained: true });
		} else if (entry.type === "branch_summary") {
			sealActiveGroup();
			completeProcessFolds();
		} else if (entry.type === "custom_message") {
			if (!claimHistoryCustomMessage(entry, entries, index)) {
				sealActiveGroup();
				completeProcessFolds();
			}
			continue;
		}
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || !("role" in entry.message))
			continue;
		if (entry.message.role === "assistant") {
			observeAssistant(entry.message as AssistantMessage, true);
			finishAssistant(entry.message as AssistantMessage);
		} else if (entry.message.role === "toolResult") {
			const result = entry.message as ToolResultMessage;
			observeToolResult(result.toolCallId, result, false, result.isError);
		} else {
			sealActiveGroup();
			completeProcessFolds();
		}
	}
	if (!isRunning) endLiveCollection();
}

/**
 * History rebuild counterpart of observeCustomMessage. A persisted custom message is
 * mid-run iff the painted order shows more assistant activity after it (steered and
 * deferred notes both re-enter the loop); a trailing message was sent while idle and
 * keeps its standalone rendering. Entry timestamps are ISO strings; the rebuilt
 * CustomMessage carries the same instant in milliseconds, so the claim key matches
 * the component Pi constructs.
 */
function claimHistoryCustomMessage(
	entry: { type: string; message?: unknown },
	entries: readonly { type: string; message?: unknown }[],
	index: number,
): boolean {
	const custom = entry as { display?: boolean; customType?: string; timestamp?: string };
	if (custom.display === false || !activeGroup) return false;
	let midRun = false;
	for (let i = index + 1; i < entries.length; i++) {
		const next = entries[i];
		if (next.type === "compaction" || next.type === "branch_summary") return false;
		// Consecutive custom messages claim one by one; only the run's continuation decides.
		if (next.type === "custom_message") continue;
		if (next.type !== "message") continue;
		const role = (next.message as { role?: string } | undefined)?.role;
		if (role === "toolResult") continue;
		if (role !== "assistant") return false;
		midRun = true;
		break;
	}
	if (!midRun) return false;
	const group = activeGroup;
	const record: CustomMessageRecord = {
		type: "custom",
		key: customMessageKey(custom.customType, Date.parse(custom.timestamp ?? "") || 0),
		label: custom.customType ?? "custom",
		refresh: () => group.refresh?.(),
	};
	group.activities.push(record);
	customClaims.set(record.key, record);
	return true;
}

export function toggleTurnExpanded(turnId: number): void {
	const group = turnStates.get(turnId);
	if (!group) return;
	group.expanded = !group.expanded;
	for (const tool of group.tools.values()) {
		tool.isExpanded = false;
		toolViews.get(tool.id)?.setExpanded(false);
	}
	for (const activity of group.activities) if (activity.type === "thinking") activity.isExpanded = false;
	group.refresh?.();
}

export function setAllGlobalExpanded(expanded: boolean): void {
	if (liveState.globalExpanded === expanded) return;
	liveState.globalExpanded = expanded;
	const refreshes = new Set<() => void>();
	for (const group of turnStates.values()) {
		group.expanded = expanded;
		for (const tool of group.tools.values()) tool.isExpanded = false;
		for (const activity of group.activities) if (activity.type === "thinking") activity.isExpanded = false;
		if (group.refresh) refreshes.add(group.refresh);
	}
	for (const view of toolViews.values()) view.setExpanded(false);
	for (const refresh of refreshes) refresh();
	setAllProcessFoldsExpanded(expanded);
}

export function toggleToolExpanded(toolCallId: string): void {
	const id = toolCallTurnMap.get(toolCallId);
	const group = id === undefined ? undefined : turnStates.get(id);
	const tool = group?.tools.get(toolCallId);
	if (!tool) return;
	tool.isExpanded = !tool.isExpanded;
	toolViews.get(toolCallId)?.setExpanded(tool.isExpanded);
	group?.refresh?.();
}
