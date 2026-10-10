/**
 * Pooled OpenAI Responses WebSocket transport.
 *
 * Pi still builds the Responses HTTP request. A per-request fetch (see
 * fetch-adapter.ts) hands that exact URL and the finalized headers here.
 * Nothing in this module reads auth.json, ambient API keys, or global fetch.
 *
 * Reuse is intentionally narrow: an idle socket is eligible only when the
 * caller has a session id and the provider, exact WebSocket URL, handshake
 * headers, and proxy all match. Parallel acquires never share a socket.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolve as resolveModule } from "import-meta-resolve";
import OpenAI from "openai";
import type WebSocket from "ws";

import { WsHeartbeat, type HeartbeatOptions } from "./heartbeat.ts";
import type { ResponsesStreamMessage } from "openai/resources/responses/internal-base";
import {
	ResponsesWS,
	type ResponsesWSClientOptions,
} from "openai/resources/responses/ws";

export type { ResponsesStreamMessage };

/** Matches the OpenAI SDK's own default request timeout (10 minutes). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

/** Handshake budget. Stream idleness after open uses timeoutMs instead. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

/** Native SDK doubling and jitter are preserved; these budgets were agreed explicitly. */
export const DEFAULT_RECONNECT_OPTIONS = Object.freeze({
	maxRetries: 5,
	initialDelay: 1875,
	maxDelay: 30_000,
});

/**
 * Server-side Responses sockets are documented to live about 60 minutes.
 * Stop reusing them a few minutes earlier so a request does not start on a
 * socket the server is about to drop.
 */
export const DEFAULT_MAX_CONNECTION_AGE_MS = 55 * 60_000;

const READY_STATE_OPEN = 1;

const STRIPPED_HEADERS = new Set([
	"accept-encoding",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"expect",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

const SENSITIVE_HEADER =
	/authorization|api[-_]?key|token|secret|password|credential|cookie/i;

export interface WsRequestContext {
	provider: string;
	sessionId?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	websocketConnectTimeoutMs?: number;
}

export interface ResponsesWsPoolOptions {
	/**
	 * Optional idle eviction budget for explicitly configured callers.
	 * Omit to retain healthy sockets until maxConnectionAgeMs instead.
	 * `0` expires on the next timer turn. The timer is unref'd.
	 */
	idleTimeoutMs?: number;
	/**
	 * Sockets older than this are closed instead of reused.
	 * Omit for 55 minutes. `0` disables reuse by age.
	 */
	maxConnectionAgeMs?: number;
	/** Clock used for the age check. Tests can move it without sleeping. */
	now?: () => number;
	/** @internal Explicit timing overrides for loopback tests, not model-config fields. */
	heartbeat?: Partial<HeartbeatOptions>;
	/** @internal Keeps SDK retries testable without changing its backoff algorithm. */
	reconnect?: Partial<typeof DEFAULT_RECONNECT_OPTIONS>;
}

export interface WsLease {
	/**
	 * SDK iterator for this lease only. It is detached on release; detaching
	 * does not close the socket. The first event may be a synthetic `open`
	 * because the SDK reports the current readyState when `stream()` is called.
	 */
	events: AsyncIterableIterator<ResponsesStreamMessage>;
	/** Fails this lease on physical connection loss, including an unread body. */
	readonly interrupted: AbortSignal;
	/** Upgrade response headers, filled once the handshake completes. */
	readonly responseHeaders: Headers;
	send(payload: Record<string, unknown>): void;
	/** Scrub transport error text, including immutable nested SDK errors. */
	redactErrorMessage(message: string): string;
	/**
	 * Idempotent. Only a transport interruption may retain background recovery.
	 * Cancellation, parse/hook errors and unread-body disposal keep the default false.
	 */
	release(reusable: boolean, recoverConnection?: boolean): void;
}

export class ResponsesWsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResponsesWsError";
	}
}

type PlatformSocket = WebSocket;

interface UpgradeResponse {
	headers?: Record<string, string | string[] | undefined>;
}

