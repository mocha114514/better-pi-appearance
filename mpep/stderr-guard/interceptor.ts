// Intercepts process.stderr.write to prevent third-party libraries from leaking raw logs onto TUI.

import type { TUI } from "@earendil-works/pi-tui";
import { stderrBuffer } from "./buffer.ts";
import { dismissStderrToast, showStderrToast } from "./toast.ts";
import { isStderrModalActive, showStderrModal } from "./modal.ts";

const patchSlot = Symbol.for("mpep.stderr-guard.interceptor");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

type WriteCallback = (error?: Error | null) => void;

interface OriginalStderr {
	write: (
		chunk: string | Uint8Array,
		encodingOrCb?: BufferEncoding | WriteCallback,
		cb?: WriteCallback,
	) => boolean;
}

/**
 * Install the stderr interceptor.
 * - Captures stderr chunks into the ring buffer.
 * - Suppresses direct physical terminal writes while TUI is active.
 * - Triggers top-right toast notification with a 10s countdown.
 */
export function installStderrInterceptor(getTui: () => TUI | undefined): () => void {
	// Re-installing restores the previous guard first to prevent stacking
	patches[patchSlot]?.();

	const originalWrite = process.stderr.write.bind(process.stderr);

	const guardedWrite = function (
		chunk: string | Uint8Array,
		encodingOrCb?: BufferEncoding | WriteCallback,
		cb?: WriteCallback,
	): boolean {
		const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
		const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

		const tui = getTui();

		// Record the log chunk in buffer
		const addedCount = stderrBuffer.append(str);

		// If TUI is active, suppress raw physical write to protect screen from ANSI tearing
		if (tui && addedCount > 0) {
			// Notify user via top-right toast (unless the modal viewer is already open)
			if (!isStderrModalActive()) {
				showStderrToast(tui, () => showStderrModal(tui), addedCount);
			}

			// Invoke callback if provided to fulfill stream contract
			if (callback) {
				try {
					callback(null);
				} catch {
					// Ignore callback errors
				}
			}
			return true;
		}

		// Fallback: passthrough when not in interactive TUI mode
		return originalWrite(chunk, encodingOrCb as BufferEncoding, cb);
	};

	process.stderr.write = guardedWrite as typeof process.stderr.write;

	const dispose = () => {
		if (process.stderr.write === (guardedWrite as typeof process.stderr.write)) {
			process.stderr.write = originalWrite;
		}
		dismissStderrToast();
		if (patches[patchSlot] === dispose) {
			delete patches[patchSlot];
		}
	};

	patches[patchSlot] = dispose;
	return dispose;
}
