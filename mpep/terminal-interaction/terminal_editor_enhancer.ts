import { t } from "../shared/i18n/index.ts";
import { CustomEditor, copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { installCursorMarkerGuard } from "./cursor-marker-guard.ts";

interface EditorRange {
	startLine: number;
	startCol: number;
	endLine: number;
	endCol: number;
	selectedText: string;
}

export class StylizedDesignEditor extends CustomEditor {
	private readonly editorKeybindings: ConstructorParameters<typeof CustomEditor>[2];
	private readonly normalBorderColor: CustomEditor["borderColor"];
	private ctrlCPending: { timer: NodeJS.Timeout } | null = null;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		options?: ConstructorParameters<typeof CustomEditor>[3],
	) {
		super(tui, theme, keybindings, options);
		this.editorKeybindings = keybindings;
		this.normalBorderColor = theme.borderColor;
		// Enable the terminal hardware cursor display
		tui.setShowHardwareCursor(true);
		// Send the DECSCUSR control sequence: \x1b[5 q for a blinking bar cursor
		tui.terminal.write("\x1b[5 q");
	}

	/**
	 * Get the text selection range within the current input box.
	 * Computes precisely via the TUI layout tree and coordinate mapping first, with string matching as a fallback.
	 */
	private getEditorSelectionRange(): EditorRange | null {
		const tui = (this as any).tui;
		if (!tui || typeof tui.hasActiveSelection !== "function" || !tui.hasActiveSelection()) {
			return null;
		}

		const selectedText: string | undefined =
			typeof tui.getActiveSelectionText === "function" ? tui.getActiveSelectionText() : undefined;
		if (!selectedText) return null;

		const selection = typeof tui.getSelectionBounds === "function" ? tui.getSelectionBounds() : undefined;
		// If the selection is inside a ScrollView (e.g. the chat history area), it can never be the input box's selection
		if (selection?.start?.scrollView !== undefined) {
			return null;
		}

		// Precise layout coordinate matching:
		// Find the input box, or a container Box that includes it, in the layout tree
		if (selection && tui.currentLayout) {
			const box = this.findComponentBox(tui.currentLayout.root, this);
			if (box?.rect) {
				const topRow = box.rect.y;
				const bottomRow = box.rect.y + box.rect.height - 1;
				// The selection must lie within the row range occupied by the input box
				if (selection.start.row >= topRow && selection.end.row <= bottomRow) {
					const isBoundary = Boolean(selection.end?.boundary);
					const startPos = this.cellToLogicalPos(selection.start.row - topRow, selection.start.col - box.rect.x, false);
					const endPos = this.cellToLogicalPos(
						selection.end.row - topRow,
						selection.end.col - box.rect.x,
						true,
						isBoundary,
					);
					if (startPos && endPos) {
						const isBefore =
							startPos.line < endPos.line || (startPos.line === endPos.line && startPos.col <= endPos.col);
						const start = isBefore ? startPos : endPos;
						const end = isBefore ? endPos : startPos;
						if (start.line !== end.line || start.col !== end.col) {
							// Slice the exact text directly from the input box's memory, avoiding edge whitespace from terminal copying
							const lines: string[] = (this as any).state?.lines ?? [];
							let exactSelectedText = "";
							if (start.line === end.line) {
								exactSelectedText = (lines[start.line] ?? "").slice(start.col, end.col);
							} else {
								const parts = [
									(lines[start.line] ?? "").slice(start.col),
									...lines.slice(start.line + 1, end.line),
									(lines[end.line] ?? "").slice(0, end.col),
								];
								exactSelectedText = parts.join("\n");
							}

							return {
								startLine: start.line,
								startCol: start.col,
								endLine: end.line,
								endCol: end.col,
								selectedText: exactSelectedText || selectedText,
							};
						}
					}
				}
			}
		}

		// Fallback: find the matching fragment in the current text (trimming possibly redundant leading/trailing whitespace)
		const fullText = this.getText();
		const targetMatch = selectedText.trim() || selectedText;
		if (fullText.includes(targetMatch)) {
			const lines: string[] = (this as any).state?.lines ?? [];
			const idx = fullText.indexOf(targetMatch);
			if (idx !== -1) {
				let charCount = 0;
				let startLine = 0;
				let startCol = 0;
				let foundStart = false;

				for (let i = 0; i < lines.length; i++) {
					const lineLen = lines[i].length + (i < lines.length - 1 ? 1 : 0);
					if (!foundStart && charCount + lineLen > idx) {
						startLine = i;
						startCol = idx - charCount;
						foundStart = true;
					}
					if (foundStart && charCount + lineLen >= idx + targetMatch.length) {
						return {
							startLine,
							startCol,
							endLine: i,
							endCol: idx + targetMatch.length - charCount,
							selectedText: targetMatch,
						};
					}
					charCount += lineLen;
				}
			}
		}

		return null;
	}

	/**
	 * Convert grid coordinates (relY, relX) relative to the input box into a logical line and character column
	 * @param isEnd Whether this is the selection's end point. If true and not boundary, the cursor must include the current character (use the boundary after the character)
	 * @param isBoundary Whether the selection endpoint already sits on a character boundary
	 */
	private cellToLogicalPos(
		relY: number,
		relX: number,
		isEnd = false,
		isBoundary = false,
	): { line: number; col: number } | null {
		const visibleLineCount = (this as any).renderedVisibleLineCount ?? 1;
		// The first border row is the top border (relY = 0), text rows run 1 to visibleLineCount, and the bottom border is visibleLineCount + 1
		const clampedY = Math.max(1, Math.min(visibleLineCount, relY));

		const scrollOffset = (this as any).scrollOffset ?? 0;
		const visualLineIndex = scrollOffset + clampedY - 1;
		const visualLines =
			typeof (this as any).buildVisualLineMap === "function"
				? (this as any).buildVisualLineMap((this as any).lastWidth ?? 80)
				: null;

		if (!visualLines || !visualLines[visualLineIndex]) return null;

		const visualLine = visualLines[visualLineIndex];
		const lines: string[] = (this as any).state?.lines ?? [];
		const logicalLine = lines[visualLine.logicalLine] ?? "";
		const chunkEnd = visualLine.startCol + visualLine.length;
		const chunk = logicalLine.slice(visualLine.startCol, chunkEnd);

		const paddingX = (this as any).paddingX ?? 0;
		const targetColumn = Math.max(0, relX - paddingX);

		let visibleColumn = 0;
		let targetIndex = chunk.length;

		if (typeof (this as any).segment === "function") {
			for (const grapheme of (this as any).segment(chunk, "grapheme")) {
				const nextColumn = visibleColumn + visibleWidth(grapheme.segment);
				if (targetColumn < nextColumn) {
					// Key point: JavaScript's string.slice(start, end) uses a half-open interval [start, end).
					// When the selection endpoint lands on a character, end must point past that character; otherwise it gets excluded from the selection and the last character can never be deleted!
					targetIndex = isEnd && !isBoundary ? grapheme.index + grapheme.segment.length : grapheme.index;
					break;
				}
				visibleColumn = nextColumn;
			}
		} else {
			targetIndex = Math.min(targetColumn, chunk.length);
		}

		return {
			line: visualLine.logicalLine,
			col: visualLine.startCol + targetIndex,
		};
	}

	/**
	 * Recursively find the LayoutBox for the given component (or a container that includes it) in the TUI layout tree
	 */
	private findComponentBox(box: any, target: any): any {
		if (!box) return undefined;
		if (box.component === target) return box;
		// Support container components (e.g. editorContainer.children includes target)
		if (box.component?.children && Array.isArray(box.component.children) && box.component.children.includes(target)) {
			return box;
		}
		if (Array.isArray(box.children)) {
			for (const child of box.children) {
				const found = this.findComponentBox(child, target);
				if (found) return found;
			}
		}
		return undefined;
	}

	/**
	 * Atomically excise the selected text, move the cursor exactly to the selection start, and clear the terminal's highlighted selection
	 */
	private deleteSelectionRange(range: EditorRange): void {
		if (typeof (this as any).pushUndoSnapshot === "function") {
			(this as any).pushUndoSnapshot();
		}

		const lines: string[] = (this as any).state?.lines ?? [];
		const startLineText = lines[range.startLine] ?? "";
		const endLineText = lines[range.endLine] ?? "";

		const prefix = startLineText.slice(0, range.startCol);
		const suffix = endLineText.slice(range.endCol);
		const mergedLine = prefix + suffix;

		lines.splice(range.startLine, range.endLine - range.startLine + 1, mergedLine);
		if (lines.length === 0) lines.push("");

		// Move the cursor exactly back to the selection start
		(this as any).state.cursorLine = range.startLine;
		if (typeof (this as any).setCursorCol === "function") {
			(this as any).setCursorCol(range.startCol);
		} else {
			(this as any).state.cursorCol = range.startCol;
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		this.clearActiveSelection();
	}

	/**
	 * Clear the TUI-level selection highlight (anchor/focus state) and request a re-render.
	 * Shared by the cut path and both copy paths so the highlight always disappears after the action.
	 */
	private clearActiveSelection(): void {
		const tui = this.tui as typeof this.tui & { clearTextSelection?: () => void };
		if (tui && typeof tui.clearTextSelection === "function") {
			tui.clearTextSelection();
		}
		tui?.requestRender?.();
	}

	override handleInput(data: string): void {
		const tui = this.tui as typeof this.tui &
			Partial<Pick<TuiAltScreen, "flash" | "hasActiveSelection" | "copyActiveSelectionToClipboard">>;

		// 1. If the double-confirm exit is pending
		if (this.ctrlCPending) {
			// Pressing Ctrl+C again -> confirm exit
			if (this.editorKeybindings.matches(data, "app.clear")) {
				clearTimeout(this.ctrlCPending.timer);
				this.ctrlCPending = null;
				tui?.flash?.(t("editor.exiting"));
				const exitHandler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (exitHandler) {
					exitHandler();
					return;
				}
				return super.handleInput(data);
			}

			// Pressing Escape -> cancel the exit confirmation and protect the text
			if (matchesKey(data, "escape") || this.editorKeybindings.matches(data, "app.interrupt")) {
				clearTimeout(this.ctrlCPending.timer);
				this.ctrlCPending = null;
				tui?.flash?.(t("editor.exitCancelled"), 1500);
				tui?.requestRender?.();
				return;
			}

			// Pressing any other key -> cancel the exit confirmation and continue processing that key normally
			clearTimeout(this.ctrlCPending.timer);
			this.ctrlCPending = null;
			tui?.requestRender?.();
		}

		// 2. Check whether a selection is active
		const selection = this.getEditorSelectionRange();

		// 3. Ctrl+C handling:
		// With a selection (inside the input box or a global chat-area selection) -> copy the selection to the clipboard, never clear the input area;
		// Without a selection -> trigger the double-confirm exit to prevent accidental clearing
		if (this.editorKeybindings.matches(data, "app.clear")) {
			if (selection?.selectedText) {
				void copyToClipboard(selection.selectedText);
				tui?.flash?.(t("editor.copied"));
				// Clear the selection highlight after copying, returning to the natural no-selection state
				this.clearActiveSelection();
				return;
			}

			// If the current highlighted selection belongs to the chat history/output area, copy it as well
			if (tui && typeof tui.hasActiveSelection === "function" && tui.hasActiveSelection()) {
				if (typeof tui.copyActiveSelectionToClipboard === "function") {
					void tui.copyActiveSelectionToClipboard();
					// Clear the selection highlight after copying, returning to the natural no-selection state
					this.clearActiveSelection();
					return;
				}
			}

			// With no selection anywhere: start the double confirmation to protect the input text!
			this.ctrlCPending = {
				timer: setTimeout(() => {
					this.ctrlCPending = null;
					tui?.requestRender?.();
				}, 3000),
			};
			tui?.flash?.(t("editor.exitHint"), 3000);
			tui?.requestRender?.();
			return;
		}

		// 4. Ctrl+X cut handling:
		// With a selection -> copy to the clipboard + delete the selection + show only the Cut! hint
		// Without a selection -> keep the native message-copy behavior
		const isCtrlX = data === "\x18" || this.editorKeybindings.matches(data, "app.message.copy");
		if (isCtrlX && selection?.selectedText) {
			void copyToClipboard(selection.selectedText);
			this.deleteSelectionRange(selection);
			tui?.flash?.(t("editor.cut"));
			return;
		}

		// 5. Cross-platform undo: support the generic Ctrl+- / Ctrl+_ and the system-configured undo key (Ctrl+Z on Windows)
		if (
			matchesKey(data, "ctrl+-") ||
			matchesKey(data, "ctrl+_") ||
			this.editorKeybindings.matches(data, "tui.editor.undo")
		) {
			(this as any).undo?.();
			return;
		}

		// 6. Backspace / delete with a selection: excise the selection content directly, leaving the cursor at its start
		const isBackspace =
			this.editorKeybindings.matches(data, "tui.editor.deleteCharBackward") ||
			matchesKey(data, "backspace") ||
			matchesKey(data, "shift+backspace") ||
			data === "\x7f" ||
			data === "\b";
		const isDelete =
			this.editorKeybindings.matches(data, "tui.editor.deleteCharForward") ||
			matchesKey(data, "delete") ||
			matchesKey(data, "shift+delete") ||
			data === "\x1b[3~";

		if (selection && (isBackspace || isDelete)) {
			this.deleteSelectionRange(selection);
			return;
		}

		// 7. Paste / typed input over a selection: excise the selection first, move the cursor back to its start, then insert the new characters
		const isPaste = data.includes("\x1b[200~");
		const isPrintable = !data.startsWith("\x1b") && data.length >= 1 && data.charCodeAt(0) >= 32;

		if (selection && (isPaste || isPrintable)) {
			this.deleteSelectionRange(selection);
		}

		return super.handleInput(data);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		// While the double-confirm exit is pending, show a highlighted warning bar in the top border
		if (this.ctrlCPending) {
			const warning = t("editor.exitBorder");
			const warningLen = visibleWidth(warning);
			if (width >= warningLen + 4) {
				const leftDash = Math.max(1, Math.floor((width - warningLen) / 2));
				const rightDash = Math.max(1, width - warningLen - leftDash);
				const yellowWarning = `\x1b[1;33m${warning}\x1b[0m`;
				return this.borderColor("─".repeat(leftDash)) + yellowWarning + this.borderColor("─".repeat(rightDash));
			}
		}
		return super.renderTopBorder(width, hiddenLineCount);
	}

	render(width: number): string[] {
		// Pi reapplies thinking colors; keep normal input neutral and preserve command-mode colors.
		if (!this.getText().trimStart().startsWith("!")) {
			this.borderColor = this.normalBorderColor;
		}
		const lines = super.render(width);
		// Remove the ANSI inverse-video block style (\x1b[7m) but keep the CURSOR_MARKER, so the terminal's hardware bar cursor aligns precisely with the text position
		return lines.map((line) =>
			line.replace(/(\x1b_pi:c\x07)?\x1b\[7m([^\x1b]+)\x1b\[0m/g, (_match, marker, char) => {
				return (marker || "") + char;
			}),
		);
	}
}

export function setupEditorEnhancements(pi: ExtensionAPI): () => void {
	// Send the sequence restoring the default cursor style to the terminal on process exit
	const restoreCursor = () => {
		process.stdout.write("\x1b[0 q");
	};
	process.on("exit", restoreCursor);

	// StylizedDesignEditor removes the inverse-video cursor block, which is what normally keeps a
	// duplicated CURSOR_MARKER harmless: see cursor-marker-guard.ts for the full explanation.
	const disposeCursorMarkerGuard = installCursorMarkerGuard();
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent(
			(tui, theme, kb) => new StylizedDesignEditor(tui, theme, kb, { embedWorkingStatus: true }),
		);
	});
	return () => {
		process.off("exit", restoreCursor);
		disposeCursorMarkerGuard();
	};
}