interface PoolEntry {
	key: string;
	sessionId?: string;
	socket: ResponsesWS;
	agent?: HttpsProxyAgent<string>;
	responseHeaders: Headers;
	secrets: string[];
	openedAt: number;
	state: "connecting" | "leased" | "idle" | "recovering" | "closed";
	failed: boolean;
	recovering: boolean;
	permanentlyClosed: boolean;
	poisoned: boolean;
	hasOpened: boolean;
	generation: number;
	physical?: PlatformSocket;
	heartbeat?: WsHeartbeat;
	detachPhysical?: () => void;
	interruption?: AbortController;
	cancelRecovery?: () => void;
	iterator?: AsyncIterableIterator<ResponsesStreamMessage>;
	idleTimer?: ReturnType<typeof setTimeout>;
	onError: (error: unknown) => void;
	onClose: () => void;
	onReconnected: () => void;
	onUpgrade: (response: UpgradeResponse) => void;
	onTraffic: () => void;
}

interface ConnectWaiter {
	promise: Promise<string>;
	cancel: () => void;
}

export class ResponsesWsPool {
	private readonly idleTimeoutMs: number | undefined;
	private readonly maxConnectionAgeMs: number;
	private readonly now: () => number;
	private readonly heartbeatOptions: Partial<HeartbeatOptions>;
	private readonly reconnectOptions: typeof DEFAULT_RECONNECT_OPTIONS;
	private readonly entries = new Set<PoolEntry>();
	private readonly idle = new Map<string, PoolEntry[]>();
	private readonly lifetime = new AbortController();
	private disposed = false;

	constructor(options: ResponsesWsPoolOptions = {}) {
		this.idleTimeoutMs = nonNegative(options.idleTimeoutMs);
		this.maxConnectionAgeMs = nonNegative(options.maxConnectionAgeMs)
			?? DEFAULT_MAX_CONNECTION_AGE_MS;
		this.now = options.now ?? Date.now;
		this.heartbeatOptions = { ...options.heartbeat };
		this.reconnectOptions = { ...DEFAULT_RECONNECT_OPTIONS, ...options.reconnect };
	}

	/**
	 * Resolve once the socket is open. The returned lease has not sent a
	 * response.create; the caller decides when the first client event is safe.
	 */
	async acquire(
		url: URL,
		headers: Headers,
		context: WsRequestContext,
	): Promise<WsLease> {
		if (this.disposed) {
			throw new ResponsesWsError("Responses WebSocket pool is disposed.");
		}
		if (context.signal?.aborted) {
			throw new ResponsesWsError("Request was aborted");
		}

		const wsUrl = toWebSocketUrl(url);
		const handshakeHeaders = sanitizeHandshakeHeaders(headers);
		const proxyUrl = await resolveProxy(wsUrl, context.env);
		// Helper loading is asynchronous. Do not allocate a socket if the
		// request or pool was cancelled while the host module was loading.
		if (this.disposed) {
			throw new ResponsesWsError("Responses WebSocket pool is disposed.");
		}
		if (context.signal?.aborted) {
			throw new ResponsesWsError("Request was aborted");
		}
		const key = poolKey(context, wsUrl, handshakeHeaders, proxyUrl);

		// Session-less traffic is one-shot. Taking from the idle map before any
		// await keeps two overlapping acquires from receiving the same socket.
		if (context.sessionId) {
			const parked = this.takeIdle(key);
			if (parked) {
				return this.beginLease(parked, context.signal);
			}
		}

		const entry = this.openEntry(wsUrl, handshakeHeaders, proxyUrl, key, context);
		try {
			await this.waitUntilOpen(entry, context);
		} catch (error) {
			this.destroy(entry);
			throw error;
		}
		if (context.signal?.aborted) {
			this.destroy(entry);
			throw new ResponsesWsError("Request was aborted");
		}
		if (this.disposed || entry.state === "closed") {
			this.destroy(entry);
			throw new ResponsesWsError("Responses WebSocket pool is disposed.");
		}
		if (entry.failed || entry.recovering || platformSocket(entry.socket)?.readyState !== READY_STATE_OPEN) {
			this.destroy(entry);
			throw new ResponsesWsError("Responses WebSocket closed before it was usable.");
		}
		return this.beginLease(entry, context.signal);
	}

