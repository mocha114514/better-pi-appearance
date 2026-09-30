/**
 * Compatibility bridge: fold-aware renderers exposed on `globalThis` for MCP extensions.
 *
 * Extensions cannot import from each other, so turn-fold publishes its compact tool
 * renderers here; an MCP extension without its own renderers can adopt them by reading
 * `globalThis.__minimalToolsCoordinator` and delegating its renderCall/renderResult.
 *
 * Status: speculative. No known consumer has ever existed — pi-mcp-adapter and pi's
 * official MCP extension both ship their own renderers. Kept in case a future MCP
 * extension wants the integration; safe to delete once that is clearly never needed.
 */
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ToolPresentationContext } from "./extension_types.ts";
import { createResultMouseRegion, createToolCallMouseRegion } from "./mouse_interaction_handler.ts";
import { type DisplayTheme, getLatestTheme, setLatestTheme } from "./summary_preview_renderer.ts";
import { getResultText, getTurnId, turnStates } from "./turn_state_manager.ts";

interface Coordinator {
	handleMcpCall(
		lines: string[],
		theme: DisplayTheme | undefined,
		context: ToolPresentationContext,
	): Text | ReturnType<typeof createToolCallMouseRegion>;
	handleMcpResult(
		result: unknown,
		options: ToolRenderResultOptions,
		theme: DisplayTheme | undefined,
		context: ToolPresentationContext,
	): Text | ReturnType<typeof createResultMouseRegion>;
}

export function setupMcpCoordinator(): () => void {
	const host = globalThis as typeof globalThis & { __minimalToolsCoordinator?: Coordinator };
	const previous = host.__minimalToolsCoordinator;
	const coordinator: Coordinator = {
		handleMcpCall(lines, theme, context) {
			if (theme) setLatestTheme(theme);
			const turnId = getTurnId(context.toolCallId);
			const text = lines[0] ?? "mcp";
			const component = new Text(text, 0, 0);
			return turnId === undefined
				? component
				: createToolCallMouseRegion(component, context.toolCallId, turnId, text, context);
		},
		handleMcpResult(result, _options, theme, context) {
			if (theme) setLatestTheme(theme);
			const turnId = getTurnId(context.toolCallId);
			const tool = turnId === undefined ? undefined : turnStates.get(turnId)?.tools.get(context.toolCallId);
			if (tool && !tool.isExpanded) return new Text("", 0, 0);
			const output = getResultText(result);
			const component = new Text(
				output ? `\n${getLatestTheme().fg(tool?.isError || context.isError ? "error" : "toolOutput", output)}` : "",
				0,
				0,
			);
			return turnId === undefined ? component : createResultMouseRegion(component, turnId);
		},
	};
	host.__minimalToolsCoordinator = coordinator;
	return () => {
		if (host.__minimalToolsCoordinator === coordinator) {
			if (previous) host.__minimalToolsCoordinator = previous;
			else delete host.__minimalToolsCoordinator;
		}
	};
}
