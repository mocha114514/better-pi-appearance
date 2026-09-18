import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";

export interface ToolRecord {
	id: string;
	name: string;
	args: Record<string, unknown>;
	output: string;
	isPartial: boolean;
	isError: boolean;
	isExpanded: boolean;
}

export interface ThinkingRecord {
	type: "thinking";
	key: string;
	output: string;
	isExpanded: boolean;
}

/** An extension custom message folded into the current activity group. */
export interface CustomMessageRecord {
	type: "custom";
	/** customType@timestampMs — stable across session reload (Pi re-derives both). */
	key: string;
	/** customType, used for the fallback header when no live view was captured. */
	label: string;
	/** Delegate into the standalone CustomMessageComponent, captured post-construction. */
	view?: ToolView;
	/** Re-renders the owning group once the view arrives after the claim. */
	refresh?: () => void;
}

/**
 * An extension custom entry folded into the current activity group. Unlike custom
 * messages, entries may be pure archives with no renderer at all, so a record only
 * becomes visible once entry_capture binds a real component instance to it.
 */
export interface CustomEntryRecord {
	type: "customEntry";
	/** Session entry id — unique and stable across reload. */
	id: string;
	view?: ToolView;
	refresh?: () => void;
}

export type Activity = ThinkingRecord | { type: "tool"; toolCallId: string } | CustomMessageRecord | CustomEntryRecord;

export interface TurnState {
	id: number;
	tools: Map<string, ToolRecord>;
	activities: Activity[];
	expanded: boolean;
	sealed: boolean;
	refresh?: () => void;
}

export interface ActivePreview {
	type: "tool" | "thinking";
	header: string;
	output: string;
	isError: boolean;
}

export type MessagePart = { type: "text"; index: number } | { type: "group"; groupId: number };

export interface MessageState {
	id: number;
	message: AssistantMessage;
	parts: MessagePart[];
	blocks: Map<number, ThinkingRecord | "text" | "tool">;
	finished: boolean;
	process?: ProcessFoldState;
	refresh?: () => void;
}

export interface ProcessFoldState {
	messages: MessageState[];
	expanded: boolean;
	fold?: {
		anchorMessageId: number;
		finalMessageId: number;
		finalPartIndex: number;
		/** Set when the disclosure holds the tail Pi kept verbatim after a compaction. */
		retained?: boolean;
	};
}

export interface ToolView extends Component {
	setExpanded(expanded: boolean): void;
}

export interface ToolPresentationContext {
	toolCallId: string;
	isError: boolean;
	invalidate(): void;
}
