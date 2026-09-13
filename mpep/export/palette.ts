// Theme → page palette. The exported page reuses the active Pi theme so the HTML and the
// terminal agree on colors; MPEP blue values are the fallback when the theme is unreadable.
import { readFileSync } from "node:fs";
import type { ExportPalette } from "./render.ts";

/** Fallback mirrors mpep/themes/mpep-blue.json so the page never renders colorless. */
export const FALLBACK_PALETTE: ExportPalette = {
	bg: "#18181e",
	card: "#1e1e24",
	fg: "#d4d4d4",
	muted: "#808080",
	dim: "#666666",
	accent: "#61afef",
	title: "#d4d4d4",
	heading: "#f0c674",
	warn: "#ffff00",
	err: "#cc6666",
	ok: "#b5bd68",
	rule: "#505050",
	hover: "#3a3a4a",
	userBg: "#343541",
	markBg: "#3a3a4a",
	markFg: "#d4d4d4",
};

type ThemeJson = {
	vars?: Record<string, string>;
	colors?: Record<string, string>;
	export?: { pageBg?: string; cardBg?: string; infoBg?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Resolve a color value that may be a hex literal or a name inside `vars`. */
function resolveColor(value: unknown, vars: Record<string, string>): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	return vars[trimmed] ?? trimmed;
}

/**
 * Build a palette from a parsed theme file. Pure so tests can feed synthetic themes;
 * unknown keys fall back to the MPEP blue defaults.
 */
export function paletteFromTheme(theme: unknown): ExportPalette {
	if (!isRecord(theme)) return { ...FALLBACK_PALETTE };
	const source = theme as ThemeJson;
	const vars: Record<string, string> = {};
	for (const [key, value] of Object.entries(source.vars ?? {})) {
		const resolved = resolveColor(value, {});
		if (resolved) vars[key] = resolved;
	}
	const colors = source.colors ?? {};
	const pick = (name: string): string | undefined => resolveColor(colors[name], vars);
	const page = source.export ?? {};
	const palette: ExportPalette = {
		bg: resolveColor(page.pageBg, vars) ?? FALLBACK_PALETTE.bg,
		card: resolveColor(page.cardBg, vars) ?? FALLBACK_PALETTE.card,
		fg: pick("text") ?? FALLBACK_PALETTE.fg,
		muted: pick("muted") ?? FALLBACK_PALETTE.muted,
		dim: pick("dim") ?? pick("muted") ?? FALLBACK_PALETTE.dim,
		accent: pick("accent") ?? FALLBACK_PALETTE.accent,
		title: pick("toolTitle") ?? pick("text") ?? FALLBACK_PALETTE.title,
		heading: pick("mdHeading") ?? pick("text") ?? FALLBACK_PALETTE.heading,
		warn: pick("warning") ?? FALLBACK_PALETTE.warn,
		err: pick("error") ?? FALLBACK_PALETTE.err,
		ok: pick("success") ?? FALLBACK_PALETTE.ok,
		rule: pick("borderMuted") ?? pick("border") ?? FALLBACK_PALETTE.rule,
		hover: pick("selectedBg") ?? FALLBACK_PALETTE.hover,
		userBg: pick("userMessageBg") ?? FALLBACK_PALETTE.card,
		markBg: pick("searchMatchBg") ?? FALLBACK_PALETTE.markBg,
		markFg: pick("searchMatchText") ?? FALLBACK_PALETTE.markFg,
	};
	return palette;
}

/** Read the palette of a theme file; any failure keeps the defaults. */
export function readPalette(themePath: string | undefined): ExportPalette {
	if (!themePath) return { ...FALLBACK_PALETTE };
	try {
		return paletteFromTheme(JSON.parse(readFileSync(themePath, "utf8")));
	} catch {
		return { ...FALLBACK_PALETTE };
	}
}
