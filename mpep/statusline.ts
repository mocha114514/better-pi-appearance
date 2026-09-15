import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { t } from "./shared/i18n/index.ts";
import { isPluginEnabled } from "./manager/preferences.ts";
import {
	formatGitStatus,
	GitStatusTracker,
	type GitStatusDisplay,
	type GitStatusSnapshot,
	type GitStatusToken,
} from "./shared/git-status.ts";

// ── ANSI Colors (high-contrast bright colors, consistent with statusline.py) ──
const CYAN = "\x1b[96m"; // Model name and right-side info
const GREEN = "\x1b[92m"; // Project root directory
const BLUE = "\x1b[94m"; // Session name
const YELLOW = "\x1b[93m"; // Normal token display
const LIGHT_PINK = "\x1b[38;2;255;182;193m"; // Git branch and status
const GRAY = "\x1b[90m"; // Separator
const ORANGE = "\x1b[38;5;214m"; // Context warning (>80%)
const RED_BRIGHT = "\x1b[91m"; // Context danger (>95%) and git merge conflicts
const RESET = "\x1b[0m";

const MODEL_WIDGET_KEY = "model-info";
/** Repaint cadence for the token/context counters; independent of the git probe. */
const REFRESH_INTERVAL_MS = 1000;
/** How often the git area re-probes on its own. A round ending or a double click skips the wait. */
const GIT_REFRESH_INTERVAL_MS = 10_000;
/** How long the "refreshed" marker stays visible after an on-demand refresh. */
const GIT_REFRESH_MARKER_MS = 1500;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatContextTokens(count: number): string {
	if (count <= 0) return "0k";
	if (count < 1000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

/** Left cluster + right-aligned cluster on one row; left truncates first when tight. */
function composeLeftRight(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, "...");
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "...");
	const gap = 1;
	const leftBudget = width - rightWidth - gap;
	const fittedLeft = leftBudget > 0 ? truncateToWidth(left, leftBudget, "...") : "";
	const pad = Math.max(gap, width - visibleWidth(fittedLeft) - rightWidth);
	return `${fittedLeft}${" ".repeat(pad)}${right}`;
}

/**
 * Render the right-aligned git area: `branch ✓` when there is nothing to report, otherwise
 * `branch ● <tokens>` with conflicts in the alert colour and an optional "refreshed" marker.
 * Returns "" when there is no snapshot, which makes the whole area disappear.
 */
function buildGitText(
	display: GitStatusDisplay | null,
	extra: GitStatusToken[],
	markerLabel: string | null,
): string {
	if (!display) return "";
	const tokens = [...display.tokens, ...extra];
	const body =
		tokens.length === 0
			? `${display.branch} ✓`
			: `${display.branch} ● ${tokens
					.map(token => (token.alarm ? `${RED_BRIGHT}${token.text}${LIGHT_PINK}` : token.text))
					.join(" ")}`;
	const marker = markerLabel === null ? "" : ` ${GRAY}${markerLabel}${RESET}`;
	return `${LIGHT_PINK}${body}${RESET}${marker}`;
}

/**
 * Upstream divergence, spelled out instead of drawn as arrows: `↑1↓1` read as "up one, down one"
 * rather than "one commit to push, one to pull", so the wording comes from the locale table.
 * These counters describe the last fetch, not the current state of the remote.
 */
function buildDivergenceTokens(snapshot: GitStatusSnapshot): GitStatusToken[] {
	const tokens: GitStatusToken[] = [];
	if (snapshot.ahead > 0) tokens.push({ text: t("status.gitAhead", { count: snapshot.ahead }), alarm: false });
	if (snapshot.behind > 0) tokens.push({ text: t("status.gitBehind", { count: snapshot.behind }), alarm: false });
	return tokens;
}

