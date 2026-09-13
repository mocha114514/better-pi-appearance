// Visual-only collapse in the input editor: complete absolute image paths only.
// The buffer always keeps the original text; sent transcript uses the full rules.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, hyperlink } from "@earendil-works/pi-tui";
import { type EditorVisualLineMap, setEditorVisualMapProvider } from "../shared/editor-visual-map.ts";
import {
	collapseLineVisual,
	encodePathHref,
	findCollapsibleTokens,
	displayName,
	displayNameForUrl,
	normalizeWebUrl,
} from "./paths.ts";

type PathTheme = Pick<Theme, "fg">;

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface EditorInternals {
	state: EditorState;
}

interface VisualFrame {
	saved: EditorState;
	maps: EditorVisualLineMap[];
}

const patchSlot = Symbol.for("mpep.path-links.editor");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;
const frames = new WeakMap<Editor, VisualFrame>();
let themeFor: (() => PathTheme) | undefined;

function snapshot(state: EditorState): EditorState {
	return { lines: state.lines, cursorLine: state.cursorLine, cursorCol: state.cursorCol };
}

const EDITOR_MODE = "absolute-images" as const;

function mapsFor(state: EditorState): EditorVisualLineMap[] {
	return state.lines.map((line, index) =>
		collapseLineVisual(line, index === state.cursorLine ? state.cursorCol : undefined, EDITOR_MODE),
	);
}

function applyVisual(editor: Editor): VisualFrame {
	const internals = editor as unknown as EditorInternals;
	const saved = snapshot(internals.state);
	const maps = mapsFor(saved);
	const current = maps[saved.cursorLine] ?? maps[0];
	internals.state.lines = maps.map((map) => map.visual);
	internals.state.cursorCol = current?.toVisual[Math.min(saved.cursorCol, saved.lines[saved.cursorLine]?.length ?? 0)] ?? 0;
	const frame = { saved, maps };
	frames.set(editor, frame);
	return frame;
}

function restoreLogical(editor: Editor, frame: VisualFrame): void {
	const internals = editor as unknown as EditorInternals;
	internals.state.lines = frame.saved.lines;
	internals.state.cursorLine = frame.saved.cursorLine;
	internals.state.cursorCol = frame.saved.cursorCol;
}

function hrefFor(token: { text: string; kind: "file" | "url" }): string {
	return token.kind === "url" ? normalizeWebUrl(token.text) : encodePathHref(token.text);
}

function displayFor(token: { text: string; kind: "file" | "url" }): string {
	const name = token.kind === "url" ? displayNameForUrl(token.text) : displayName(token.text);
	return name.replace(/[\[\]]/g, "") || token.text;
}

function decorateLine(line: string, chips: Array<{ display: string; href: string }>, theme: PathTheme): string {
	if (chips.length === 0 || line.includes("\x1b]8;")) return line;
	const sorted = [...chips].sort((a, b) => b.display.length - a.display.length);
	let result = line;
	for (const chip of sorted) {
		if (!chip.display || !result.includes(chip.display)) continue;
		const styled = hyperlink(theme.fg("mdLink", `\x1b[4m${chip.display}\x1b[24m`), chip.href);
		result = result.split(chip.display).join(styled);
	}
	return result;
}

function chipsFor(state: EditorState): Array<{ display: string; href: string }> {
	const chips: Array<{ display: string; href: string }> = [];
	for (const [index, line] of state.lines.entries()) {
		const cursor = index === state.cursorLine ? state.cursorCol : undefined;
		for (const token of findCollapsibleTokens(line, EDITOR_MODE)) {
			if (cursor !== undefined && cursor >= token.start && cursor < token.end) continue;
			chips.push({ display: displayFor(token), href: hrefFor(token) });
		}
	}
	return chips;
}

export function installEditorPathChips(theme: () => PathTheme): () => void {
	patches[patchSlot]?.();
	themeFor = theme;
	// Publish the maps of the frame that is currently on screen, so other plugins can translate screen
	// cells back into buffer positions (see mpep/shared/editor-visual-map.ts).
	const disposeVisualMap = setEditorVisualMapProvider((editor) =>
		editor instanceof Editor ? frames.get(editor)?.maps : undefined,
	);
	const proto = Editor.prototype as unknown as {
		layoutText: (width: number) => unknown;
		handleMouse: (event: unknown) => unknown;
		render: (width: number) => string[];
	};
	const originalLayoutText = proto.layoutText;
	const originalHandleMouse = proto.handleMouse;
	const originalRender = proto.render;

	proto.layoutText = function (this: Editor, width: number): unknown {
		const frame = applyVisual(this);
		try {
			return originalLayoutText.call(this, width);
		} finally {
			restoreLogical(this, frame);
		}
	};

	proto.handleMouse = function (this: Editor, event: unknown): unknown {
		const internals = this as unknown as EditorInternals;
		const frame = applyVisual(this);
		try {
			return originalHandleMouse.call(this, event);
		} finally {
			const visualLine = internals.state.cursorLine;
			const visualCol = internals.state.cursorCol;
			restoreLogical(this, frame);
			const map = frame.maps[visualLine];
			if (!map) return;
			const logicalCol = map.toLogical[Math.max(0, Math.min(visualCol, map.toLogical.length - 1))] ?? 0;
			internals.state.cursorLine = visualLine;
			internals.state.cursorCol = logicalCol;
		}
	};

	proto.render = function (this: Editor, width: number): string[] {
		const internals = this as unknown as EditorInternals;
		const chips = chipsFor(internals.state);
		const lines = originalRender.call(this, width);
		const theme = themeFor?.();
		if (!chips.length || !theme) return lines;
		return lines.map((line) => decorateLine(line, chips, theme));
	};

	const dispose = () => {
		proto.layoutText = originalLayoutText;
		proto.handleMouse = originalHandleMouse;
		proto.render = originalRender;
		disposeVisualMap();
		themeFor = undefined;
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
