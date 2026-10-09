import { CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, type Container, MouseRegion, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { t } from "../shared/i18n/index.ts";
import { getLatestTheme } from "./summary_preview_renderer.ts";

/**
 * Retained region: after a compaction, Pi re-renders only the kept tail, the
 * compaction banner, and whatever follows. Everything before the banner in the
 * chat container is therefore exactly the content Pi kept verbatim. This module
 * collapses that whole range behind a single "Retained content" header.
 *
 * Membership is positional, not identity-based: user messages carry no stable
 * id (two consecutive "继续" are indistinguishable by text), so instead of
 * tagging entries we gate the render() of every container child that sits in
 * front of the banner. pi-tui derives mouse hit-testing heights from the same
 * child.render() calls, so a gated child reporting zero lines stays consistent
 * for both painting and clicks.
 */

interface RegionState {
	expanded: boolean;
}

/** Children already wrapped; a rebuild creates fresh component instances. */
const gated = new WeakSet<Component>();
/** Marks our header so re-installs can remove a stale copy before re-adding. */
const headerMarker = Symbol("mpep.turn-fold.retained-region-header");

let lastBanner: Component | undefined;
let state: RegionState = { expanded: false };

function isRegionHeader(component: Component): boolean {
	return (component as unknown as Record<symbol, unknown>)[headerMarker] === true;
}

/** Collapse a region child to zero lines while the region is folded. */
function gateChild(child: Component, region: RegionState): void {
	if (gated.has(child)) return;
	gated.add(child);
	const original = child.render.bind(child);
	child.render = (width: number) => (region.expanded ? original(width) : []);
}

function createRegionHeader(region: RegionState, refresh: () => void): Component & { setExpanded: (expanded: boolean) => void } {
	// Same double-click cadence as process fold headers (see process_fold_components).
	let lastClick = 0;
	const body = new MouseRegion(
		{
			render(width) {
				const theme = getLatestTheme();
				const label = `${region.expanded ? "▼" : "▶"} ${t("activity.retainedContent")}`;
				const hint = theme.fg("muted", t("activity.expandHint"));
				return [truncateToWidth(theme.fg("toolTitle", theme.bold(label)) + hint, Math.max(1, width), "")];
			},
			invalidate() {},
		},
		(event: TuiMouseEvent) => {
			if (event.button !== "left") return;
			if (event.type === "press") return { handled: true };
			if (event.type === "click") {
				const now = Date.now();
				const twice = (event.clickCount ?? 0) >= 2 || now - lastClick < 450;
				lastClick = twice ? 0 : now;
				if (twice) {
					region.expanded = !region.expanded;
					refresh();
				}
				return { handled: true };
			}
			return;
		},
	);
	const header = {
		render: (width: number) => body.render(width),
		invalidate: () => body.invalidate(),
		handleMouse: (event: TuiMouseEvent) => body.handleMouse(event),
		// Pi broadcasts ctrl+o by calling setExpanded on every chat child that has one.
		setExpanded(expanded: boolean) {
			if (region.expanded === expanded) return;
			region.expanded = expanded;
			refresh();
		},
	};
	(header as unknown as Record<symbol, unknown>)[headerMarker] = true;
	return header;
}

interface RenderHost {
	chatContainer?: Container;
	ui?: { requestRender?: () => void };
}

/**
 * Scan the freshly rendered chat container and fold everything before the
 * compaction banner into the retained region. Called after every
 * renderSessionEntries pass; safe to re-run because rebuilt sessions create
 * new component instances and any stale header is spliced out first.
 */
export function installRetainedRegion(host: RenderHost): void {
	const container = host.chatContainer;
	if (!container) return;
	const children = container.children;
	const staleHeader = children.findIndex(isRegionHeader);
	if (staleHeader >= 0) children.splice(staleHeader, 1);

	const bannerIndex = children.findIndex((child) => child instanceof CompactionSummaryMessageComponent);
	if (bannerIndex <= 0) {
		// No banner (plain session) or banner first (nothing kept before it).
		lastBanner = undefined;
		return;
	}

	const banner = children[bannerIndex];
	if (banner !== lastBanner) {
		// A new compaction means a new region; start it collapsed.
		lastBanner = banner;
		state = { expanded: false };
	}
	// Pi paints a Spacer directly in front of the banner; it belongs to the
	// banner visually, so keep it outside the fold to preserve the gap.
	// Match by constructor name: Pi and this extension can resolve different
	// copies of pi-tui, which makes instanceof fail across the two.
	let regionEnd = bannerIndex;
	if (children[regionEnd - 1]?.constructor?.name === "Spacer") regionEnd--;
	// Nothing but the banner's own spacer in front: no region to fold.
	if (regionEnd <= 0) return;
	for (const child of children.slice(0, regionEnd)) gateChild(child, state);

	const refresh = () => {
		container.invalidate();
		host.ui?.requestRender?.();
	};
	children.splice(0, 0, createRegionHeader(state, refresh));
}