	/** Close every owned socket, including sockets still connecting. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.lifetime.abort();
		this.idle.clear();
		for (const entry of [...this.entries]) {
			this.destroy(entry);
		}
	}

	private openEntry(
		wsUrl: URL,
		handshakeHeaders: Headers,
		proxyUrl: URL | undefined,
		key: string,
		context: WsRequestContext,
	): PoolEntry {
		const connectTimeoutMs = positive(context.websocketConnectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
		const secrets = collectSecrets(handshakeHeaders, proxyUrl);
		let agent: HttpsProxyAgent<string> | undefined;
		if (proxyUrl) {
			try {
				agent = new HttpsProxyAgent(proxyUrl);
			} catch {
				throw new ResponsesWsError("Invalid HTTP proxy configuration for the Responses WebSocket.");
			}
		}

		let entry: PoolEntry | undefined;
		let initialRaw: PlatformSocket | undefined;
		const options: ResponsesWSClientOptions = {
			headers: headersToRecord(handshakeHeaders),
			handshakeTimeout: connectTimeoutMs,
			followRedirects: false,
			reconnect: {
				...this.reconnectOptions,
				onReconnecting: () => {
					// An initial handshake failure still belongs to its original
					// establishment budget. Recovery never dispatches a request.
					if (!entry || this.disposed || entry.state === "closed"
						|| entry.state === "connecting" || !entry.hasOpened) {
						return { abort: true };
					}
					this.interrupt(entry);
				},
			},
			...(agent ? { agent } : {}),
		};

		let socket: ResponsesWS;
		try {
			socket = openExactSocket(wsUrl, options, (raw) => {
				if (entry) this.bindPhysical(entry, raw);
				else initialRaw = raw;
			});
		} catch (error) {
			destroyAgent(agent);
			throw asConnectionError(error, secrets);
		}

		const owned: PoolEntry = {
			key,
			sessionId: context.sessionId,
			socket,
			agent,
			responseHeaders: new Headers(),
			secrets,
			openedAt: this.now(),
			state: "connecting",
			failed: false,
			recovering: false,
			permanentlyClosed: false,
			poisoned: false,
			hasOpened: false,
			generation: 0,
			onError: () => undefined,
			onClose: () => undefined,
			onReconnected: () => undefined,
			onUpgrade: () => undefined,
			onTraffic: () => undefined,
		};
		entry = owned;
		owned.onError = (error) => {
			redactErrorObject(error, owned.secrets);
			owned.failed = true;
			// A network error may precede the raw close that starts SDK recovery.
			// Do not intentionally close that socket and cancel the retry loop.
			if (owned.state === "idle" && owned.physical?.readyState === READY_STATE_OPEN) {
				this.destroy(owned);
			}
		};
		owned.onClose = () => {
			owned.permanentlyClosed = true;
			owned.recovering = false;
			owned.failed = true;
			owned.interruption?.abort();
			if (owned.state !== "leased") this.destroy(owned);
		};
		owned.onReconnected = () => {
			if (owned.state === "closed" || this.disposed) return;
			if (owned.poisoned) {
				this.destroy(owned);
				return;
			}
			owned.cancelRecovery?.();
			owned.recovering = false;
			owned.failed = false;
			if (owned.state === "recovering") this.park(owned);
		};
		owned.onUpgrade = (response) => {
			copyUpgradeHeaders(response?.headers, owned.responseHeaders);
		};
		owned.onTraffic = () => {
			// Neither an idle nor a recovering socket owns a business response.
			// Protocol ping/pong never enters the SDK event/raw message parser.
			// After recovery, a paused old reader may still be draining its
			// pre-close terminal event. Its aborted lease does not own new traffic.
			if (owned.state !== "idle" && owned.state !== "recovering"
				&& !owned.recovering && !owned.interruption?.signal.aborted) return;
			owned.failed = true;
			owned.poisoned = true;
			queueMicrotask(() => {
				if (owned.poisoned) this.destroy(owned);
			});
		};

		socket.on("error", owned.onError);
		socket.on("close", owned.onClose);
		socket.on("reconnected", owned.onReconnected);
		socket.on("event", owned.onTraffic);
		socket.on("raw", owned.onTraffic);
		const raw = initialRaw ?? platformSocket(socket);
		if (raw) this.bindPhysical(owned, raw);
		this.entries.add(owned);
		return owned;
	}

	/** Each SDK-created physical socket receives its own listeners and clock. */
	private bindPhysical(entry: PoolEntry, raw: PlatformSocket): void {
		entry.detachPhysical?.();
		entry.heartbeat?.stop();
		entry.heartbeat = undefined;
		entry.physical = raw;
		entry.responseHeaders = new Headers();
		const current = () => entry.state !== "closed" && entry.physical === raw;
		const onOpen = () => {
			if (!current()) return;
			entry.hasOpened = true;
			entry.openedAt = this.now();
			entry.heartbeat = new WsHeartbeat(raw, () => {
				if (!current()) return;
				this.interrupt(entry);
				// Abnormal raw termination produces code 1006 for SDK recovery.
				// SDK.close() would mark this intentional and prevent reconnect.
				raw.terminate();
			}, this.heartbeatOptions);
		};
		const onFault = () => {
			if (!current() || !entry.hasOpened || entry.state === "connecting") return;
			this.interrupt(entry);
		};
		const onUpgrade = (response: UpgradeResponse) => {
			if (current()) entry.onUpgrade(response);
		};
		raw.on("open", onOpen);
		raw.on("error", onFault);
		raw.on("close", onFault);
		raw.on("upgrade", onUpgrade);
		entry.detachPhysical = () => {
			raw.off("open", onOpen);
			raw.off("error", onFault);
			raw.off("close", onFault);
			raw.off("upgrade", onUpgrade);
		};
		if (raw.readyState === READY_STATE_OPEN) onOpen();
	}

