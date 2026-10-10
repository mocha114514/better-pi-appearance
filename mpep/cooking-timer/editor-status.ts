import type { TUI } from "@earendil-works/pi-tui";
import { createEditorBorder } from "../shared/editor-border.ts";

/** Share the idle-left slot with other editor-border extensions. */
export function createEditorStatus(tui: TUI, label: () => string): { sync(): boolean; dispose(): void } {
	return createEditorBorder(tui, { position: "idle-left", label });
}
