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

export type Activity = ThinkingRecord | { type: "tool"; toolCallId: string };

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
