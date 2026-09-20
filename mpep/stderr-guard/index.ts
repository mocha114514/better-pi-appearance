// Stderr Guard: Intercepts raw stderr writes to prevent TUI tearing,
// displays top-right transient toast alerts, and provides a scrollable log modal.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";
import { stderrBuffer } from "./buffer.ts";
import { installStderrInterceptor } from "./interceptor.ts";
import { showStderrModal } from "./modal.ts";

const BRIDGE_WIDGET_KEY = "mpep.stderr-guard.tui-bridge";

export default function stderrGuard(pi: ExtensionAPI): void {
	if (!isPluginEnabled("stderr-guard")) return;

	let activeTui: TUI | undefined;

	// Install the interceptor immediately upon extension load to catch early MCP/library warnings
	const uninstall = installStderrInterceptor(() => activeTui);

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		// Acquire TUI reference via transient widget bridge
		ctx.ui.setWidget(BRIDGE_WIDGET_KEY, (tui) => {
			activeTui = tui;
			return { render: () => [], invalidate() {} };
		});
		ctx.ui.setWidget(BRIDGE_WIDGET_KEY, undefined);
	});

	pi.on("session_shutdown", () => {
		activeTui = undefined;
		uninstall();
	});

	// Register /m-stderr command so users can review captured logs at any time
	pi.registerCommand("m-stderr", {
		description: t("stderr.commandDesc"),
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || !activeTui) {
				const plain = stderrBuffer.toPlainText();
				if (!plain) {
					ctx.ui.notify(t("stderr.empty"), "info");
				} else {
					ctx.ui.notify(plain, "info");
				}
				return;
			}

			showStderrModal(activeTui);
		},
	});
}
