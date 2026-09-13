// Model layer for /m-export: the current session branch becomes a list of blocks that mirror
// the terminal's disclosure rules (see vb-doc/mpep/export/usage.md).
//
// Pure functions only: nothing here touches the live TUI, the fold state or the Pi prototypes.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Reasoning / text / tool row inside a run, i.e. what a collapsed run hides. */
export type ExportItem =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| {
			kind: "tool";
			name: string;
			/** One-line argument digest, mirroring the terminal's tool rows. */
			preview: string;
			args: string;
			output: string;
			isError: boolean;
			pending: boolean;
	  };

export interface ExportToolCount {
	name: string;
	count: number;
}

export interface ExportRunBlock {
	kind: "run";
	id: string;
	/** Hidden while the disclosure is collapsed. */
	items: ExportItem[];
	/** Trailing answer kept outside the disclosure, same rule as the terminal. */
	answer: string[];
	/** Stop notice (error / abort / length) kept visible, same rule as the terminal. */
	notice?: string;
	/** Holds the tail Pi kept verbatim after a compaction. */
	kept: boolean;
	tools: ExportToolCount[];
	thinking: number;
	/** False for a direct answer with no preceding work. */
	foldable: boolean;
}

export interface ExportUserBlock {
	kind: "user";
	id: string;
	text: string;
	timestamp: string;
}

export interface ExportCompactionBlock {
	kind: "compaction";
	id: string;
	tokensBefore: number;
	summary: string;
	timestamp: string;
}

export interface ExportBranchSummaryBlock {
	kind: "branchSummary";
	id: string;
	summary: string;
	timestamp: string;
}

export interface ExportCustomBlock {
	kind: "custom";
	id: string;
	customType: string;
	text: string;
	timestamp: string;
}

export type ExportBlock =
	| ExportRunBlock
	| ExportUserBlock
	| ExportCompactionBlock
	| ExportBranchSummaryBlock
	| ExportCustomBlock;

export interface ExportStats {
	messages: number;
	tools: number;
	thinking: number;
	compactions: number;
	models: string[];
	tokens: number;
	cost: number;
	from?: string;
	to?: string;
}

