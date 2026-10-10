import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { t } from "../shared/i18n/index.ts";
import { formatList } from "./format.ts";
import {
	appendItems,
	blockedBy,
	completeItem,
	createList,
	isComplete,
	updateItem,
	type ListState,
} from "./model.ts";
import type { ListStore } from "./store.ts";

const itemSchema = Type.Object({
	id: Type.String({ description: "Stable item identifier, such as 1.2 or 2.1; not renumbered on completion." }),
	title: Type.String({ description: "Short, non-empty item title." }),
	description: Type.Optional(Type.String({ description: "Full explanatory text below this item; paragraphs are allowed." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), {
		description: "Explicit prerequisite item IDs. Every prerequisite must be done before this item can be completed.",
	})),
}, { additionalProperties: false });

const writeSchema = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("append"),
		Type.Literal("update"),
		Type.Literal("complete"),
	]),
	title: Type.Optional(Type.String({ description: "List title for create, or replacement item title for update." })),
	items: Type.Optional(Type.Array(itemSchema, {
		minItems: 1,
		description: "Ordered new items, required for create and append. Creation always starts with unfinished items.",
	})),
	itemId: Type.Optional(Type.String({ description: "Existing item ID, required for update and complete." })),
	description: Type.Optional(Type.String({ description: "Replacement item description for update." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Replacement prerequisite IDs for update." })),
}, { additionalProperties: false });

const readSchema = Type.Object({}, { additionalProperties: false });

interface ListToolDetails {
	list?: ListState;
}

function renderResult(
	result: AgentToolResult<ListToolDetails>,
	expanded: boolean,
	theme: Theme,
	failed: boolean,
): Text {
	const state = result.details?.list;
	const text = expanded || failed
		? result.content.filter(part => part.type === "text").map(part => part.text).join("\n")
		: state ? t("list.progress", {
			done: state.items.filter(item => item.done).length,
			total: state.items.length,
		}) : t("list.empty");
	return new Text(theme.fg(failed ? "error" : "dim", text), 0, 0);
}

function validateWriteArguments(params: Static<typeof writeSchema>): void {
	const fields: Record<typeof params.action, readonly string[]> = {
		create: ["action", "title", "items"],
		append: ["action", "items"],
		update: ["action", "itemId", "title", "description", "dependsOn"],
		complete: ["action", "itemId"],
	};
	for (const key of Object.keys(params)) {
		if (!fields[params.action].includes(key)) {
			throw new Error(`${params.action} does not accept ${key}. No changes were made.`);
		}
	}
	if (params.action === "update" && params.title === undefined && params.description === undefined && params.dependsOn === undefined) {
		throw new Error("update requires at least one of title, description or dependsOn.");
	}
}

function requireList(store: ListStore): ListState {
	const state = store.read();
	if (!state) throw new Error("No checklist exists. Use list_write with action=create first.");
	return state;
}

function summary(state: ListState): string {
	const done = state.items.filter(item => item.done).length;
	const completion = new Map(state.items.map(item => [item.id, item.done] as const));
	const ready = state.items.filter(item => !item.done && blockedBy(state, item, completion).length === 0);
	return [
		`Checklist ${state.id}, revision ${state.revision}: ${done}/${state.items.length} completed.`,
		ready.length > 0 ? `Ready items: ${ready.map(item => item.id).join(", ")}.` : "No unblocked unfinished items.",
		"Completed items and descriptions are retained. Use list_read to inspect the complete checklist.",
	].join("\n");
}

/** Tool text is for the model; the transcript stays compact unless expanded. */
export function registerListTools(
	pi: ExtensionAPI,
	getStore: (ctx: ExtensionContext) => ListStore,
): void {
	pi.registerTool<typeof writeSchema, ListToolDetails>({
		name: "list_write",
		label: "List Write",
		description: [
			"Maintain a persistent, ordered checklist with explanatory descriptions and explicit prerequisite IDs.",
			"create requires title and items; append requires items; update requires itemId and changed title/description/dependsOn; complete requires itemId.",
			"Only mark an item complete after its actual work and all prerequisites are finished.",
			"All updates are atomic. Invalid/missing/cyclic dependencies are rejected. An unfinished checklist cannot be replaced.",
			"Descriptions and completed items remain available until a completed checklist is replaced with a new one.",
		].join(" "),
		promptSnippet: "Create and update a persistent checklist with descriptions and enforced dependencies.",
		promptGuidelines: [
			"For multi-step work, create an ordered checklist, explicitly specify dependencies, and mark finished items complete as you work.",
			"Numbering and display order do not imply dependencies. Fill dependsOn explicitly.",
		],
		parameters: writeSchema,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Checklist update cancelled.");
			validateWriteArguments(params);
			const store = getStore(ctx);
			let next: ListState;
			switch (params.action) {
				case "create": {
					const previous = store.read();
					if (previous && !isComplete(previous)) {
						throw new Error("Finish the existing checklist before creating another one.");
					}
					if (params.title === undefined || params.items === undefined) {
						throw new Error("create requires title and items.");
					}
					next = createList(randomUUID(), params.title, params.items);
					break;
				}
				case "append":
					if (params.items === undefined) throw new Error("append requires items.");
					next = appendItems(requireList(store), params.items);
					break;
				case "update":
					if (params.itemId === undefined) throw new Error("update requires itemId.");
					next = updateItem(requireList(store), params.itemId, {
						title: params.title,
						description: params.description,
						dependsOn: params.dependsOn,
					});
					break;
				case "complete":
					if (params.itemId === undefined) throw new Error("complete requires itemId.");
					next = completeItem(requireList(store), params.itemId);
					break;
			}
			store.commit(next);
			return {
				content: [{ type: "text", text: summary(next) }],
				details: { list: next },
			};
		},
		renderCall: (args, theme) => new Text(theme.fg("accent", `list · ${args.action}`), 0, 0),
		renderResult: (result, options, theme, context) => renderResult(result, options.expanded, theme, context.isError),
	});

	pi.registerTool<typeof readSchema, ListToolDetails>({
		name: "list_read",
		label: "List Read",
		description: "Read the FULL current checklist, including every completed item, all description paragraphs, explicit dependencies and blocking IDs. State survives context compaction. Never infer the live state solely from an older compaction snapshot.",
		promptSnippet: "Inspect the full checklist, including completed work and dependencies, even after compaction.",
		parameters: readSchema,
		executionMode: "sequential",
		async execute(_id, _params, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Checklist read cancelled.");
			const state = getStore(ctx).read();
			return {
				// Full text must be in content: details alone is not visible to the LLM.
				content: [{ type: "text", text: state ? formatList(state) : "No checklist exists yet." }],
				details: { list: state },
			};
		},
		renderCall: (_args, theme) => new Text(theme.fg("accent", "list · read"), 0, 0),
		renderResult: (result, options, theme, context) => renderResult(result, options.expanded, theme, context.isError),
	});
}