export default function (pi: ExtensionAPI) {
	if (!isPluginEnabled("statusline")) return;
	/** Tracker of the currently mounted footer; null while the statusline is unmounted. */
	let activeTracker: GitStatusTracker | null = null;

	pi.on("session_start", (_event, ctx) => {
		const ui = ctx.ui;
		ui.setFooter((tui, _theme, footerData) => {
			// Geometry of the git area in the last render, used to hit-test double clicks.
			let gitRegion: { start: number; end: number } | null = null;

			const tracker = new GitStatusTracker({
				intervalMs: GIT_REFRESH_INTERVAL_MS,
				getCwd: () => ctx.cwd,
				onUpdate: () => tui.requestRender(),
			});
			activeTracker = tracker;
			tracker.start();

			ui.setWidget(
				MODEL_WIDGET_KEY,
				() => ({
					invalidate() {},
					render(width: number): string[] {
						if (width <= 0) return [""];

						const model = ctx.model;
						let label = model?.id || t("status.noModel");
						if (model?.reasoning) {
							const thinkingLevel = ctx.thinkingLevel || "off";
							label += thinkingLevel === "off" ? ` • ${t("status.thinkingOff")}` : ` • ${thinkingLevel}`;
						}
						if (footerData.getAvailableProviderCount() > 1 && model) {
							label = `(${model.provider}) ${label}`;
						}

						const text = truncateToWidth(label.replace(/[\r\n\t]/g, " "), width, "...".slice(0, width));
						const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
						return [`${padding}${CYAN}${text}${RESET}`];
					},
				}),
				{ placement: "aboveEditor" },
			);

			// Reactively listen for branch switches and refresh automatically
			const unsubBranch = footerData.onBranchChange(() => {
				tracker.refresh();
			});

			// Repaint once per second so asynchronous token and git readings become visible.
			const refreshTimer = setInterval(() => {
				tui.requestRender();
			}, REFRESH_INTERVAL_MS);
			refreshTimer.unref();

			return {
				dispose() {
					tracker.stop();
					if (activeTracker === tracker) activeTracker = null;
					unsubBranch();
					clearInterval(refreshTimer);
					ui.setWidget(MODEL_WIDGET_KEY, undefined);
				},
				invalidate() {},
				render(width: number): string[] {
					// ── 1. Aggregate cumulative tokens (keep top five: ↑input ↓output Rcache-read Wcache-write CH hit-rate) ──
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const u = entry.message.usage;
							if (u) {
								input += u.input || 0;
								output += u.output || 0;
								cacheRead += u.cacheRead || 0;
								cacheWrite += u.cacheWrite || 0;
								const promptTokens = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
								if (promptTokens > 0) {
									latestCacheHitRate = ((u.cacheRead || 0) / promptTokens) * 100;
								}
							}
						} else if (
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.usage
						) {
							const u = entry.message.usage;
							input += u.input || 0;
							output += u.output || 0;
							cacheRead += u.cacheRead || 0;
							cacheWrite += u.cacheWrite || 0;
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							const u = entry.usage;
							input += u.input || 0;
							output += u.output || 0;
							cacheRead += u.cacheRead || 0;
							cacheWrite += u.cacheWrite || 0;
						}
					}

					const totalPromptTokens = input + cacheRead + cacheWrite;
					const overallCacheHitRate =
						totalPromptTokens > 0 ? (cacheRead / totalPromptTokens) * 100 : undefined;

					const tokenParts: string[] = [];
					if (input) tokenParts.push(`↑${formatTokens(input)}`);
					if (output) tokenParts.push(`↓${formatTokens(output)}`);
					const cacheParts: string[] = [`R${formatTokens(cacheRead)}`];
					if (cacheWrite) cacheParts.push(`W${formatTokens(cacheWrite)}`);
					const latestHitText = latestCacheHitRate === undefined ? "?" : `${latestCacheHitRate.toFixed(1)}%`;
					const overallHitText = overallCacheHitRate === undefined ? "?" : `${overallCacheHitRate.toFixed(1)}%`;
					cacheParts.push(`CH${latestHitText}(avg ${overallHitText})`);

					const cumulativeStr = tokenParts.length > 0 ? tokenParts.join(" ") : "↑0 ↓0";

					// ── 2. Context window stats (compact k format with alert colors) ──
					const contextUsage = ctx.getContextUsage();
					const usedTokens = contextUsage?.tokens;
					const maxTokens = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const pct = contextUsage?.percent;

					const usedStr = usedTokens == null ? "?" : formatContextTokens(usedTokens);
					const maxStr = formatContextTokens(maxTokens);
					const pctStr = pct == null ? "?" : `${pct.toFixed(1)}%`;
					const contextText = `${usedStr} / ${maxStr} tokens (${pctStr})`;

					let contextColor = YELLOW;
					if (pct != null && pct > 95) {
						contextColor = RED_BRIGHT;
					} else if (pct != null && pct > 80) {
						contextColor = ORANGE;
					}

					// ── 3. Line 1: project root [• session name]          git (right) ──
					const sessionName = ctx.sessionManager.getSessionName();
					const line1Left = sessionName
						? `${GREEN}${tracker.getProjectRoot(ctx.cwd)}${RESET} ${GRAY}•${RESET} ${BLUE}${sessionName}${RESET}`
						: `${GREEN}${tracker.getProjectRoot(ctx.cwd)}${RESET}`;
					const snapshot = tracker.getSnapshot();
					const markerVisible = Date.now() - tracker.getLastManualRefreshAt() < GIT_REFRESH_MARKER_MS;
					const gitText = buildGitText(
						snapshot ? formatGitStatus(snapshot, t("status.gitDetached")) : null,
						snapshot ? buildDivergenceTokens(snapshot) : [],
						markerVisible ? t("status.gitRefreshed") : null,
					);
					// The git area is right-aligned, so recording its column span here is enough
					// for a later double click to be hit-tested against it.
					gitRegion =
						gitText === "" ? null : { start: Math.max(0, width - visibleWidth(gitText)), end: width };

					// ── 4. Line 2: input/output • cache • context tokens ──
					const usageParts = [
						`${YELLOW}${cumulativeStr}${RESET}`,
						`${YELLOW}${cacheParts.join(" ")}${RESET}`,
						`${contextColor}${contextText}${RESET}`,
					];
					const line2Left = usageParts.join(` ${GRAY}•${RESET} `);

					const line1 = composeLeftRight(line1Left, gitText, width);
					const line2 = truncateToWidth(line2Left, width, "...");

					const lines = [line1, line2];

					// Support text set by other extensions via ctx.ui.setStatus
					const extStatuses = footerData.getExtensionStatuses();
					if (extStatuses.size > 0) {
						const sorted = Array.from(extStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
						lines.push(truncateToWidth(sorted.join(" "), width, "..."));
					}

					return lines;
				},
				/**
				 * Double clicking the git area forces an immediate refresh. Answering the press is what
				 * makes the renderer report the matching click back to us; the trade-off is that text
				 * selection is unavailable inside that area only.
				 */
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.y !== 0 || event.button !== "left") return undefined;
					if (event.type !== "press" && event.type !== "click") return undefined;
					if (gitRegion === null || event.x < gitRegion.start || event.x >= gitRegion.end) return undefined;
					if (event.type === "click" && event.clickCount === 2) tracker.refresh({ manual: true });
					return { handled: true };
				},
			};
		});
	});

	// A finished round usually means files just changed, so probe without waiting for the next poll.
	pi.on("agent_settled", () => {
		activeTracker?.refresh();
	});
}
