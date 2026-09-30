/**
 * Minimal JSONL-RPC client for a resident `pi --mode rpc` subprocess.
 *
 * Modeled on pi-coding-agent's own RpcClient, but spawns through the same
 * pi-invocation detection as the CLI (handles node script / bun / compiled
 * binary installs) and supports killing the whole process tree, which matters
 * on Windows where the RPC child is itself a `node` wrapper.
 *
 * Protocol (newline-delimited JSON on stdio):
 *   request:  { id, type: "<command>", ... }
 *   response: { id, type: "response", command, success, data | error }
 *   event:    raw event objects ({ type: "agent_end", ... }) — NOT wrapped.
 *
 * Hardening notes (from review):
 *   - stdout is decoded with a persistent StringDecoder so multibyte UTF-8
 *     characters split across chunks are not corrupted;
 *   - stdin carries an error listener: a child closing stdin mid-write would
 *     otherwise raise an asynchronous EPIPE that crashes the parent;
 *   - extension UI requests (dialogs) are auto-cancelled at the transport
 *     level — a child awaiting ctx.ui.confirm() must not wedge forever;
 *   - kill() escalates: cooperative abort, SIGTERM/group-TERM, then a hard
 *     kill on a short fuse; on Windows the tree is killed via taskkill
 *     resolved from System32 with spawn errors consumed.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Loosely typed on purpose: we only read a handful of event fields. */
export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * Locate the current pi installation. Same strategy as the official subagent
 * example: prefer the running script (argv[1]), fall back to PATH lookups.
 */
export function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}
	if (process.platform === "win32") {
		return { command: "cmd.exe", args: ["/d", "/s", "/c", "pi", ...extraArgs] };
	}
	return { command: "pi", args: extraArgs };
}

/** Windows tree kill; taskkill is resolved from System32 and its asynchronous
 * spawn errors are consumed so a restricted PATH cannot crash the parent. */
function taskkillTree(pid: number, force: boolean): void {
	try {
		const root = process.env.SystemRoot || "C:\\Windows";
		const exe = path.join(root, "System32", "taskkill.exe");
		const args = force ? ["/pid", String(pid), "/T", "/F"] : ["/pid", String(pid), "/T"];
		const killer = spawn(exe, args, { stdio: "ignore" });
		killer.on("error", () => {});
		killer.unref();
	} catch {
		// Best effort only.
	}
}

export class RpcSubprocess {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private stdoutDecoder = new StringDecoder("utf-8");
	private stderrDecoder = new StringDecoder("utf-8");
	private nextId = 0;
	private pending = new Map<string, PendingRequest>();
	private listeners = new Set<(event: RpcEvent) => void>();
	private exitListeners = new Set<(code: number | null) => void>();
	private stderrTail: string[] = [];
	private readonly cwd: string;
	private readonly args: string[];
	private readonly env: Record<string, string> | undefined;

	/** The subprocess is considered dead once close fires. */
	alive = false;

	constructor(cwd: string, args: string[], env?: Record<string, string>) {
		this.cwd = cwd;
		this.args = args;
		this.env = env;
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Returns an unsubscribe function; completed runs must not accumulate. */
	onExit(listener: (code: number | null) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	stderrText(): string {
		return this.stderrTail.join("\n");
	}

	async start(): Promise<void> {
		const invocation = getPiInvocation(this.args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: this.env ? { ...process.env, ...this.env } : process.env,
			// Own process group on Unix so kill() can signal the whole group.
			detached: process.platform !== "win32",
		});
		this.proc = proc;
		this.alive = true;

		proc.stdout?.on("data", (chunk: Buffer) => this.handleData(this.stdoutDecoder.write(chunk)));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail.push(this.stderrDecoder.write(chunk));
			if (this.stderrTail.length > 10) this.stderrTail.shift();
		});
		// A child closing stdin mid-write raises EPIPE asynchronously; without a
		// listener this is an unhandled error that terminates the parent.
		proc.stdin?.on("error", () => {
			if (this.alive) this.handleClose(null);
		});
		proc.on("error", () => this.handleClose(null));
		proc.on("close", (code) => this.handleClose(code));