	private interrupt(entry: PoolEntry): void {
		if (entry.state === "closed" || entry.permanentlyClosed) return;
		entry.failed = true;
		entry.recovering = true;
		this.clearIdleTimer(entry);
		this.removeFromIdle(entry);
		entry.heartbeat?.stop();
		entry.heartbeat = undefined;
		if (entry.state === "idle") entry.state = "recovering";
		// Fail the original lease, never resume its stream on a new socket.
		entry.interruption?.abort();
	}

	private watchRecoveryCancellation(entry: PoolEntry, signal?: AbortSignal): void {
		entry.cancelRecovery?.();
		if (!signal) return;
		const generation = entry.generation;
		const onAbort = () => {
			if (entry.generation === generation && entry.state === "recovering") {
				this.destroy(entry);
			}
		};
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			if (entry.cancelRecovery === cleanup) entry.cancelRecovery = undefined;
		};
		entry.cancelRecovery = cleanup;
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	}

	private async waitUntilOpen(entry: PoolEntry, context: WsRequestContext): Promise<void> {
		const connectTimeoutMs = positive(
			context.websocketConnectTimeoutMs,
			DEFAULT_CONNECT_TIMEOUT_MS,
		);
		const events = entry.socket.stream();
		entry.iterator = events;
		let opened = false;
		const cancelWait = raceLabels([
			{ signal: context.signal, label: "abort" },
			{ signal: this.lifetime.signal, label: "disposed" },
		]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), connectTimeoutMs);
			timer.unref?.();
		});

		try {
			while (true) {
				if (this.disposed) {
					throw new ResponsesWsError("Responses WebSocket pool is disposed.");
				}
				if (context.signal?.aborted) {
					throw new ResponsesWsError("Request was aborted");
				}

				const pending = events.next().then(
					(result) => ({ kind: "event" as const, result }),
					(error: unknown) => ({ kind: "fail" as const, error }),
				);
				const winner = await Promise.race([
					pending,
					cancelWait.promise.then((label) =>
						label === "disposed"
							? { kind: "disposed" as const }
							: { kind: "abort" as const },
					),
					timeout.then(() => ({ kind: "timeout" as const })),
				]);

				if (winner.kind === "abort" || context.signal?.aborted) {
					throw new ResponsesWsError("Request was aborted");
				}
				if (winner.kind === "disposed" || this.disposed) {
					throw new ResponsesWsError("Responses WebSocket pool is disposed.");
				}
				if (winner.kind === "timeout") {
					throw new ResponsesWsError("Responses WebSocket connection timed out.");
				}
				if (winner.kind === "fail") {
					throw asConnectionError(winner.error, entry.secrets);
				}
				if (winner.result.done) {
					if (this.disposed) {
						throw new ResponsesWsError("Responses WebSocket pool is disposed.");
					}
					throw new ResponsesWsError("Responses WebSocket closed before it opened.");
				}

				const event = winner.result.value;
				if (event.type === "open") {
					entry.openedAt = this.now();
					// Keep this iterator. Returning it would drop any frame that
					// the SDK already queued behind the open event.
					opened = true;
					return;
				}
				if (event.type === "connecting" || event.type === "closing") {
					continue;
				}
				if (event.type === "error") {
					throw asConnectionError(event.error, entry.secrets);
				}
				if (event.type === "raw") {
					throw new ResponsesWsError("Responses WebSocket received a non-JSON frame.");
				}
				if (event.type === "close") {
					throw new ResponsesWsError("Responses WebSocket closed before it opened.");
				}
				if (event.type === "reconnecting" || event.type === "reconnected") {
					throw new ResponsesWsError("Responses WebSocket interrupted while establishing the connection.");
				}
			}
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			cancelWait.cancel();
			if (!opened) {
				this.closeIterator(entry);
			}
		}
	}

	private beginLease(entry: PoolEntry, signal?: AbortSignal): WsLease {
		entry.cancelRecovery?.();
		entry.generation += 1;
		const generation = entry.generation;
		entry.state = "leased";
		const interruption = new AbortController();
		entry.interruption = interruption;
		const events = entry.iterator ?? entry.socket.stream();
		entry.iterator = events;
		let released = false;

		return {
			events,
			interrupted: interruption.signal,
			responseHeaders: entry.responseHeaders,
			redactErrorMessage: (message) => redact(message, entry.secrets),
			send: (payload) => this.sendOnLease(entry, generation, payload),
			release: (reusable, recoverConnection = false) => {
				if (released) return;
				released = true;
				if (entry.generation !== generation || entry.state === "closed") return;
				entry.interruption = undefined;
				this.finishLease(entry, reusable, recoverConnection, signal);
			},
		};
	}

	private sendOnLease(
		entry: PoolEntry,
		generation: number,
		payload: Record<string, unknown>,
	): void {
		if (entry.generation !== generation || entry.state !== "leased") {
			throw new ResponsesWsError("Responses WebSocket lease is not active.");
		}
		// Never enqueue a business request into the SDK's reconnect send queue.
		if (entry.recovering || entry.interruption?.signal.aborted
			|| platformSocket(entry.socket)?.readyState !== READY_STATE_OPEN) {
			entry.failed = true;
			throw new ResponsesWsError("Responses WebSocket is not open.");
		}
		entry.socket.send(payload as unknown as Parameters<ResponsesWS["send"]>[0]);
	}

	private finishLease(
		entry: PoolEntry,
		reusable: boolean,
		recoverConnection = false,
		signal?: AbortSignal,
	): void {
		this.closeIterator(entry);
		if (recoverConnection && !this.disposed && !signal?.aborted
			&& !entry.permanentlyClosed && entry.sessionId) {
			if (entry.recovering) {
				entry.state = "recovering";
				this.watchRecoveryCancellation(entry, signal);
				return;
			}
			// Recovery can finish before the interrupted lease is consumed.
			if (this.canReuse(entry)) {
				this.park(entry);
				return;
			}
		}
		if (!reusable || !this.canReuse(entry)) {
			this.destroy(entry);
			return;
		}
		this.park(entry);
	}

	private canReuse(entry: PoolEntry): boolean {
		if (this.disposed || entry.failed || entry.poisoned || entry.recovering || !entry.sessionId) return false;
		if (this.age(entry) >= this.maxConnectionAgeMs) return false;
		return platformSocket(entry.socket)?.readyState === READY_STATE_OPEN;
	}

	private takeIdle(key: string): PoolEntry | undefined {
		const bucket = this.idle.get(key);
		if (!bucket || bucket.length === 0) {
			return undefined;
		}
		while (bucket.length > 0) {
			const entry = bucket.shift();
			if (!entry) {
				break;
			}
			this.clearIdleTimer(entry);
			if (bucket.length === 0) {
				this.idle.delete(key);
			}
			if (entry.state !== "idle" || !this.canReuse(entry)) {
				this.destroy(entry);
				continue;
			}
			return entry;
		}
		return undefined;
	}

	private park(entry: PoolEntry): void {
		if (!this.canReuse(entry)) {
			this.destroy(entry);
			return;
		}
		entry.state = "idle";
		const bucket = this.idle.get(entry.key) ?? [];
		bucket.push(entry);
		this.idle.set(entry.key, bucket);

		// Idle time alone does not retire a connection by default. Keep the
		// age deadline; an active lease has no such timer and finishes first.
		const remainingLife = Math.max(0, this.maxConnectionAgeMs - this.age(entry));
		const delay = this.idleTimeoutMs === undefined
			? remainingLife
			: Math.min(this.idleTimeoutMs, remainingLife);
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = undefined;
			if (entry.state === "idle") {
				this.destroy(entry);
			}
		}, delay);
		// A parked connection must not pin a finished CLI process.
		entry.idleTimer.unref?.();
	}

	private age(entry: PoolEntry): number {
		return Math.max(0, this.now() - entry.openedAt);
	}

	private clearIdleTimer(entry: PoolEntry): void {
		if (!entry.idleTimer) {
			return;
		}
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}

	private closeIterator(entry: PoolEntry): void {
		const iterator = entry.iterator;
		if (!iterator) {
			return;
		}
		entry.iterator = undefined;
		void iterator.return?.();
	}

	private destroy(entry: PoolEntry): void {
		if (entry.state === "closed") return;
		entry.state = "closed";
		entry.failed = true;
		entry.permanentlyClosed = true;
		entry.cancelRecovery?.();
		entry.heartbeat?.stop();
		entry.heartbeat = undefined;
		entry.detachPhysical?.();
		entry.detachPhysical = undefined;
		this.entries.delete(entry);
		this.clearIdleTimer(entry);
		this.removeFromIdle(entry);
		entry.interruption?.abort();
		entry.interruption = undefined;
		this.closeIterator(entry);

		const raw = platformSocket(entry.socket);
		let rawClosed = !raw || raw.readyState === 3;
		let sdkSettled = !entry.recovering;
		const detach = () => {
			raw?.removeListener("close", onRawClosed);
			entry.socket.off("close", onSdkSettled);
			entry.socket.off("error", entry.onError);
			entry.socket.off("close", entry.onClose);
			entry.socket.off("reconnected", entry.onReconnected);
			entry.socket.off("event", entry.onTraffic);
			entry.socket.off("raw", entry.onTraffic);
		};
		const maybeDetach = () => {
			if (rawClosed && sdkSettled) detach();
		};
		const onRawClosed = () => {
			rawClosed = true;
			maybeDetach();
		};
		const onSdkSettled = () => {
			sdkSettled = true;
			maybeDetach();
		};
		// SDK retry exhaustion may emit an error AFTER the final raw close,
		// even when close() interrupted its last attempt. Guard both lifetimes.
		// Native sleep cannot be cancelled, but intentional close prevents new
		// connections and its eventual permanent close releases this guard.
		if (!rawClosed) raw?.on("close", onRawClosed);
		if (!sdkSettled) entry.socket.on("close", onSdkSettled);
		maybeDetach();
		try {
			entry.socket.close({ code: 1000, reason: "closed" });
		} catch {
			// Already closing or not initialized.
		}
		try {
			raw?.terminate();
		} catch {
			// The platform socket may already be gone.
		}
		destroyAgent(entry.agent);
		entry.agent = undefined;
	}

	private removeFromIdle(entry: PoolEntry): void {
		const bucket = this.idle.get(entry.key);
		if (!bucket) {
			return;
		}
		// takeIdle() may already have shifted this entry. Mutate the same
		// bucket in place so that its local iterator and the map cannot diverge
		// and accidentally hand out (or destroy) another active lease.
		const index = bucket.indexOf(entry);
		if (index !== -1) bucket.splice(index, 1);
		if (bucket.length === 0) this.idle.delete(entry.key);
	}
}

