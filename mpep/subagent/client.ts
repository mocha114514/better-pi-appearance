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
 *   event:    { type: "event", event: { type: "agent_end" | ... } }
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";

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

/** Kill a process and its children; on Windows Node cannot kill trees natively. */
export function killTree(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.killed) return;
	try {
		if (process.platform === "win32" && proc.pid !== undefined) {
			spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			proc.kill("SIGKILL");
		}
	} catch {
		// Already gone.
	}
}

export class RpcSubprocess {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private nextId = 0;
	private pending = new Map<string, PendingRequest>();
	private listeners = new Set<(event: RpcEvent) => void>();
	private exitListeners = new Set<(code: number | null) => void>();
	private stderrTail: string[] = [];
	private readonly cwd: string;
	private readonly args: string[];

	/** The subprocess is considered dead once close fires. */
	alive = false;

	constructor(cwd: string, args: string[]) {
		this.cwd = cwd;
		this.args = args;
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onExit(listener: (code: number | null) => void): void {
		this.exitListeners.add(listener);
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
		});
		this.proc = proc;
		this.alive = true;

		proc.stdout?.on("data", (chunk: Buffer) => this.handleData(chunk.toString("utf-8")));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail.push(chunk.toString("utf-8"));
			if (this.stderrTail.length > 10) this.stderrTail.shift();
		});
		proc.on("error", () => this.handleClose(null));
		proc.on("close", (code) => this.handleClose(code));

		// Wait until the RPC loop answers. Startup includes config/auth loading
		// and can take a moment; give it room but fail eventually.
		const deadline = Date.now() + 60_000;
		for (;;) {
			try {
				await this.send({ type: "get_state" });
				return;
			} catch (error) {
				if (!this.alive) throw new Error(`pi RPC process exited during startup. ${this.stderrText()}`);
				if (Date.now() > deadline) throw error;
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
		for (const listener of this.exitListeners) listener(code);
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

		// Everything that is not a command response is a session event emitted
		// as-is ({ type: "agent_end", ... }), not wrapped in an envelope.
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
			proc.stdin!.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	}

	/** Fire a prompt; the returned promise resolves once the run is accepted. */
	prompt(message: string): Promise<unknown> {
		return this.send({ type: "prompt", message });
	}

	abort(): Promise<unknown> {
		return this.send({ type: "abort" }).catch(() => undefined);
	}

	kill(): void {
		if (this.proc) killTree(this.proc);
		this.handleClose(null);
	}
}
