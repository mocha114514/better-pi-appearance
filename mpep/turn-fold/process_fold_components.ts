import { t } from "../shared/i18n/index.ts";
import { type Component, MouseRegion, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isPaddedLineBlank } from "./mouse_interaction_handler.ts";
import { toggleProcessFold } from "./process_fold_state.ts";
import type { ProcessFoldState } from "./extension_types.ts";
import { getLatestTheme } from "./summary_preview_renderer.ts";

// Process identity survives component rebuilds; header and blank-area clicks stay independent.
const clicks = new WeakMap<ProcessFoldState, { header?: number; blank?: number }>();

function doubleClick(process: ProcessFoldState, event: TuiMouseEvent, area: "header" | "blank"): boolean {
	const timing = clicks.get(process) ?? {};
	const now = Date.now();
	const previous = timing[area];
	const twice = (event.clickCount ?? 0) >= 2 || (previous !== undefined && now - previous < 450);
	timing[area] = twice ? undefined : now;
	clicks.set(process, timing);
	return twice;
}

export function createProcessFoldHeader(process: ProcessFoldState): Component {
	return new MouseRegion(
		{
			render(width) {
				const theme = getLatestTheme();
				const label = `${process.expanded ? "\u25bc" : "\u25b6"} ${t("activity.cookingProcess")}`;
				return [truncateToWidth(theme.fg("toolTitle", theme.bold(label)), Math.max(1, width), "")];
			},
			invalidate() {},
		},
		(event) => {
			if (event.button !== "left") return;
			if (event.type === "press") return { handled: true };
			if (event.type === "click") {
				if (doubleClick(process, event, "header")) toggleProcessFold(process);
				return { handled: true };
			}
		},
	);
}

export function createProcessFoldBody(component: Component, process: ProcessFoldState): Component {
	return new MouseRegion(component, (event) => {
		if (!process.expanded || event.button !== "left") return;
		const line = component.render(event.width)[event.y] ?? "";
		if (!isPaddedLineBlank(line, event.x)) return;
		if (event.type === "press") return { handled: true };
		if (event.type === "click") {
			if (doubleClick(process, event, "blank")) toggleProcessFold(process);
			return { handled: true };
		}
	});
}

export function createProcessFoldSeparator(): Component {
	return {
		render(width) {
			return [getLatestTheme().fg("muted", "\u2500".repeat(Math.max(0, width)))];
		},
		invalidate() {},
	};
}
