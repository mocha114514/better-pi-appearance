// Guards the fullscreen (alt-screen) renderer against a leaked hardware-cursor marker.
//
// Why this patch exists
// ---------------------
// A focused editor emits the zero-width token CURSOR_MARKER (`\x1b_pi:c\x07`, an APC sequence) at the
// hardware-cursor position. `TuiBase.extractCursorPosition()` is supposed to pull that token out of the
// rendered frame and turn it into a cursor position, so the token itself never reaches the terminal.
//
// While a mouse text selection is active, `TuiAltScreen.applySelection()` slices every rendered line into
// before/selected/after pieces via `sliceWithWidth()`. That helper rescans the line from column 0 and
// re-emits each ANSI sequence that sits before the slice start (`pendingAnsi`), so a cursor marker located
// before the selection is duplicated: one copy stays in place and a second one lands at the start of the
// following slice. `extractCursorPosition()` strips only the first occurrence (`indexOf`), leaving the
// duplicate inside the row that gets written to the terminal.
//
// Terminals read a bare `ESC _ ... BEL` as an unterminated APC string and swallow the rest of the row
// until the next ESC. Pi's stock editor is accidentally immune because the cursor's inverse-video block
// (`\x1b[7m<ch>\x1b[0m`) always follows the marker and terminates it. The terminal-interaction plugin
// removes that block so the terminal's own bar cursor can be shown, which exposes the swallowed text
// (double-click selection in the input box made everything after the selected text disappear).
//
// Fix: keep the marker out of the written frame. The first occurrence still positions the hardware cursor
// (that is the copy `extractCursorPosition()` consumes); every further occurrence is stripped here.

import { CURSOR_MARKER, TuiAltScreen } from "@earendil-works/pi-tui";

const patchSlot = Symbol.for("mpep.terminal-interaction.cursor-marker-guard");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

interface CursorPosition {
	row: number;
	col: number;
}

interface PatchedPrototype {
	extractCursorPosition: (lines: string[], height: number) => CursorPosition | null;
}

/**
 * Strip duplicated CURSOR_MARKER tokens from the frame right before it is written to the terminal.
 * Install once per plugin activation; the returned function restores the original method.
 */
export function installCursorMarkerGuard(): () => void {
	// Re-installing replaces a previous guard instead of stacking wrappers.
	patches[patchSlot]?.();

	const proto = TuiAltScreen.prototype as unknown as PatchedPrototype;
	const original = proto.extractCursorPosition;
	const guarded: PatchedPrototype["extractCursorPosition"] = function (this: unknown, lines, height) {
		// The original call already consumed the first marker and derived the hardware-cursor column from it.
		const position = original.call(this, lines, height);
		for (let row = 0; row < lines.length; row++) {
			const line = lines[row];
			if (line?.includes(CURSOR_MARKER)) lines[row] = line.replaceAll(CURSOR_MARKER, "");
		}
		return position;
	};
	proto.extractCursorPosition = guarded;

	const dispose = () => {
		if (proto.extractCursorPosition === guarded) proto.extractCursorPosition = original;
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
