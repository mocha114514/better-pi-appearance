import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { registerBuiltInTools } from "./builtin_tools_override.ts";
import { orderedSessionEntries } from "./compaction_placement.ts";
import { completeProcessFolds } from "./process_fold_state.ts";
import { applyPatches } from "./core_components_patcher.ts";
import { setupMcpCoordinator } from "./mcp_tools_coordinator.ts";
import { resetMouseTiming } from "./mouse_interaction_handler.ts";
// Note: editor/keyboard enhancements were extracted into the standalone
// "terminal-interaction" plugin (see ../terminal-interaction/).
import { setLatestTheme } from "./summary_preview_renderer.ts";
import {
	endLiveCollection,
	finishAssistant,
	observeAssistant,
	observeToolResult,
	resetTurnState,
	sealActiveGroup,
	syncFromSessionHistory,
} from "./turn_state_manager.ts";

export default function (pi: ExtensionAPI): void {
	if (!isPluginEnabled("turn-fold")) return;
	const disposePatches = applyPatches();
	// Note: Markdown rendering enhancements were extracted into the standalone
	// "markdown-enhancer" plugin (see ../markdown-enhancer/).
	const disposeMcp = setupMcpCoordinator();
	registerBuiltInTools(pi);
	const restoreSession = (_event: unknown, ctx: ExtensionContext) => {
		resetMouseTiming();
		setLatestTheme(ctx.ui.theme);
		// Fold state must mirror what Pi paints, not the raw branch: see orderedSessionEntries.
		syncFromSessionHistory(orderedSessionEntries(ctx.sessionManager), !ctx.isIdle());
	};
	pi.on("session_start", restoreSession);
	pi.on("session_compact", restoreSession);
	pi.on("session_tree", restoreSession);
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") observeAssistant(event.message, true);
		else if (event.message.role !== "toolResult") {
			sealActiveGroup();
			// Steering / follow-ups close the previous disclosure immediately, not at agent_end.
			completeProcessFolds();
		}
	});
	pi.on("message_update", (event) => {
		if (event.message.role === "assistant") observeAssistant(event.message);
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") finishAssistant(event.message);
		else if (event.message.role === "toolResult")
			observeToolResult(event.message.toolCallId, event.message, false, event.message.isError);
	});
	pi.on("tool_execution_update", (event) => observeToolResult(event.toolCallId, event.partialResult, true, false));
	pi.on("tool_execution_end", (event) => observeToolResult(event.toolCallId, event.result, false, event.isError));
	pi.on("agent_end", endLiveCollection);
	pi.on("session_shutdown", () => {
		disposePatches();
		disposeMcp();
		resetTurnState();
	});
}
