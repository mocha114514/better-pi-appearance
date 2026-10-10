// Pure in-memory todo list.
//
// No config, session, clock, or previous list is visible here. createList
// always starts a new document at revision 1; refusing to replace an
// unfinished list is the caller's job.
//
// Operations are atomic and do not mutate their inputs. A failed call leaves
// the previous state untouched. A successful change returns a new frozen
// state. Returning the same reference means nothing changed, so the revision
// stays put (idempotent completion and empty patches).
//
// Item order and dependency order are kept as given. They are not sorted.
// Descriptions are optional on input, default to "", and stay attached when
// an item is completed. There is no length cap and no item-count cap.
//
// Terminal C0/C1 controls and DEL are rejected so an id or title cannot move
// the cursor or change color when printed. Descriptions may still contain
// tab, LF, and CR. Other Unicode is kept verbatim, including composing forms.

export interface ListItem {
	id: string;
	title: string;
	description: string;
	dependsOn: string[];
	done: boolean;
}

export interface ListItemInput {
	id: string;
	title: string;
	description?: string;
	dependsOn?: string[];
}

export interface ListState {
	schemaVersion: 1;
	id: string;
	title: string;
	revision: number;
	items: ListItem[];
}

const LIST_FIELDS = new Set([
	"schemaVersion",
	"id",
	"title",
	"revision",
	"items",
]);

const ITEM_FIELDS = new Set([
	"id",
	"title",
	"description",
	"dependsOn",
	"done",
]);

function fail(message: string): never {
	throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFields(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) fail(`Unexpected ${label} field: ${key}`);
	}
}

// allowMultiline is only for descriptions. Titles and ids are single line
// because they are also printed as identifiers.
function assertSafeText(value: string, label: string, allowMultiline: boolean): void {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		const isTab = code === 0x09;
		const isNewline = code === 0x0a || code === 0x0d;
		if (allowMultiline && (isTab || isNewline)) continue;
		const isControl = code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		if (isControl) fail(`Unsafe control character in ${label}`);
	}
}

function requireText(
	value: unknown,
	label: string,
	allowEmpty: boolean,
	allowMultiline: boolean,
): string {
	if (typeof value !== "string") fail(`${label} must be a string`);
	assertSafeText(value, label, allowMultiline);
	if (!allowEmpty && value.trim().length === 0) {
		fail(`${label} must be a non-empty string`);
	}
	return value;
}

function readDependencies(value: unknown): string[] {
	if (!Array.isArray(value)) fail("Dependencies must be an array of strings");
	const dependencies: string[] = [];
	for (const entry of value) {
		dependencies.push(requireText(entry, "Dependency id", false, false));
	}
	return dependencies;
}

function readRevision(value: unknown): number {
	// createList starts at 1, so a stored 0 is not a valid document.
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		fail("List revision must be a positive safe integer");
	}
	return value;
}

function nextRevision(revision: number): number {
	const current = readRevision(revision);
	if (current === Number.MAX_SAFE_INTEGER) {
		fail("Revision cannot increase past the safe integer range");
	}
	return current + 1;
}

