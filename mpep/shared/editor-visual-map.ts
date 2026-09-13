// Contract between plugins that reshape the editor buffer for display and code that has to translate
// screen cells back into buffer positions.
//
// Why this exists
// ---------------
// path-links collapses absolute image paths inside the input editor: while `layoutText` runs it swaps
// `state.lines` for a shorter visual text (see mpep/path-links/editor.ts), so the rows on screen describe
// that visual text while the buffer keeps the full paths.
//
// Any mouse-to-buffer mapping therefore has to lay out the same visual text and translate the resulting
// column through the matching `toLogical` table. Laying out the logical lines instead shifts the row
// (word wrapping happens at different offsets) and the column (collapsed characters disappear), which made
// every copied or cut selection resolve to a neighbouring buffer range.
//
// A registry keeps the two plugins independent: with no reshaping plugin installed the accessor returns
// undefined, which means "buffer and screen are identical" and the identity mapping applies.

export interface EditorVisualLineMap {
	/** The text that was actually rendered for this buffer line. */
	visual: string;
	/** Visual index -> buffer index. Length is `visual.length + 1`; the trailing entry is the line end. */
	toLogical: number[];
	/** Buffer index -> visual index. Length is the logical line length + 1, so it always contains offsets. */
	toVisual: number[];
}

/** Returns the maps of the frame currently on screen, or undefined when the buffer is rendered verbatim. */
export type EditorVisualMapProvider = (editor: unknown) => readonly EditorVisualLineMap[] | undefined;

const providerSlot = Symbol.for("mpep.shared.editor-visual-map");
const slots = globalThis as unknown as Record<symbol, EditorVisualMapProvider | undefined>;

/** Publish the maps. A later install simply takes over; the returned function only removes its own provider. */
export function setEditorVisualMapProvider(provider: EditorVisualMapProvider): () => void {
	slots[providerSlot] = provider;
	const dispose = () => {
		if (slots[providerSlot] === provider) delete slots[providerSlot];
	};
	return dispose;
}

/** The reshape maps for this editor instance, or undefined when nothing reshapes it. */
export function getEditorVisualLineMaps(editor: unknown): readonly EditorVisualLineMap[] | undefined {
	return slots[providerSlot]?.(editor);
}