/**
 * The SDK builds its own `/responses` URL from the inert client's base URL.
 * A lexical subclass closes over the Pi request URL and substitutes it at
 * the only public extension point, `_createSocket`, without reimplementing
 * the parser or the reconnect machine.
 */
function openExactSocket(
	exactUrl: URL,
	options: ResponsesWSClientOptions,
	onSocket: (socket: PlatformSocket) => void,
): ResponsesWS {
	const client = createInertClient();
	class ExactUrlResponsesWS extends ResponsesWS {
		protected override _createSocket(
			_sdkUrl: URL,
			authHeaders: Record<string, string>,
		) {
			const forwarded: Record<string, string> = {};
			for (const [name, value] of Object.entries(authHeaders)) {
				if (name.toLowerCase() !== "authorization") forwarded[name] = value;
			}
			const adapter = super._createSocket(exactUrl, forwarded);
			this.url = exactUrl;
			// Bind before upgrade/open: reconnected fires too late to capture
			// handshake metadata and must not leave old-socket heartbeat hooks.
			onSocket(adapter.platformSocket as PlatformSocket);
			return adapter;
		}
	}
	const socket = new ExactUrlResponsesWS(client, options);
	socket.url = exactUrl;
	return socket;
}

function createInertClient(): OpenAI {
	return new OpenAI({
		// An omitted apiKey would read OPENAI_API_KEY. SDK 6.40 rejects `""`
		// as "missing credentials", but a function counts as supplied and is
		// not called by ResponsesWS. client.apiKey therefore stays null and
		// the SDK does not invent an Authorization header. admin/org/project
		// are passed as null so their defaults do not read the environment.
		apiKey: async () => "",
		adminAPIKey: null,
		organization: null,
		project: null,
		webhookSecret: null,
		baseURL: "http://127.0.0.1/v1",
		logLevel: "off",
		maxRetries: 0,
		fetch: async () => {
			throw new ResponsesWsError(
				"The Responses WebSocket client does not perform HTTP requests.",
			);
		},
	});
}

