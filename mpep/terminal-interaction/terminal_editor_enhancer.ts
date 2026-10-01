import { t } from "../shared/i18n/index.ts";
import { type EditorVisualLineMap, getEditorVisualLineMaps } from "../shared/editor-visual-map.ts";
import { CustomEditor, copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import { installCursorMarkerGuard } from "./cursor-marker-guard.ts";

interface EditorRange {
	startLine: number;
	startCol: number;
	endLine: number;
	endCol: number;
	selectedText: string;
}

/**
 * Editor-internal selection (logical buffer coordinates), currently only produced by Ctrl+A.
 *
 * Why not reuse the terminal-native drag selection: the TuiAltScreen selection API is private and,
 * more importantly, it operates on rendered screen rows. Editor lines scrolled out of the input
 * box's visible window are not part of the rendered document at all, so a native "select all"
 * could never cover them. An internal selection covers the whole buffer and flows through the
 * same delete/copy/replace pipeline as the native selection (see handleInput).
 */
interface InternalSelection {
	anchorLine: number;
	anchorCol: number;
	focusLine: number;
	focusCol: number;
}

export class StylizedDesignEditor extends CustomEditor {
	private readonly editorKeybindings: ConstructorParameters<typeof CustomEditor>[2];
	private readonly normalBorderColor: CustomEditor["borderColor"];
	private ctrlCPending: { timer: NodeJS.Timeout } | null = null;
	private internalSelection: InternalSelection | null = null;

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

		// The rows on screen show the *reshaped* text when a plugin collapses part of the buffer for display
		// (path-links turns absolute image paths into chips), so the layout has to be computed from that same
		// text and the hit column has to be translated back through the collapse table. Using the logical
		// lines instead shifts the row (different wrap points) and the column (collapsed characters), which
		// made every copied or cut selection resolve to a neighbouring buffer range.
		const maps = getEditorVisualLineMaps(this);
		const row = this.layOutRowAt(visualLineIndex, maps);
		if (!row) return null;

		const paddingX = (this as any).paddingX ?? 0;
		const targetColumn = Math.max(0, relX - paddingX);

		let visibleColumn = 0;
		let targetIndex = row.text.length;

		if (typeof (this as any).segment === "function") {
			for (const grapheme of (this as any).segment(row.text, "grapheme")) {
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
			targetIndex = Math.min(targetColumn, row.text.length);
		}

		const visualCol = row.startCol + targetIndex;
		const map = maps?.[row.line];
		// `toLogical` covers every visual offset plus the line end, so the clamped lookup always resolves.
		const col = map
			? (map.toLogical[Math.max(0, Math.min(visualCol, map.toLogical.length - 1))] ?? visualCol)
			: visualCol;

		return {
			line: row.line,
			col,
		};
	}

	/**
	 * Resolve a rendered row index into its buffer line plus the text chunk drawn on that row.
	 *
	 * When a plugin reshapes the buffer for display, the editor's own wrapping helper has to see the
	 * reshaped lines during the call, because it wraps `state.lines` directly. The temporary swap mirrors
	 * what path-links/editor.ts does around `Editor.handleMouse`.
	 */
	private layOutRowAt(
		rowIndex: number,
		maps: readonly EditorVisualLineMap[] | undefined,
	): { line: number; startCol: number; text: string } | null {
		const internals = this as any;
		if (typeof internals.buildVisualLineMap !== "function") return null;

		const logicalLines: string[] = internals.state?.lines ?? [];
		const visualLines = maps?.map((map) => map.visual);
		const sourceLines = visualLines ?? logicalLines;

		let row: { logicalLine: number; startCol: number; length: number } | undefined;
		try {
			if (visualLines) internals.state.lines = visualLines;
			row = internals.buildVisualLineMap(internals.lastWidth ?? 80)[rowIndex];
		} finally {
			if (visualLines) internals.state.lines = logicalLines;
		}
		if (!row) return null;

		const line = sourceLines[row.logicalLine] ?? "";
		return { line: row.logicalLine, startCol: row.startCol, text: line.slice(row.startCol, row.startCol + row.length) };
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
	 * Also collapses the editor-internal selection (Ctrl+A) so both selection kinds stay in sync.
	 */
	private clearActiveSelection(): void {
		this.internalSelection = null;
		const tui = this.tui as typeof this.tui & { clearTextSelection?: () => void };
		if (tui && typeof tui.clearTextSelection === "function") {
			tui.clearTextSelection();
		}
		tui?.requestRender?.();
	}

	/**
	 * Collapse only the editor-internal selection (used when the mouse takes over: press/click).
	 */
	private clearInternalSelection(): void {
		if (!this.internalSelection) return;
		this.internalSelection = null;
		this.tui?.requestRender?.();
	}

	/**
	 * Ctrl+A: select the entire buffer and move the cursor to the selection end, like desktop editors.
	 * This intentionally overrides pi's default ctrl+a binding (cursor to line start, emacs style);
	 * line-start movement stays reachable via Home / Ctrl+Home.
	 */
	private selectAllBuffer(): void {
		const lines: string[] = (this as any).state?.lines ?? [];
		const lastLine = Math.max(0, lines.length - 1);
		const lastCol = (lines[lastLine] ?? "").length;
		// Empty buffer: nothing to select
		if (lastLine === 0 && lastCol === 0) return;
		this.internalSelection = { anchorLine: 0, anchorCol: 0, focusLine: lastLine, focusCol: lastCol };
		(this as any).state.cursorLine = lastLine;
		if (typeof (this as any).setCursorCol === "function") {
			(this as any).setCursorCol(lastCol);
		} else {
			(this as any).state.cursorCol = lastCol;
		}
		this.tui?.requestRender?.();
	}

	/**
	 * Normalize the editor-internal selection into an EditorRange (same shape the native drag
	 * selection produces), so every downstream consumer (copy / cut / delete / replace) works
	 * unchanged. Both ends are clamped into the current buffer, so a selection that went stale
	 * after an external buffer change (undo, history, programmatic setText) degrades gracefully;
	 * a fully out-of-range selection collapses to null.
	 */
	private getInternalSelectionRange(): EditorRange | null {
		const sel = this.internalSelection;
		if (!sel) return null;
		const lines: string[] = (this as any).state?.lines ?? [];
		if (lines.length === 0) {
			this.internalSelection = null;
			return null;
		}

		const anchorFirst =
			sel.anchorLine < sel.focusLine || (sel.anchorLine === sel.focusLine && sel.anchorCol <= sel.focusCol);
		const rawStart = anchorFirst ? { line: sel.anchorLine, col: sel.anchorCol } : { line: sel.focusLine, col: sel.focusCol };
		const rawEnd = anchorFirst ? { line: sel.focusLine, col: sel.focusCol } : { line: sel.anchorLine, col: sel.anchorCol };

		const clampPos = (pos: { line: number; col: number }) => {
			const line = Math.max(0, Math.min(pos.line, lines.length - 1));
			const col = Math.max(0, Math.min(pos.col, (lines[line] ?? "").length));
			return { line, col };
		};
		const start = clampPos(rawStart);
		const end = clampPos(rawEnd);
		if (start.line === end.line && start.col === end.col) {
			this.internalSelection = null;
			return null;
		}

		// Slice the exact text from the buffer (identical logic to the native-selection path)
		let selectedText = "";
		if (start.line === end.line) {
			selectedText = (lines[start.line] ?? "").slice(start.col, end.col);
		} else {
			const parts = [
				(lines[start.line] ?? "").slice(start.col),
				...lines.slice(start.line + 1, end.line),
				(lines[end.line] ?? "").slice(0, end.col),
			];
			selectedText = parts.join("\n");
		}

		return {
			startLine: start.line,
			startCol: start.col,
			endLine: end.line,
			endCol: end.col,
			selectedText,
		};
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

		// 2. Ctrl+A -> select the entire buffer. Overrides pi's default ctrl+a binding (cursor to line
		// start); line-start movement stays reachable via Home / Ctrl+Home.
		if (matchesKey(data, "ctrl+a")) {
			this.selectAllBuffer();
			return;
		}

		// 3. Check whether a selection is active: the editor-internal selection (Ctrl+A) wins over
		// the terminal-native drag selection, and both share the same EditorRange pipeline below.
		const selection = this.getInternalSelectionRange() ?? this.getEditorSelectionRange();

		// 4. Ctrl+C handling:
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

		// 5. Ctrl+X cut handling:
		// With a selection -> copy to the clipboard + delete the selection + show only the Cut! hint
		// Without a selection -> keep the native message-copy behavior
		const isCtrlX = data === "\x18" || this.editorKeybindings.matches(data, "app.message.copy");
		if (isCtrlX && selection?.selectedText) {
			void copyToClipboard(selection.selectedText);
			this.deleteSelectionRange(selection);
			tui?.flash?.(t("editor.cut"));
			return;
		}

		// 6. Cross-platform undo: support the generic Ctrl+- / Ctrl+_ and the system-configured undo key (Ctrl+Z on Windows)
		if (
			matchesKey(data, "ctrl+-") ||
			matchesKey(data, "ctrl+_") ||
			this.editorKeybindings.matches(data, "tui.editor.undo")
		) {
			// The buffer is about to change, so the internal selection would go stale
			this.internalSelection = null;
			(this as any).undo?.();
			return;
		}

		// 7. Backspace / delete with a selection: excise the selection content directly, leaving the cursor at its start
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

		// 8. Paste / typed input over a selection: excise the selection first, move the cursor back to its start, then insert the new characters
		const isPaste = data.includes("\x1b[200~");
		const isPrintable = !data.startsWith("\x1b") && data.length >= 1 && data.charCodeAt(0) >= 32;

		if (selection && (isPaste || isPrintable)) {
			this.deleteSelectionRange(selection);
		}

		// 9. Escape with an internal selection: collapse the selection only, instead of letting the
		// base editor trigger an interrupt (which could cancel a running generation).
		if (this.internalSelection && (matchesKey(data, "escape") || this.editorKeybindings.matches(data, "app.interrupt"))) {
			this.clearActiveSelection();
			return;
		}

		// Any key that reaches the base editor (cursor moves, history navigation, etc.) collapses
		// the internal selection first, mirroring desktop editors. (The copy/cut/delete paths above
		// already cleared it through clearActiveSelection / deleteSelectionRange.)
		if (this.internalSelection) {
			this.internalSelection = null;
			tui?.requestRender?.();
		}

		return super.handleInput(data);
	}

	/**
	 * Mouse handling: the base editor deliberately leaves press/drag/release unhandled so the
	 * renderer's native text selection keeps working over the input box, and it ignores wheel
	 * events entirely (they fall through to the chat-area scroll). We add two behaviors on top:
	 *
	 * 1. Wheel over the input box scrolls the editor's own viewport by exactly one visual line
	 *    per wheel event (only when the text actually overflows pi's height cap).
	 * 2. Press/click collapses the editor-internal selection (Ctrl+A), like desktop editors.
	 */
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const baseResult = super.handleMouse(event);
		if (baseResult) {
			// A click positions the cursor -> collapse any Ctrl+A selection
			if (event.type === "click") this.clearInternalSelection();
			return baseResult;
		}
		// Press/drag/release stay unhandled for the renderer's native selection, but a fresh press
		// still collapses the internal selection.
		if (event.type === "press") this.clearInternalSelection();
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		return this.scrollByWheel(event.wheelDelta);
	}

	/**
	 * Scroll the editor viewport by exactly one visual line per wheel event (the requested fixed
	 * step; the platform's delta magnitude is intentionally ignored, only the direction matters).
	 *
	 * Editor.render() force-pulls scrollOffset back whenever the cursor would leave the visible
	 * window, so a free-floating viewport is impossible without reimplementing render(). The
	 * standard-editor compromise instead: the cursor stays put until the scroll would push it out
	 * of the viewport, then it is dragged along by one line. This never fights render()'s
	 * cursor-follow logic because the cursor always stays visible.
	 *
	 * Returns undefined when the text does not overflow the editor's height cap, so the wheel
	 * event keeps its default behavior of scrolling the chat history.
	 */
	private scrollByWheel(wheelDelta: number): TuiMouseEventResult | undefined {
		const internals = this as any;
		if (typeof internals.layoutText !== "function") return undefined;
		// Mirror Editor.render(): max visible lines = 30% of the terminal height, minimum 5
		const maxVisibleLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		// layoutText is what render() uses (path-links hooks it to lay out the reshaped text), so
		// the line count and the cursor's visual index always match the frame on screen.
		const layoutLines: Array<{ hasCursor?: boolean }> = internals.layoutText(internals.lastWidth ?? 80) ?? [];
		if (layoutLines.length <= maxVisibleLines) return undefined;

		const maxScrollOffset = layoutLines.length - maxVisibleLines;
		const direction = wheelDelta < 0 ? -1 : 1;
		const oldOffset: number = internals.scrollOffset ?? 0;
		const newOffset = Math.max(0, Math.min(maxScrollOffset, oldOffset + direction));
		if (newOffset === oldOffset) {
			// At the scroll edge: still consume the event so the chat history doesn't jump-scroll
			// when the user keeps spinning the wheel inside the input box.
			return { handled: true, render: false };
		}
		internals.scrollOffset = newOffset;

		// Drag the cursor along by one line when the scroll would push it out of the viewport.
		const cursorVisualLine = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorVisualLine >= 0 && typeof internals.moveCursor === "function") {
			if (cursorVisualLine < newOffset) internals.moveCursor(1, 0);
			else if (cursorVisualLine >= newOffset + maxVisibleLines) internals.moveCursor(-1, 0);
		}
		return { handled: true, render: true };
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

	/**
	 * Paint the editor-internal selection onto the rendered rows with the same inverse-video style
	 * (\x1b[7m...\x1b[27m) that the renderer uses for the native drag selection.
	 *
	 * Row geometry: rendered[0] is the top border, rows 1..renderedVisibleLineCount are the text
	 * rows (layout lines scrollOffset..scrollOffset+count-1), then the bottom border and optional
	 * autocomplete rows follow. Each text row is `leftPadding + displayText + padding +
	 * rightPadding`, so cell 0 of the text sits at column paddingX.
	 *
	 * The selection lives in logical buffer coordinates while the rows show the *visual* text
	 * (path-links may collapse paths into chips), so columns are translated through the visual map
	 * the same way the mouse hit-testing already does.
	 */
	private overlaySelectionHighlight(rendered: string[], selection: EditorRange): string[] {
		const internals = this as any;
		const scrollOffset: number = internals.scrollOffset ?? 0;
		const visibleCount: number = internals.renderedVisibleLineCount ?? 0;
		const paddingX: number = internals.paddingX ?? 0;
		const maps = getEditorVisualLineMaps(this);
		const result = [...rendered];

		for (let row = 1; row <= visibleCount; row++) {
			const visualLineIndex = scrollOffset + row - 1;
			const layoutRow = this.layOutRowAt(visualLineIndex, maps);
			if (!layoutRow) continue;
			if (layoutRow.line < selection.startLine || layoutRow.line > selection.endLine) continue;

			const logicalLine: string = internals.state?.lines?.[layoutRow.line] ?? "";
			const map = maps?.[layoutRow.line];
			const toVisual = (logicalCol: number): number => {
				const clamped = Math.max(0, Math.min(logicalCol, logicalLine.length));
				if (!map) return clamped;
				return map.toVisual[Math.min(clamped, map.toVisual.length - 1)] ?? clamped;
			};

			const selStartVisual = layoutRow.line === selection.startLine ? toVisual(selection.startCol) : 0;
			const visualLineLength = map ? map.visual.length : logicalLine.length;
			const selEndVisual = layoutRow.line === selection.endLine ? toVisual(selection.endCol) : visualLineLength;

			// Intersect the selection with the visual column range this row actually shows
			const rowStart = layoutRow.startCol;
			const rowEnd = layoutRow.startCol + layoutRow.text.length;
			const hlStart = Math.max(selStartVisual, rowStart);
			const hlEnd = Math.min(selEndVisual, rowEnd);
			if (hlStart >= hlEnd) continue;

			const startCell = paddingX + visibleWidth(layoutRow.text.slice(0, hlStart - rowStart));
			const endCell = paddingX + visibleWidth(layoutRow.text.slice(0, hlEnd - rowStart));
			result[row] = StylizedDesignEditor.applyInverseRange(result[row], startCell, endCell);
		}
		return result;
	}

	/**
	 * Wrap the terminal cells [startCell, endCell) of a rendered row in inverse video.
	 * ANSI escape sequences (CSI colors, OSC-8 hyperlinks, pi's APC-style cursor marker) occupy
	 * no cells and are skipped; printable text is walked grapheme by grapheme so wide characters
	 * (CJK, emoji) count as two cells. SGR 27 only clears inverse, so any styling active around
	 * the highlighted span (chip colors, hyperlinks) survives untouched.
	 */
	private static applyInverseRange(row: string, startCell: number, endCell: number): string {
		// CSI (\x1b[...final), OSC (\x1b]...BEL/ST), APC-style (\x1b_...BEL/ST, e.g. the cursor marker)
		const escapeRe = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/y;
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		let out = "";
		let col = 0;
		let i = 0;
		let inSelection = false;
		while (i < row.length) {
			escapeRe.lastIndex = i;
			const escapeMatch = escapeRe.exec(row);
			if (escapeMatch && escapeMatch.index === i) {
				out += escapeMatch[0];
				i += escapeMatch[0].length;
				continue;
			}
			const grapheme = segmenter.segment(row.slice(i)).containing(0)?.segment ?? row[i];
			const cellStart = col;
			const cellEnd = col + visibleWidth(grapheme);
			const selected = cellStart < endCell && cellEnd > startCell;
			if (selected && !inSelection) {
				out += "\x1b[7m";
				inSelection = true;
			} else if (!selected && inSelection) {
				out += "\x1b[27m";
				inSelection = false;
			}
			out += grapheme;
			col = cellEnd;
			i += grapheme.length;
		}
		if (inSelection) out += "\x1b[27m";
		return out;
	}

	render(width: number): string[] {
		// Pi reapplies thinking colors; keep normal input neutral and preserve command-mode colors.
		if (!this.getText().trimStart().startsWith("!")) {
			this.borderColor = this.normalBorderColor;
		}
		// Remove the ANSI inverse-video block style (\x1b[7m) but keep the CURSOR_MARKER, so the terminal's hardware bar cursor aligns precisely with the text position
		const lines = super
			.render(width)
			.map((line) =>
				line.replace(/(\x1b_pi:c\x07)?\x1b\[7m([^\x1b]+)\x1b\[0m/g, (_match, marker, char) => {
					return (marker || "") + char;
				}),
			);
		// Paint the Ctrl+A selection on top (after the cursor-block strip, so the two inverse-video
		// users never confuse each other's sequences)
		const selection = this.getInternalSelectionRange();
		if (!selection) return lines;
		return this.overlaySelectionHighlight(lines, selection);
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
