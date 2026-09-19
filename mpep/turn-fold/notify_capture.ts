import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { hasActiveGroup, observeNotification } from "./turn_state_manager.ts";
import type { Activity, TurnState } from "./extension_types.ts";

/**
 * Live capture for info-level extension notifications (ctx.ui.notify).
 *
 * showStatus() writes a Spacer + Text pair straight into the chat container — no
 * session entry, no event, no renderer hook — so unlike custom entries there is no
 * session choke point to claim at. This module patches the single write path and,
 * when the agent is mid-run, suppresses the freshly added components in place and
 * hands a delegate view to the active activity group instead, so notifications
 * fold away in sequence just like tool outputs.
 *
 * Key properties:
 * - Only the info path (showStatus) is patched. showWarning/showError also write
 *   to the chat directly, but they carry run-critical information and must stay
 *   visible.
 * - showStatus() de-duplicates back-to-back notifications by rewriting the last
 *   Text in place. While a group is collecting, the rewrite lands on a suppressed
 *   component and the fold's delegate view simply follows the new text. Once no
 *   group is collecting (idle / sealed), a rewrite landing on a component we
 *   suppressed would hide a notification we would not have claimed — so the
 *   capture restores that batch in place and evicts the stale record from its
 *   group, mirroring what Pi would have painted without us.
 * - Notifications are never persisted by Pi, so there is nothing to re-derive on
 *   session reload; idle-time appends (no active group) render untouched.
 */

interface ChatHost {
	chatContainer: { children: unknown[] };
	showStatus(message: string): void;
}

/** A suppressed Spacer+Text batch and the fold record it backs. */
interface CapturedBatch {
	components: Component[];
	originals: Component["render"][];
	group: TurnState;
	record: Activity;
}

/** Suppressed batches keyed by their trailing (text) component — the rewrite target. */
const suppressed = new Map<Component, CapturedBatch>();

const patchSlot = Symbol.for("mpep.turn-fold.notify-capture");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

/** Undo a capture: the components render in place again and the fold drops the record. */
function release(batch: CapturedBatch): void {
	for (let index = 0; index < batch.components.length; index++) {
		batch.components[index].render = batch.originals[index];
		suppressed.delete(batch.components[index]);
	}
	const index = batch.group.activities.indexOf(batch.record);
	if (index >= 0) batch.group.activities.splice(index, 1);
	batch.group.refresh?.();
}

export function installNotifyCapture(): () => void {
	patches[patchSlot]?.();

	const modePrototype = InteractiveMode.prototype as unknown as ChatHost;
	const originalShowStatus = modePrototype.showStatus;
	const showStatus = function (this: ChatHost, message: string): void {
		const children = this.chatContainer.children;
		const before = new Set(children);
		originalShowStatus.call(this, message);
		const added = children.filter((child) => !before.has(child)) as Component[];

		if (!added.length) {
			// Back-to-back de-dup: Pi rewrote the last status Text in place. Mid-run the
			// delegate view follows the rewrite on its own; without an active group we
			// must hand the line back to the chat or the rewrite would stay invisible.
			if (hasActiveGroup()) return;
			const last = children[children.length - 1] as Component | undefined;
			const batch = last ? suppressed.get(last) : undefined;
			if (batch) release(batch);
			return;
		}

		// Build the delegate over the original renders before suppressing them.
		const originals = added.map((component) => component.render);
		const view: Component = {
			render: (width) => added.flatMap((component, index) => originals[index].call(component, width)),
			invalidate: () => {
				for (const component of added) component.invalidate();
			},
		};
		// Idle (no active group): leave the status line rendered in place.
		const record = observeNotification(view);
		if (!record) return;
		const batch: CapturedBatch = { components: added, originals, group: record.group, record: record.activity };
		for (const component of added) {
			component.render = () => [];
			suppressed.set(component, batch);
		}
	};
	modePrototype.showStatus = showStatus;

	const dispose = () => {
		if (modePrototype.showStatus === showStatus) modePrototype.showStatus = originalShowStatus;
		suppressed.clear();
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
