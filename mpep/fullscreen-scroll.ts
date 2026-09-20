import { t } from "./shared/i18n/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "fullscreen-scroll";
const SCROLL_LINES = 5;

export default function fullscreenScroll(pi: ExtensionAPI): void {
	let dispose: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		dispose?.();
		dispose = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => {
				// The TUI proxy follows renderer replacements, so save the original on each renderer.
				const originalKey = Symbol("mpep.fullscreen-scroll.original");
				let active = true;
				let reportedMissingField = false;

				const apply = () => {
					if (!active || tui.mode !== "fullscreen") return;
					const current: unknown = Reflect.get(tui, "wheelScrollLines");
					if (typeof current !== "number" || !Number.isFinite(current)) {
						if (!reportedMissingField) {
							ctx.ui.notify(t("scroll.unsupported"), "warning");
							reportedMissingField = true;
						}
						return;
					}
					if (Reflect.get(tui, originalKey) === undefined) Reflect.set(tui, originalKey, current);
					// pi currently exposes this setting only as an internal, writable instance field.
					if (current !== SCROLL_LINES) Reflect.set(tui, "wheelScrollLines", SCROLL_LINES);
				};

				const restore = () => {
					if (!active) return;
					active = false;
					const original: unknown = Reflect.get(tui, originalKey);
					if (typeof original !== "number") return;
					if (tui.mode === "fullscreen" && Reflect.get(tui, "wheelScrollLines") === SCROLL_LINES) {
						Reflect.set(tui, "wheelScrollLines", original);
					}
					Reflect.set(tui, originalKey, undefined);
				};

				dispose = restore;
				apply();
				return {
					render: () => {
						apply();
						return [];
					},
					invalidate: apply,
					dispose: restore,
				};
			},
			{ placement: "belowEditor" },
		);
	});

	pi.on("session_shutdown", () => {
		dispose?.();
		dispose = undefined;
	});
}
