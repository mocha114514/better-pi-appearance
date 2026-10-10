import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";
import { ListCompaction } from "./compaction.ts";
import { LIST_STATE_ENTRY, ListStore } from "./store.ts";
import { registerListTools } from "./tools.ts";
import { installListWidget, type ListWidget } from "./widget.ts";

const SLOT = Symbol.for("mpep.list.dispose.v1");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export default function listExtension(pi: ExtensionAPI): void {
	installations[SLOT]?.();
	if (!isPluginEnabled("list")) return;
	let active = true;
	let sessionId: string | undefined;
	let widget: ListWidget | undefined;
	const store = new ListStore(
		state => pi.appendEntry(LIST_STATE_ENTRY, state),
		() => widget?.changed(),
	);
	const compaction = new ListCompaction(pi);

	const report = (ctx: ExtensionContext, error: unknown) => {
		ctx.ui.notify(t("list.restoreFailed", {
			error: error instanceof Error ? error.message : String(error),
		}), "error");
	};

	const bind = (ctx: ExtensionContext) => {
		widget?.dispose();
		widget = undefined;
		sessionId = ctx.sessionManager.getSessionId();
		store.restore(ctx.sessionManager);
		compaction.reset();
		try {
			compaction.restore(ctx, store.read());
		} catch (error) {
			report(ctx, error);
		}
		widget = installListWidget(ctx, () => {
			try { return store.read(); }
			catch { return undefined; }
		});
	};

	const getStore = (ctx: ExtensionContext): ListStore => {
		if (!active) throw new Error("The checklist extension is no longer active.");
		if (sessionId !== ctx.sessionManager.getSessionId()) bind(ctx);
		return store;
	};

	const dispose = () => {
		if (!active) return;
		active = false;
		widget?.dispose();
		widget = undefined;
		compaction.reset();
		if (installations[SLOT] === dispose) delete installations[SLOT];
	};
	installations[SLOT] = dispose;

	registerListTools(pi, getStore);
	pi.registerCommand("m-list", {
		description: t("list.command"),
		async handler(_args, ctx) {
			getStore(ctx);
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(t("list.requiresUI"), "warning");
				return;
			}
			widget?.toggle();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (active) bind(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (!active) return;
		try {
			compaction.restore(ctx, getStore(ctx).read());
			widget?.changed();
		} catch (error) {
			report(ctx, error);
		}
	});
	pi.on("session_compact", (event, ctx) => {
		if (!active) return;
		try {
			// Use the actual latest branch entry. Some Pi versions select the first
			// matching summary for the event, which can reuse an older entry's ID.
			const latest = ctx.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
			compaction.afterCompaction(latest?.id ?? event.compactionEntry.id, getStore(ctx).read(), ctx);
			widget?.changed();
		} catch (error) {
			report(ctx, error);
		}
	});
	pi.on("context", (event, ctx) => {
		if (!active) return;
		getStore(ctx);
		return { messages: compaction.project(event.messages) };
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (active) compaction.onSettled(ctx);
	});
	pi.on("session_shutdown", () => {
		// A session switch can reuse this extension instance. Unmount the old UI
		// without disabling the next session_start; reload's factory owns dispose.
		widget?.dispose();
		widget = undefined;
		sessionId = undefined;
		compaction.reset();
	});
}
