/** Protocol-only liveness checks. No model events or request payloads enter here. */
import { randomBytes } from "node:crypto";
import type WebSocket from "ws";

export interface HeartbeatOptions {
	intervalMs: number;
	pongTimeoutMs: number;
	maxMissedPongs: number;
}

/** Explicitly agreed transport policy; not inferred from prompt-cache settings. */
export const DEFAULT_HEARTBEAT_OPTIONS: Readonly<HeartbeatOptions> = Object.freeze({
	intervalMs: 60_000,
	pongTimeoutMs: 60_000,
	maxMissedPongs: 3,
});

type HeartbeatSocket = Pick<WebSocket, "readyState" | "ping" | "on" | "off">;

interface PendingPing {
	sequence: number;
	timer: ReturnType<typeof setTimeout>;
}

export class WsHeartbeat {
	private readonly options: HeartbeatOptions;
	private readonly socket: HeartbeatSocket;
	private readonly onUnhealthy: () => void;
	private readonly prefix = randomBytes(8).toString("hex");
	private readonly pending = new Map<string, PendingPing>();
	private readonly interval: ReturnType<typeof setInterval>;
	private sequence = 0;
	private acknowledged = 0;
	private misses = 0;
	private stopped = false;

	constructor(
		socket: HeartbeatSocket,
		onUnhealthy: () => void,
		overrides: Partial<HeartbeatOptions> = {},
	) {
		this.socket = socket;
		this.onUnhealthy = onUnhealthy;
		this.options = {
			intervalMs: positive(overrides.intervalMs, DEFAULT_HEARTBEAT_OPTIONS.intervalMs),
			pongTimeoutMs: positive(overrides.pongTimeoutMs, DEFAULT_HEARTBEAT_OPTIONS.pongTimeoutMs),
			maxMissedPongs: overrides.maxMissedPongs !== undefined
				&& Number.isInteger(overrides.maxMissedPongs)
				&& overrides.maxMissedPongs > 0
				? overrides.maxMissedPongs
				: DEFAULT_HEARTBEAT_OPTIONS.maxMissedPongs,
		};
		this.socket.on("pong", this.onPong);
		this.socket.on("close", this.onClose);
		this.interval = setInterval(() => this.ping(), this.options.intervalMs);
		this.interval.unref?.();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		clearInterval(this.interval);
		for (const ping of this.pending.values()) clearTimeout(ping.timer);
		this.pending.clear();
		this.socket.off("pong", this.onPong);
		this.socket.off("close", this.onClose);
	}

	private readonly onClose = (): void => this.stop();

	private readonly onPong = (data: Buffer): void => {
		const key = data.toString("hex");
		const ping = this.pending.get(key);
		// Unsolicited and already-expired pongs cannot revive a failed check.
		if (!ping || this.stopped) return;
		clearTimeout(ping.timer);
		this.pending.delete(key);
		if (ping.sequence > this.acknowledged) {
			this.acknowledged = ping.sequence;
			this.misses = 0;
		}
	};

	private ping(): void {
		if (this.stopped) return;
		if (this.socket.readyState !== 1) {
			this.stop();
			return;
		}
		const sequence = ++this.sequence;
		const payload = Buffer.from(`${this.prefix}:${sequence}`);
		const key = payload.toString("hex");
		const timer = setTimeout(() => {
			this.pending.delete(key);
			// A newer matching pong proves the connection survived an older
			// missing reply. Do not count out-of-order checks as new failures.
			if (this.stopped || sequence <= this.acknowledged) return;
			this.misses += 1;
			if (this.misses >= this.options.maxMissedPongs) this.fail();
		}, this.options.pongTimeoutMs);
		timer.unref?.();
		this.pending.set(key, { sequence, timer });
		try {
			this.socket.ping(payload);
		} catch {
			this.fail();
		}
	}

	private fail(): void {
		if (this.stopped) return;
		this.stop();
		this.onUnhealthy();
	}
}

function positive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}
