/**
 * Per-request fetch that turns Pi's Responses POST into a WebSocket stream.
 *
 * Pi calls onPayload / onResponse around this function. This module must not
 * call them again, must not fall back to HTTP, and must not patch global fetch.
 * The socket is opened before the Response is returned, but response.create is
 * sent only from the first body pull so a later socket failure is a body error
 * rather than a failed fetch that Pi's retry wrapper could replay.
 */

import type { FetchFunction } from "@earendil-works/pi-ai";

import {
	DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	ResponsesWsError,
	ResponsesWsPool,
	type ResponsesStreamMessage,
	type WsLease,
	type WsRequestContext,
} from "./ws-client.ts";

const TERMINAL_EVENTS = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
]);

const encoder = new TextEncoder();

export function createWsFetch(
	pool: ResponsesWsPool,
	context: WsRequestContext,
): FetchFunction {
	const fetchImpl: FetchFunction = async (input, init) => {
		const request = new Request(input, init);
		const payload = await readCreatePayload(request);
		const idleMs = positive(context.timeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
		const stop = linkSignals([request.signal, context.signal]);
		if (stop?.aborted) {
			throw abortedError(stop);
		}
		const lease = await pool.acquire(new URL(request.url), request.headers, {
			...context,
			signal: stop,
		});
		if (stop?.aborted) {
			lease.release(false);
			throw abortedError(stop);
		}

		let started = false;
		let finished = false;
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const finish = (
			reusable: boolean,
			error?: unknown,
			recoverConnection = false,
		) => {
			if (finished) return;
			finished = true;
			stop?.removeEventListener("abort", onCallerAbort);
			lease.interrupted.removeEventListener("abort", onDisconnected);
			lease.release(reusable && !stop?.aborted, recoverConnection && !stop?.aborted);
			if (error !== undefined && controller) {
				const message = error instanceof Error
					? error.message
					: "Responses WebSocket error.";
				// Do not trust mutable SDK Error.message: the structured nested
				// payload can retain an unredacted (or frozen) credential echo.
				failStream(controller, new ResponsesWsError(
					lease.redactErrorMessage(message).slice(0, 1024),
				));
			}
		};
		const onCallerAbort = () => finish(false, abortedError(stop));
		const onDisconnected = () => {
			if (stop?.aborted) {
				onCallerAbort();
				return;
			}
			// A started iterator may already contain a terminal event queued
			// before the close. Preserve that ordering for Pi's original parser;
			// otherwise its error/reconnecting/close event fails the response.
			if (started) return;
			// An unread body must never dispatch after a reconnect.
			finish(false, new ResponsesWsError(
				"Responses WebSocket closed before a terminal response (connection interrupted).",
			), true);
		};

		const body = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
				stop?.addEventListener("abort", onCallerAbort, { once: true });
				lease.interrupted.addEventListener("abort", onDisconnected, { once: true });
				if (stop?.aborted) onCallerAbort();
				else if (lease.interrupted.aborted) onDisconnected();
			},
			async pull(streamController) {
				if (finished) return;
				try {
					if (stop?.aborted) throw abortedError(stop);
					if (!started) {
						started = true;
						lease.send(payload);
					}
					const message = await nextResponseMessage(
						lease,
						stop,
						idleMs,
						() => finished,
					);
					if (finished || !message) return;
					// One business event per reader pull. All fields, including
					// terminal events, stay intact for Pi's original SSE parser.
					streamController.enqueue(encoder.encode(sseFrame(message)));
					if (TERMINAL_EVENTS.has(message.type)) {
						finish(true, undefined, lease.interrupted.aborted);
						streamController.close();
					}
				} catch (error) {
					finish(false, error, lease.interrupted.aborted);
				}
			},
			cancel() {
				finish(false);
			},
		}, {
			// No speculative pull before the SDK consumes the body. In
			// particular, onResponse failure must not dispatch a business call.
			highWaterMark: 0,
		});

		return new Response(body, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"X-MPEP-Transport": "websocket",
			},
		});
	};
	return fetchImpl;
}

async function readCreatePayload(request: Request): Promise<Record<string, unknown>> {
	if (request.method.toUpperCase() !== "POST") {
		throw unsupported();
	}
	let pathname = "";
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		throw unsupported();
	}
	if (!pathname.endsWith("/responses")) {
		throw unsupported();
	}

	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		throw unsupported();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw unsupported();
	}

	const record = parsed as Record<string, unknown>;
	// background:true is a different Responses execution mode. Dropping it
	// would silently turn a background job into a foreground stream.
	if ("background" in record && record.background !== false && record.background != null) {
		throw new ResponsesWsError(
			"Responses WebSocket transport does not support background responses.",
		);
	}
	if (record.stream === false) {
		throw new ResponsesWsError(
			"Responses WebSocket transport does not support a non-streaming create.",
		);
	}

	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "stream" || key === "background") {
			continue;
		}
		payload[key] = value;
	}
	payload.type = "response.create";
	return payload;
}

