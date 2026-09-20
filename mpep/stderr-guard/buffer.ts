// Ring buffer holding captured stderr log entries across the current session.

import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface StderrLogEntry {
	id: number;
	timestamp: number;
	timeStr: string;
	raw: string;
	plain: string;
}

const MAX_BUFFER_LINES = 1000;

function formatTimestamp(timeMs: number): string {
	const date = new Date(timeMs);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

export class StderrLogBuffer {
	private readonly entries: StderrLogEntry[] = [];
	private nextId = 1;
	private readonly listeners = new Set<(addedCount: number) => void>();

	/**
	 * Append a chunk of raw stderr output. Automatically splits into lines.
	 * Returns the number of new lines added.
	 */
	append(chunk: string): number {
		if (!chunk) return 0;

		// Normalize CRLF to LF and split
		const rawLines = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		// If chunk ends with \n, the last element is empty string; preserve it only if it has preceding content
		if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
			rawLines.pop();
		}

		if (rawLines.length === 0) return 0;

		const now = Date.now();
		const timeStr = formatTimestamp(now);

		for (const line of rawLines) {
			const entry: StderrLogEntry = {
				id: this.nextId++,
				timestamp: now,
				timeStr,
				raw: line,
				plain: stripTerminalSequences(line),
			};
			this.entries.push(entry);
		}

		// Evict overflow lines
		if (this.entries.length > MAX_BUFFER_LINES) {
			this.entries.splice(0, this.entries.length - MAX_BUFFER_LINES);
		}

		for (const listener of this.listeners) {
			try {
				listener(rawLines.length);
			} catch {
				// Ignore listener exceptions
			}
		}

		return rawLines.length;
	}

	getEntries(): readonly StderrLogEntry[] {
		return this.entries;
	}

	getCount(): number {
		return this.entries.length;
	}

	clear(): void {
		this.entries.length = 0;
	}

	/**
	 * Export full text for clipboard copying.
	 */
	toPlainText(): string {
		return this.entries.map((e) => `[${e.timeStr}] ${e.plain}`).join("\n");
	}

	subscribe(listener: (addedCount: number) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

/** Global singleton buffer instance */
export const stderrBuffer = new StderrLogBuffer();