function assertSchema(state: ListState): void {
	if (state.schemaVersion !== 1) fail("List schemaVersion must be 1");
	if (!Array.isArray(state.items)) fail("List items must be an array");
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

// Already frozen items are reused so unchanged rows keep their identity.
// Freeze is applied to the annotated variables; returning Object.freeze's
// result would widen arrays to readonly and no longer match ListItem.
function sealItem(item: ListItem): ListItem {
	if (Object.isFrozen(item) && Object.isFrozen(item.dependsOn)) return item;
	const dependsOn: string[] = [...item.dependsOn];
	Object.freeze(dependsOn);
	const sealed: ListItem = {
		id: item.id,
		title: item.title,
		description: item.description,
		dependsOn,
		done: item.done,
	};
	Object.freeze(sealed);
	return sealed;
}

function sealState(parts: {
	id: string;
	title: string;
	revision: number;
	items: readonly ListItem[];
}): ListState {
	const items: ListItem[] = parts.items.map(sealItem);
	Object.freeze(items);
	const sealed: ListState = {
		schemaVersion: 1,
		id: parts.id,
		title: parts.title,
		revision: parts.revision,
		items,
	};
	Object.freeze(sealed);
	return sealed;
}

function indexItems(items: readonly ListItem[]): Map<string, ListItem> {
	const index = new Map<string, ListItem>();
	for (const item of items) {
		if (index.has(item.id)) fail(`Duplicate item id: ${item.id}`);
		index.set(item.id, item);
	}
	return index;
}

function assertEdges(items: readonly ListItem[], index: ReadonlyMap<string, ListItem>): void {
	for (const item of items) {
		const seen = new Set<string>();
		for (const dependency of item.dependsOn) {
			if (dependency === item.id) fail(`Item depends on itself: ${item.id}`);
			if (seen.has(dependency)) fail(`Duplicate dependency: ${item.id} -> ${dependency}`);
			seen.add(dependency);
			const target = index.get(dependency);
			if (!target) fail(`Missing dependency: ${item.id} -> ${dependency}`);
			// A completed item cannot sit on top of open work. Checked for
			// every edge so update and hydration cannot store a broken graph.
			if (item.done && !target.done) {
				fail(`Completed item depends on an incomplete item: ${item.id} -> ${dependency}`);
			}
		}
	}
}

function assertAcyclic(items: readonly ListItem[], index: ReadonlyMap<string, ListItem>): void {
	// Iterative so a long chain is not limited by the call stack.
	const color = new Map<string, "white" | "gray" | "black">();
	for (const item of items) color.set(item.id, "white");

	for (const start of items) {
		if (color.get(start.id) !== "white") continue;
		const trail: string[] = [];
		const frames: { id: string; next: number }[] = [];
		color.set(start.id, "gray");
		trail.push(start.id);
		frames.push({ id: start.id, next: 0 });

		while (frames.length > 0) {
			const frame = frames[frames.length - 1];
			if (!frame) break;
			const item = index.get(frame.id);
			if (!item) fail(`Missing dependency: ${frame.id}`);
			if (frame.next >= item.dependsOn.length) {
				frames.pop();
				trail.pop();
				color.set(item.id, "black");
				continue;
			}
			const dependency = item.dependsOn[frame.next];
			frame.next += 1;
			if (dependency === undefined) continue;
			const shade = color.get(dependency);
			if (shade === "gray") {
				const startIndex = trail.indexOf(dependency);
				const cycle = trail.slice(startIndex);
				cycle.push(dependency);
				fail(`Cyclic dependency: ${cycle.join(" -> ")}`);
			}
			if (shade === "white") {
				color.set(dependency, "gray");
				trail.push(dependency);
				frames.push({ id: dependency, next: 0 });
			}
		}
	}
}

function validateGraph(items: readonly ListItem[]): void {
	if (items.length === 0) fail("List must contain at least one item");
	const index = indexItems(items);
	assertEdges(items, index);
	assertAcyclic(items, index);
}

// Input items always start open. `done` on the raw object is ignored so a
// caller cannot smuggle a completed row into a brand-new list.
function readInput(value: unknown): ListItem {
	if (!isRecord(value)) fail("Item must be an object");
	const description = value.description === undefined
		? ""
		: requireText(value.description, "Item description", true, true);
	const dependsOn = value.dependsOn === undefined
		? []
		: readDependencies(value.dependsOn);
	return {
		id: requireText(value.id, "Item id", false, false),
		title: requireText(value.title, "Item title", false, false),
		description,
		dependsOn,
		done: false,
	};
}

function readStoredItem(value: unknown): ListItem {
	if (!isRecord(value)) fail("Item must be an object");
	assertFields(value, ITEM_FIELDS, "item");
	if (typeof value.done !== "boolean") fail("Item done must be a boolean");
	return {
		id: requireText(value.id, "Item id", false, false),
		title: requireText(value.title, "Item title", false, false),
		description: requireText(value.description, "Item description", true, true),
		dependsOn: readDependencies(value.dependsOn),
		done: value.done,
	};
}

function findIndex(state: ListState, itemId: string): number {
	const index = state.items.findIndex(item => item.id === itemId);
	if (index < 0) fail(`Unknown item: ${itemId}`);
	return index;
}

export function createList(id: string, title: string, items: ListItemInput[]): ListState {
	const listId = requireText(id, "List id", false, false);
	const listTitle = requireText(title, "List title", false, false);
	if (!Array.isArray(items)) fail("List items must be an array");
	if (items.length === 0) fail("List must contain at least one item");
	const materialized = items.map(readInput);
	validateGraph(materialized);
	return sealState({
		id: listId,
		title: listTitle,
		revision: 1,
		items: materialized,
	});
}

export function appendItems(state: ListState, items: ListItemInput[]): ListState {
	assertSchema(state);
	if (!Array.isArray(items)) fail("List items must be an array");
	if (items.length === 0) fail("Append requires at least one item");
	const materialized = items.map(readInput);
	const nextItems = state.items.concat(materialized);
	validateGraph(nextItems);
	return sealState({
		id: state.id,
		title: state.title,
		revision: nextRevision(state.revision),
		items: nextItems,
	});
}

export function updateItem(
	state: ListState,
	itemId: string,
	patch: {
		title?: string;
		description?: string;
		dependsOn?: string[];
	},
): ListState {
	assertSchema(state);
	const index = findIndex(state, itemId);
	const current = state.items[index];
	if (!current) fail(`Unknown item: ${itemId}`);

	const title = patch.title === undefined
		? current.title
		: requireText(patch.title, "Item title", false, false);
	const description = patch.description === undefined
		? current.description
		: requireText(patch.description, "Item description", true, true);
	const dependsOn = patch.dependsOn === undefined
		? current.dependsOn
		: readDependencies(patch.dependsOn);

	if (
		title === current.title
		&& description === current.description
		&& sameIds(dependsOn, current.dependsOn)
	) {
		return state;
	}

	const items = state.items.slice();
	items[index] = {
		id: current.id,
		title,
		description,
		dependsOn,
		done: current.done,
	};
	validateGraph(items);
	return sealState({
		id: state.id,
		title: state.title,
		revision: nextRevision(state.revision),
		items,
	});
}

export function completeItem(state: ListState, itemId: string): ListState {
	assertSchema(state);
	const index = findIndex(state, itemId);
	const current = state.items[index];
	if (!current) fail(`Unknown item: ${itemId}`);
	// Already done: same object, same revision. Valid states have no open
	// dependencies under a completed item, so this does not re-check them.
	if (current.done) return state;

	const blockers = blockedBy(state, current);
	if (blockers.length > 0) {
		fail(`Item is blocked by incomplete dependencies: ${current.id} (${blockers.join(", ")})`);
	}

	const items = state.items.slice();
	items[index] = {
		id: current.id,
		title: current.title,
		description: current.description,
		dependsOn: current.dependsOn,
		done: true,
	};
	validateGraph(items);
	return sealState({
		id: state.id,
		title: state.title,
		revision: nextRevision(state.revision),
		items,
	});
}

export function parseListState(value: unknown): ListState {
	if (!isRecord(value)) fail("List state must be an object");
	assertFields(value, LIST_FIELDS, "list");
	if (value.schemaVersion !== 1) fail("List schemaVersion must be 1");
	const id = requireText(value.id, "List id", false, false);
	const title = requireText(value.title, "List title", false, false);
	const revision = readRevision(value.revision);
	if (!Array.isArray(value.items)) fail("List items must be an array");
	if (value.items.length === 0) fail("List must contain at least one item");
	const items = value.items.map(readStoredItem);
	validateGraph(items);
	return sealState({ id, title, revision, items });
}

// Direct incomplete dependencies, in dependsOn order. A missing id counts as
// blocking. Transitive work stays on the intermediate item: it cannot be
// completed until its own blockers are done, which keeps this list sufficient.
export function blockedBy(
	state: ListState,
	item: ListItem,
	completion?: ReadonlyMap<string, boolean>,
): string[] {
	// Batch views reuse one index instead of rebuilding it for every item.
	const done = completion ?? new Map(state.items.map(entry => [entry.id, entry.done] as const));
	return item.dependsOn.filter(dependency => done.get(dependency) !== true);
}

export function isComplete(state: ListState): boolean {
	return state.items.length > 0 && state.items.every(item => item.done);
}