async function nextResponseMessage(
	lease: WsLease,
	stop: AbortSignal | undefined,
	idleMs: number,
	isFinished: () => boolean,
): Promise<Extract<ResponsesStreamMessage, { type: "message" }>["message"] | undefined> {
	while (!isFinished()) {
		const event = await nextEvent(lease.events, stop, idleMs);
		if (isFinished()) return undefined;
		if (event.type === "error") {
			throw describeSdkError(event.error);
		}
		if (event.type === "raw") {
			throw new ResponsesWsError("Responses WebSocket received a non-JSON frame.");
		}
		if (event.type === "close") {
			throw new ResponsesWsError(
				"Responses WebSocket closed before a terminal response.",
			);
		}
		if (event.type === "reconnecting" || event.type === "reconnected") {
			throw new ResponsesWsError("Responses WebSocket interrupted before a terminal response.");
		}
		if (event.type !== "message") continue;
		if (event.message.type === "error") {
			throw describeSdkError(event.message);
		}
		return event.message;
	}
	return undefined;
}

async function nextEvent(
	events: AsyncIterableIterator<ResponsesStreamMessage>,
	stop: AbortSignal | undefined,
	idleMs: number,
): Promise<ResponsesStreamMessage> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let detachAbort: (() => void) | undefined;
	const idle = new Promise<"idle">((resolve) => {
		timer = setTimeout(() => resolve("idle"), idleMs);
	});
	const abort = stop
		? new Promise<"abort">((resolve) => {
			if (stop.aborted) {
				resolve("abort");
				return;
			}
			const onAbort = () => resolve("abort");
			stop.addEventListener("abort", onAbort, { once: true });
			detachAbort = () => stop.removeEventListener("abort", onAbort);
		})
		: undefined;

	try {
		const pending = events.next().then(
			(result) => ({ kind: "event" as const, result }),
			(error: unknown) => ({ kind: "fail" as const, error }),
		);
		const winner = await Promise.race([
			pending,
			idle.then(() => ({ kind: "idle" as const })),
			...(abort ? [abort.then(() => ({ kind: "abort" as const }))] : []),
		]);

		if (winner.kind === "abort") {
			await events.return?.();
			throw new ResponsesWsError("Request was aborted");
		}
		if (winner.kind === "idle") {
			await events.return?.();
			throw new ResponsesWsError(`Responses WebSocket idle timeout after ${idleMs}ms`);
		}
		if (winner.kind === "fail") {
			throw describeSdkError(winner.error);
		}
		if (winner.result.done) {
			throw new ResponsesWsError(
				"Responses WebSocket stream ended before a terminal response.",
			);
		}
		return winner.result.value;
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
		detachAbort?.();
	}
}

function describeSdkError(error: unknown): ResponsesWsError {
	if (error instanceof ResponsesWsError) {
		return error;
	}
	const structured = structuredError(error);
	if (structured) {
		return new ResponsesWsError(`Responses WebSocket error: ${structured}`);
	}
	const message = error instanceof Error ? error.message : "";
	const cleaned = redactUserinfo(message).trim();
	if (!cleaned) {
		return new ResponsesWsError("Responses WebSocket error.");
	}
	return new ResponsesWsError(`Responses WebSocket error: ${cleaned}`);
}

function structuredError(error: unknown): string | undefined {
	const payload = payloadOf(error);
	if (!payload) {
		return undefined;
	}
	const message = typeof payload.message === "string" ? payload.message.trim() : "";
	if (!message) {
		return undefined;
	}
	const code = typeof payload.code === "string" && payload.code ? `${payload.code}: ` : "";
	// Length limits belong after the lease's credential scrub. Cutting a
	// token here can leave a prefix that no longer matches the full secret.
	return redactUserinfo(`${code}${message}`);
}

function payloadOf(
	error: unknown,
): { code?: unknown; message?: unknown } | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	if ("error" in error) {
		const nested = (error as { error?: unknown }).error;
		if (typeof nested === "object" && nested !== null && "message" in nested) {
			return nested as { code?: unknown; message?: unknown };
		}
	}
	if ("message" in error && "type" in error) {
		return error as { code?: unknown; message?: unknown };
	}
	return undefined;
}

function sseFrame(message: { type: string }): string {
	return `data: ${JSON.stringify(message)}\n\n`;
}

function failStream(
	controller: ReadableStreamDefaultController<Uint8Array>,
	error: unknown,
): void {
	const wrapped = error instanceof Error
		? error
		: new ResponsesWsError("Responses WebSocket error.");
	try {
		controller.error(wrapped);
	} catch {
		// cancel() may have closed the stream before the pump observed it.
	}
}

function unsupported(): ResponsesWsError {
	return new ResponsesWsError(
		"Responses WebSocket transport only accepts a POST JSON response create request.",
	);
}

function abortedError(signal: AbortSignal | undefined): ResponsesWsError {
	if (signal?.aborted && signal.reason instanceof ResponsesWsError) {
		return signal.reason;
	}
	return new ResponsesWsError("Request was aborted");
}

function linkSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const present: AbortSignal[] = [];
	for (const signal of signals) {
		if (signal && !present.includes(signal)) {
			present.push(signal);
		}
	}
	if (present.length === 0) {
		return undefined;
	}
	if (present.length === 1) {
		return present[0];
	}
	return AbortSignal.any(present);
}

function positive(value: number | undefined, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	return fallback;
}

function redactUserinfo(message: string): string {
	return message.replace(
		/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/gi,
		(match) => `${match.slice(0, match.indexOf("://") + 3)}[redacted]@`,
	);
}