function toWebSocketUrl(url: URL): URL {
	const mapped = new URL(url.href);
	if (mapped.protocol === "http:") {
		mapped.protocol = "ws:";
	} else if (mapped.protocol === "https:") {
		mapped.protocol = "wss:";
	} else if (mapped.protocol !== "ws:" && mapped.protocol !== "wss:") {
		throw new ResponsesWsError("Unsupported request URL protocol.");
	}
	return mapped;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	for (const name of new Set(headers.keys())) {
		record[name] = headers.get(name) ?? "";
	}
	return record;
}

function sanitizeHandshakeHeaders(headers: Headers): Headers {
	const sanitized = new Headers();
	headers.forEach((value, name) => {
		const normalized = name.toLowerCase();
		if (STRIPPED_HEADERS.has(normalized) || normalized.startsWith("sec-websocket-")) {
			return;
		}
		sanitized.append(name, value);
	});
	return sanitized;
}

async function resolveProxy(
	wsUrl: URL,
	env: Record<string, string> | undefined,
): Promise<URL | undefined> {
	const target = new URL(wsUrl.href);
	target.protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
	let resolve: (
		target: URL,
		env?: Record<string, string>,
	) => URL | undefined;
	try {
		// Pi aliases its root SDK exports for extensions, not arbitrary utils
		// subpaths. Resolve the public helper from the HOST installation rather
		// than depending on a second Pi SDK in this extension's dependencies.
		// The public subpath has only an ESM `import` export condition:
		// createRequire().resolve() cannot resolve it under `require` rules.
		const helperUrl = resolveModule(
			"@earendil-works/pi-ai/utils/node-http-proxy",
			pathToFileURL(join(getPackageDir(), "package.json")).href,
		);
		const helper = await import(helperUrl);
		if (typeof helper.resolveHttpProxyUrlForTarget !== "function") {
			throw new Error("Unavailable proxy helper");
		}
		resolve = helper.resolveHttpProxyUrlForTarget;
	} catch {
		// Bundled hosts may not expose external helper files. Never silently
		// bypass proxy settings or leak a credential-bearing resolution error.
		throw new ResponsesWsError(
			"Responses WebSocket transport requires the Node Pi HTTP proxy helper.",
		);
	}
	try {
		return resolve(target, env);
	} catch {
		throw new ResponsesWsError(
			"Invalid HTTP proxy configuration for the Responses WebSocket.",
		);
	}
}