		// The child must not hold the parent's event loop open: in print mode the
		// main process exits right after the run even when an instance is kept
		// resident. Unref everything; the exit handler still reaps children.
		proc.unref();
		for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
			(stream as unknown as { unref?: () => void } | null)?.unref?.();
		}

		// Wait until the RPC loop answers. Startup includes config/auth loading
		// and can take a moment; each attempt is bounded by a real timer so a
		// stalled (but alive) child cannot hang the dispatch forever.
		const deadline = Date.now() + 60_000;
		for (;;) {
			try {
				await this.sendWithTimeout({ type: "get_state" }, 5_000);
				return;
			} catch (error) {
				if (!this.alive) throw new Error(`pi RPC process exited during startup. ${this.stderrText()}`);
				if (Date.now() > deadline) {
					this.kill();
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
	}

	private handleClose(code: number | null): void {
		if (!this.alive) return;
		this.alive = false;
		const error = new Error(`pi RPC process exited (code ${code}). ${this.stderrText()}`);
		for (const { reject } of this.pending.values()) reject(error);
		this.pending.clear();
		const listeners = [...this.exitListeners];
		this.exitListeners.clear();
		for (const listener of listeners) listener(code);
	}

	private handleData(data: string): void {
		this.buffer += data;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}

		if (message.type === "response") {
			const id = typeof message.id === "string" ? message.id : "";
			const entry = this.pending.get(id);
			if (!entry) return;
			this.pending.delete(id);
			if (message.success) {
				entry.resolve(message.data);
			} else {
				entry.reject(new Error(typeof message.error === "string" ? message.error : "RPC command failed"));
			}
			return;
		}

		// Dialog requests must be answered or the child wedges awaiting a
		// response. Subagents have no user to ask: cancel everything politely
		// (select/input resolve undefined, confirm resolves false).
		if (message.type === "extension_ui_request" && typeof message.id === "string") {
			try {
				this.proc?.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`);
			} catch {
				// Child is dying; its close handler reports the failure.
			}
			return;
		}

		// Everything else is a session event emitted as-is ({ type: "agent_end", ... }).
		if (typeof message.type === "string") {
			const event = message as unknown as RpcEvent;
			for (const listener of this.listeners) listener(event);
		}
	}

	/** Send a command and wait for its response (matched by id). */
	send(command: Record<string, unknown>): Promise<unknown> {
		const proc = this.proc;
		if (!proc?.stdin || !this.alive) return Promise.reject(new Error("pi RPC process is not running"));
		const id = `req-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				proc.stdin!.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
					if (error) {
						this.pending.delete(id);
						reject(error);
					}
				});
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** send() bounded by a real timer; the pending entry is dropped on timeout. */
	private sendWithTimeout(command: Record<string, unknown>, ms: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`RPC command timed out after ${ms}ms`)), ms);
			timer.unref?.();
			this.send(command).then(
				(value) => { clearTimeout(timer); resolve(value); },
				(error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
			);
		});
	}

	/** Fire a prompt; the returned promise resolves once the run is accepted.
	 * followUp queueing: a busy child (e.g. mid-compaction from the injected
	 * compact-forewarn) queues the task instead of rejecting it. */
	prompt(message: string): Promise<unknown> {
		return this.send({ type: "prompt", message, streamingBehavior: "followUp" });
	}

	abort(): Promise<unknown> {
		return this.send({ type: "abort" }).catch(() => undefined);
	}

	/** Live session state (isStreaming/isCompacting/pendingMessageCount).
	 * Used after agent_settled to confirm the child is TRULY idle: 0.85.x runs
	 * auto-compaction asynchronously after settle, and a compaction-resumed run
	 * would otherwise look like fresh output arriving after delivery. */
	async getState(): Promise<{ isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number }> {
		const state = (await this.send({ type: "get_state" })) as Record<string, unknown>;
		return state;
	}

	/**
	 * Terminate the child with escalation: cooperative RPC abort, a soft
	 * kill (process group on Unix, tree kill on Windows), then a hard kill
	 * on a short fuse. Pending requests reject immediately via handleClose;
	 * the escalation only concerns reaping the OS processes.
	 */
	kill(): void {
		const proc = this.proc;
		if (proc && proc.exitCode === null && !proc.killed) {
			void this.abort();
			const pid = proc.pid;
			try {
				if (process.platform === "win32") {
					if (pid !== undefined) taskkillTree(pid, false);
				} else if (pid !== undefined) {
					process.kill(-pid, "SIGTERM"); // own process group (detached spawn)
				}
			} catch {
				// Already gone.
			}
			const timer = setTimeout(() => {
				try {
					if (process.platform === "win32") {
						if (pid !== undefined) taskkillTree(pid, true);
					} else if (pid !== undefined) {
						process.kill(-pid, "SIGKILL");
					}
				} catch {
					// Already gone.
				}
			}, 1_500);
			timer.unref?.();
		}
		this.handleClose(null);
	}

	/**
	 * Synchronous hard kill for process-exit and reload paths, where kill()'s
	 * escalation timer would never fire (unref'd timers do not run during
	 * exit). Blocks briefly; only ever called at teardown.
	 */
	killSync(): void {
		const proc = this.proc;
		if (proc && proc.exitCode === null && !proc.killed) {
			const pid = proc.pid;
			try {
				if (process.platform === "win32") {
					if (pid !== undefined) {
						const root = process.env.SystemRoot || "C:\\Windows";
						spawnSync(path.join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
					}
				} else if (pid !== undefined) {
					process.kill(-pid, "SIGKILL");
				}
			} catch {
				// Already gone.
			}
		}
		this.handleClose(null);
	}
}
