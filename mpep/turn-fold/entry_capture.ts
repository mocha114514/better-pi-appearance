import { InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { CustomEntryRecord } from "./extension_types.ts";
import { customEntryClaims, observeCustomEntry } from "./turn_state_manager.ts";

/**
 * Live capture for extension custom entries (pi.appendEntry).
 *
 * CustomEntryComponent is not exported from the pi-coding-agent package, so unlike
 * the tool/custom-message folds we cannot patch the class prototype. Instead this
 * module patches the two choke points that every custom entry passes through:
 *
 * 1. SessionManager.appendCustomEntry — the sole creation path; claims the entry
 *    into the active activity group when the agent is mid-run.
 * 2. InteractiveMode.addCustomEntryToChat — the sole UI construction point; grabs
 *    the freshly added component instance and suppresses its in-place rendering,
 *    exposing it as a delegate view for the fold group instead.
 *
 * Claims and component instances can arrive in either order on session reload, so
 * instances live in a registry and reconcileEntryClaims() applies suppression to
 * whatever was claimed after construction. All state is in-memory; claim decisions
 * are re-derived from session history on every load, nothing is persisted.
 */

interface EntryComponent extends Component {
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
	setExpanded(expanded: boolean): void;
}

interface ChatHost {
	chatContainer: { children: unknown[]; addChild(child: unknown): void };
	streamingComponent?: unknown;
	toolOutputExpanded?: boolean;
	session: { extensionRunner: { getEntryRenderer(customType: string): unknown } };
	ui: { requestRender(): void };
	addCustomEntryToChat(entry: { type: string; id?: string; customType?: string }): void;
}

interface SessionManagerInternals {
	getEntry(id: string): { type: string; id?: string } | undefined;
	appendCustomEntry(customType: string, data?: unknown): string;
}

/** Registry of rendered entry components by session entry id. */
const instances = new Map<string, EntryComponent>();
/** Original render/handleMouse per instance, captured before suppression. */
const originals = new WeakMap<EntryComponent, { render: Component["render"]; handleMouse?: EntryComponent["handleMouse"] }>();

function suppress(component: EntryComponent, record: CustomEntryRecord): void {
	if (originals.has(component)) return;
	const originalRender = component.render;
	const originalMouse = component.handleMouse;
	originals.set(component, { render: originalRender, handleMouse: originalMouse });
	record.view = {
		render: (width) => originalRender.call(component, width),
		handleMouse: (event) => originalMouse?.call(component, event),
		invalidate: () => component.invalidate(),
		setExpanded: (value) => component.setExpanded(value),
	};
	component.render = () => [];
	queueMicrotask(() => record.refresh?.());
}

/** Register a freshly created chat component; suppress immediately if already claimed. */
export function registerEntryComponent(entryId: string | undefined, component: EntryComponent): void {
	if (!entryId) return;
	instances.set(entryId, component);
	const record = customEntryClaims.get(entryId);
	if (record) suppress(component, record);
}

/** Apply suppression to instances that were constructed before their claim existed. */
export function reconcileEntryClaims(): void {
	for (const [id, component] of instances) {
		const record = customEntryClaims.get(id);
		if (record) suppress(component, record);
	}
}

/** The registry belongs to the chat being torn down; claims reset separately. */
export function resetEntryCapture(): void {
	instances.clear();
}

const patchSlot = Symbol.for("mpep.turn-fold.entry-capture");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export function installEntryCapture(): () => void {
	patches[patchSlot]?.();

	// Claim at the source: every appendEntry funnels through here, before the UI event.
	const sessionPrototype = SessionManager.prototype as unknown as SessionManagerInternals;
	const originalAppend = sessionPrototype.appendCustomEntry;
	const append = function (this: SessionManagerInternals, customType: string, data?: unknown): string {
		const id = originalAppend.call(this, customType, data);
		const entry = this.getEntry(id);
		if (entry?.type === "custom") observeCustomEntry(entry);
		return id;
	};
	sessionPrototype.appendCustomEntry = append;

	// Capture at the UI edge: the component is the single child this method adds.
	const modePrototype = InteractiveMode.prototype as unknown as ChatHost;
	const originalAdd = modePrototype.addCustomEntryToChat;
	const add = function (this: ChatHost, entry: { type: string; id?: string; customType?: string }): void {
		const before = new Set(this.chatContainer.children);
		originalAdd.call(this, entry);
		const component = this.chatContainer.children.filter((child) => !before.has(child))[0] as EntryComponent | undefined;
		if (component) registerEntryComponent(entry.id, component);
	};
	modePrototype.addCustomEntryToChat = add;

	const dispose = () => {
		if (sessionPrototype.appendCustomEntry === append) sessionPrototype.appendCustomEntry = originalAppend;
		if (modePrototype.addCustomEntryToChat === add) modePrototype.addCustomEntryToChat = originalAdd;
		instances.clear();
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
