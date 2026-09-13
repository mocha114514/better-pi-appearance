import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../shared/i18n/index.ts";
import { loadRegistry, writePluginStates, type RegistryItem } from "./preferences.ts";
import { disablePathLinkHyperlinks, enablePathLinkHyperlinks } from "../path-links/hyperlinks.ts";
import { installTheme, uninstallTheme } from "../theme-distributor.ts";

// Registry IDs and fallback metadata stay compatible with existing installations.
const builtinIds = ["turn-fold", "markdown-enhancer", "path-links", "terminal-interaction", "turn-navigator", "cooking-timer", "statusline", "tps", "usage", "export", "theme-distributor"] as const;

// Lifecycle hooks: some plugins own files outside mpep-cache and must clean up
// (or set up) when toggled, instead of just self-gating on next load.
// Hooks receive the new enabled state of the toggled plugin.
type ToggleHook = (enabled: boolean) => string | undefined;
const toggleHooks: Partial<Record<string, ToggleHook>> = {
	"theme-distributor": (enabled) => enabled ? installTheme() : uninstallTheme(),
	"path-links": (enabled) => {
		if (enabled) enablePathLinkHyperlinks();
		else disablePathLinkHyperlinks();
		return undefined;
	},
};
function display(item: RegistryItem): { name: string; desc: string } {
	const id = builtinIds.find(id => id === item.id);
	return id ? { name: t(`plugin.${id}.name`), desc: t(`plugin.${id}.desc`) } : item;
}

async function handleManagerCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmedArgs = (args || "").trim();
	const subArgs = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
	const subCommand = subArgs[0]?.toLowerCase();

	let items = loadRegistry();
	if (items.length === 0) {
		ctx.ui.notify(t("manager.missingRegistry"), "error");
		return;
	}

	// Command-line argument support: /m-mng list
	if (subCommand === "list") {
		const lines = items.map((item) => {
			const mark = item.enabled ? `[✓ ${t("manager.enabled")}]` : `[  ${t("manager.disabled")}]`;
			const label = display(item);
			return `${mark} ${item.id.padEnd(16)} - ${label.name} (${label.desc})`;
		});
		ctx.ui.notify(t("manager.status", { lines: lines.join("\n") }), "info");
		return;
	}

	// Command-line argument support: /m-mng enable|disable <id>
	if ((subCommand === "enable" || subCommand === "disable") && subArgs[1]) {
		const targetId = subArgs[1].toLowerCase();
		const target = items.find((i) => i.id.toLowerCase() === targetId);
		if (!target) {
			ctx.ui.notify(t("manager.unknownId", { id: targetId }), "warning");
			return;
		}
		target.enabled = subCommand === "enable";
		writePluginStates({ [target.id]: target.enabled });
		toggleHooks[target.id]?.(target.enabled);
		ctx.ui.notify(t("manager.toggled", { state: t(target.enabled ? "manager.enabled" : "manager.disabled"), name: display(target).name }), "info");
		return;
	}

	// Interactive menu mode
	if (!ctx.hasUI) {
		ctx.ui.notify(t("manager.requiresUI"), "warning");
		return;
	}

	let hasChanged = false;

	while (true) {
		items = loadRegistry();
		if (items.length === 0) {
			ctx.ui.notify(t("manager.invalidRegistry"), "error");
			return;
		}
		const options: { label: string; action: "toggle" | "enableAll" | "disableAll" | "done"; id?: string }[] = [];

		for (const item of items) {
			const mark = item.enabled ? `[✓ ${t("manager.on")}]` : `[  ${t("manager.off")}]`;
			const label = display(item);
			options.push({ label: `${mark} ${label.name} ── ${label.desc}`, action: "toggle", id: item.id });
		}

		options.push({ label: t("manager.enableAll"), action: "enableAll" });
		options.push({ label: t("manager.disableAll"), action: "disableAll" });
		options.push({ label: t("manager.done"), action: "done" });

		const selected = await ctx.ui.select(t("manager.title"), options.map(option => option.label));
		const choice = options.find(option => option.label === selected);

		if (!choice || choice.action === "done") {
			break;
		}

		if (choice.action === "enableAll" || choice.action === "disableAll") {
			for (const item of items) {
				item.enabled = choice.action === "enableAll";
			}
			writePluginStates(Object.fromEntries(items.map(item => [item.id, item.enabled])));
			hasChanged = true;
			continue;
		}

		// A specific extension item was toggled
		const target = items.find(item => item.id === choice.id);
		if (target) {
			target.enabled = !target.enabled;
			writePluginStates({ [target.id]: target.enabled });
			toggleHooks[target.id]?.(target.enabled);
			hasChanged = true;
		}
	}

	if (hasChanged) {
		ctx.ui.notify(t("manager.updated"), "info");
	}
}

export default function managerExtension(pi: ExtensionAPI) {
	pi.registerCommand("m-mng", {
		description: t("manager.description"),
		handler: async (args, ctx) => {
			try {
				await handleManagerCommand(args, ctx);
			} catch (error) {
				ctx.ui.notify(t("manager.saveFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
			}
		},
	});
}