export interface ExportModel {
	blocks: ExportBlock[];
	stats: ExportStats;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface RunDraft {
	block: ExportRunBlock;
	firstEntry: number;
	lastEntry: number;
	/** Last assistant message seen in the run: decides the answer split and the stop notice. */
	lastAssistant?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Text of a content payload: a plain string or text/image blocks. */
function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (isRecord(block) && block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** Pretty JSON for stored payloads; never throws on exotic values. */
function stringifyArgs(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/** One-line argument digest for the collapsed tool row. */
function previewArgs(args: unknown): string {
	if (!isRecord(args)) return typeof args === "string" ? args : "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		const text =
			typeof value === "string"
				? value
				: typeof value === "number" || typeof value === "boolean"
					? String(value)
					: value === null
						? "null"
						: Array.isArray(value)
							? `[${value.length}]`
							: "{...}";
		parts.push(`${key}=${text.replace(/\s+/g, " ")}`);
		if (parts.join(" ").length > 70) break;
	}
	const joined = parts.join(" ");
	return joined.length > 90 ? `${joined.slice(0, 90)}...` : joined;
}

function sumTokens(usage: UsageLike): number {
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** Clock time for headers; empty when the session has no usable timestamp. */
export function timestampText(timestamp: string | undefined): string {
	if (!timestamp) return "";
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return "";
	const date = new Date(parsed);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Mirror of the terminal rule: only a clean stop keeps its trailing text outside the fold. */
function trailingAnswers(content: readonly unknown[]): string[] {
	const answers: string[] = [];
	for (let index = content.length - 1; index >= 0; index--) {
		const block = content[index];
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || !block.text.trim()) break;
		answers.unshift(block.text);
	}
	return answers;
}

function stopNotice(message: Record<string, unknown>): string | undefined {
	const reason = message.stopReason;
	if (reason !== "error" && reason !== "aborted" && reason !== "length") return undefined;
	const error = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	if (error) return error;
	if (reason === "aborted") return "Aborted";
	if (reason === "length") return "Stopped at the output length limit";
	return "Error";
}

function toolCounts(items: readonly ExportItem[]): ExportToolCount[] {
	const counts: ExportToolCount[] = [];
	for (const item of items) {
		if (item.kind !== "tool") continue;
		const existing = counts.find((count) => count.name === item.name);
		if (existing) existing.count += 1;
		else counts.push({ name: item.name, count: 1 });
	}
	return counts;
}

/**
 * Turn session entries into export blocks.
 *
 * A "run" is the same unit the terminal folds: consecutive assistant/toolResult messages
 * between user-like, compaction or summary boundaries. Runs overlapping a compaction's kept
 * range (`firstKeptEntryId` .. the compaction itself) carry the "kept" tag.
 */
export function collectSession(entries: readonly SessionEntry[]): ExportModel {
	const blocks: ExportBlock[] = [];
	/** Runs that made it into the transcript: needed to tag the compaction-kept tail. */
	const emitted: RunDraft[] = [];
	const toolResults = new Map<string, Record<string, unknown>>();
	const stats: ExportStats = { messages: 0, tools: 0, thinking: 0, compactions: 0, models: [], tokens: 0, cost: 0 };
	let draft: RunDraft | undefined;

	const runIndex = new Map<string, number>();
	for (let index = 0; index < entries.length; index++) runIndex.set(entries[index].id, index);

	for (const entry of entries) {
		if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "toolResult") {
			const result = entry.message;
			if (typeof result.toolCallId === "string") toolResults.set(result.toolCallId, result);
		}
	}

	const flush = (lastEntry: number) => {
		const current = draft;
		draft = undefined;
		if (!current) return;
		current.lastEntry = lastEntry;
		const last = current.lastAssistant;
		if (last) {
			const content = Array.isArray(last.content) ? last.content : [];
			if (last.stopReason === "stop") {
				const answers = trailingAnswers(content).filter((text) => text.trim().length > 0);
				// Popping the same number of trailing text items keeps body/answer split in sync.
				if (answers.length > 0 && current.block.items.length >= answers.length) {
					const tail = current.block.items.slice(-answers.length);
					if (tail.every((item) => item.kind === "text")) {
						current.block.items = current.block.items.slice(0, -answers.length);
						current.block.answer = answers;
					}
				}
			}
			current.block.notice = stopNotice(last);
		}
		current.block.tools = toolCounts(current.block.items);
		current.block.thinking = current.block.items.filter((item) => item.kind === "thinking").length;
		current.block.foldable = current.block.items.length > 0;
		if (current.block.foldable || current.block.answer.length > 0 || current.block.notice) {
			blocks.push(current.block);
			emitted.push(current);
		}
	};

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		switch (entry.type) {
			case "message": {
				const message = entry.message as unknown;
				if (!isRecord(message)) break;
				const role = message.role;
				if (role === "assistant") {
					draft ??= {
						block: { kind: "run", id: entry.id, items: [], answer: [], kept: false, tools: [], thinking: 0, foldable: false },
						firstEntry: index,
						lastEntry: index,
					};
					const content = Array.isArray(message.content) ? message.content : [];
					for (const block of content) {
						if (!isRecord(block)) continue;
						if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
							draft.block.items.push({ kind: "thinking", text: block.thinking });
							stats.thinking += 1;
						} else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
							draft.block.items.push({ kind: "text", text: block.text });
						} else if (block.type === "toolCall" && typeof block.id === "string") {
							const result = toolResults.get(block.id);
							draft.block.items.push({
								kind: "tool",
								name: typeof block.name === "string" ? block.name : "tool",
								preview: previewArgs(block.arguments),
								args: stringifyArgs(block.arguments),
								output: result ? textOfContent(result.content) : "",
								isError: result?.isError === true,
								pending: result === undefined,
							});
							stats.tools += 1;
						}
					}
					draft.lastAssistant = message;
					draft.lastEntry = index;
					stats.messages += 1;
					const usage = isRecord(message.usage) ? (message.usage as UsageLike) : undefined;
					if (usage) {
						stats.tokens += sumTokens(usage);
						stats.cost += usage.cost?.total ?? 0;
					}
					const model =
						typeof message.responseModel === "string"
							? message.responseModel
							: typeof message.model === "string"
								? message.model
								: "";
					if (model && !stats.models.includes(model)) stats.models.push(model);
					if (typeof entry.timestamp === "string") {
						stats.from ??= entry.timestamp;
						stats.to = entry.timestamp;
					}
					break;
				}
				if (role === "toolResult") {
					if (draft) draft.lastEntry = index;
					break;
				}
				flush(index);
				const text =
					role === "bashExecution"
						? [`$ ${String(message.command ?? "")}`, textOfContent(message.output)].filter((line) => line.trim()).join("\n")
						: textOfContent(message.content);
				if (text.trim()) {
					blocks.push({ kind: "user", id: entry.id, text, timestamp: entry.timestamp });
					stats.messages += 1;
				}
				break;
			}
			case "compaction": {
				flush(index);
				// Entries in [firstKeptEntryId, compaction) survived this compaction verbatim.
				const keptStart = runIndex.get(entry.firstKeptEntryId);
				if (keptStart !== undefined) {
					for (const run of emitted) {
						if (run.lastEntry >= keptStart && run.firstEntry < index) run.block.kept = true;
					}
				}
				blocks.push({
					kind: "compaction",
					id: entry.id,
					tokensBefore: entry.tokensBefore,
					summary: entry.summary,
					timestamp: entry.timestamp,
				});
				stats.compactions += 1;
				break;
			}
			case "branch_summary": {
				flush(index);
				blocks.push({ kind: "branchSummary", id: entry.id, summary: entry.summary, timestamp: entry.timestamp });
				break;
			}
			case "custom": {
				flush(index);
				blocks.push({
					kind: "custom",
					id: entry.id,
					customType: entry.customType,
					text: stringifyArgs(entry.data),
					timestamp: entry.timestamp,
				});
				break;
			}
			case "custom_message": {
				flush(index);
				const text = textOfContent(entry.content);
				if (text.trim()) {
					blocks.push({ kind: "custom", id: entry.id, customType: entry.customType, text, timestamp: entry.timestamp });
				}
				break;
			}
			default:
				// model_change / thinking_level_change / label / session_info carry no transcript text.
				break;
		}
	}
	flush(entries.length);

	return { blocks, stats };
}