function poolKey(
	context: WsRequestContext,
	wsUrl: URL,
	headers: Headers,
	proxy: URL | undefined,
): string {
	const lines: string[] = [];
	for (const name of [...headers.keys()].sort()) {
		lines.push(`${name}=${headers.get(name) ?? ""}`);
	}
	return createHash("sha256")
		.update(context.provider)
		.update("\0")
		.update(context.sessionId ?? "")
		.update("\0")
		.update(wsUrl.href)
		.update("\0")
		.update(proxy?.href ?? "")
		.update("\0")
		.update(lines.join("\n"))
		.digest("hex");
}

function collectSecrets(headers: Headers, proxy: URL | undefined): string[] {
	const secrets: string[] = [];
	if (proxy) {
		secrets.push(proxy.href);
		if (proxy.username) {
			secrets.push(proxy.username);
			try {
				secrets.push(decodeURIComponent(proxy.username));
			} catch {
				// Keep the raw username only.
			}
		}
		if (proxy.password) {
			secrets.push(proxy.password);
			try {
				secrets.push(decodeURIComponent(proxy.password));
			} catch {
				// Keep the raw password only.
			}
		}
	}
	headers.forEach((value, name) => {
		if (value.length > 0 && SENSITIVE_HEADER.test(name)) {
			secrets.push(value);
			const bearer = value.match(/^Bearer\s+(.+)$/i)?.[1];
			if (bearer) {
				secrets.push(bearer);
			}
		}
	});
	return secrets;
}

