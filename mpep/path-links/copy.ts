// Path-link copy expansion, layered on the shared selection hook.
// The hook itself also snaps table drags to cells and strips code-frame borders;
// this holder only adds the path-link expander.

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { installSelectionCopy } from "../shared/selection-copy.ts";
import { setCopiedTextExpander } from "../shared/selection-plan.ts";
import { expandPathLinks } from "./paths.ts";

const patchSlot = Symbol.for("mpep.path-links.copy");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export function patchSelectionCopy(): () => void {
	patches[patchSlot]?.();
	const release = installSelectionCopy();
	setCopiedTextExpander((value) => expandPathLinks(value, stripTerminalSequences));
	const dispose = () => {
		setCopiedTextExpander(null);
		release();
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