function redact(message: string, secrets: readonly string[]): string {
	let text = message;
	const needles = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
		(left, right) => right.length - left.length,
	);
	for (const secret of needles) {
		text = text.split(secret).join("[redacted]");
	}
	return text.replace(
		/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/gi,
		(match) => `${match.slice(0, match.indexOf("://") + 3)}[redacted]@`,
	);
}

function redactErrorObject(error: unknown, secrets: readonly string[]): void {
	if (typeof error !== "object" || error === null || !("message" in error)) {
		return;
	}
	const current = (error as { message?: unknown }).message;
	if (typeof current !== "string") {
		return;
	}
	const cleaned = redact(current, secrets);
	if (cleaned === current) {
		return;
	}
	try {
		Object.defineProperty(error, "message", { value: cleaned });
	} catch {
		// Some SDK errors freeze the message. Callers still redact at throw sites.
	}
}

function asConnectionError(error: unknown, secrets: readonly string[]): ResponsesWsError {
	if (error instanceof ResponsesWsError) {
		return error;
	}
	redactErrorObject(error, secrets);
	const raw = error instanceof Error ? error.message : "";
	const cleaned = redact(raw, secrets).trim();
	if (!cleaned) {
		return new ResponsesWsError("Responses WebSocket connection failed.");
	}
	return new ResponsesWsError(`Responses WebSocket connection failed: ${cleaned}`);
}

function copyUpgradeHeaders(
	source: Record<string, string | string[] | undefined> | undefined,
	target: Headers,
): void {
	if (!source) {
		return;
	}
	for (const [name, value] of Object.entries(source)) {
		if (typeof value === "string") {
			target.set(name, value);
		} else if (Array.isArray(value)) {
			target.delete(name);
			for (const item of value) {
				target.append(name, item);
			}
		}
	}
}

function platformSocket(socket: ResponsesWS): PlatformSocket | undefined {
	try {
		return socket.socket?.platformSocket as PlatformSocket | undefined;
	} catch {
		return undefined;
	}
}

function destroyAgent(agent: HttpsProxyAgent<string> | undefined): void {
	if (!agent) {
		return;
	}
	try {
		agent.destroy();
	} catch {
		// The agent may already be destroyed with the socket.
	}
}

function raceLabels(
	sources: Array<{ signal?: AbortSignal; label: string }>,
): ConnectWaiter {
	const remove: Array<() => void> = [];
	const promise = new Promise<string>((resolve) => {
		for (const source of sources) {
			const signal = source.signal;
			if (!signal) {
				continue;
			}
			if (signal.aborted) {
				resolve(source.label);
				return;
			}
			const onAbort = () => resolve(source.label);
			signal.addEventListener("abort", onAbort, { once: true });
			remove.push(() => signal.removeEventListener("abort", onAbort));
		}
	});
	return {
		promise,
		cancel() {
			for (const detach of remove) {
				detach();
			}
			remove.length = 0;
		},
	};
}

function positive(value: number | undefined, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	return fallback;
}

function nonNegative(value: number | undefined): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return value;
	}
	return undefined;
}
