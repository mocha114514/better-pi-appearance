/**
 * Subagent instance pool.
 *
 * An instance is a (possibly resident) `pi --mode rpc` subprocess plus a
 * directory on disk holding its session file. The directory is the source of
 * truth that survives crashes; the process is a warm cache on top of it.
 *
 * Status machine:
 *   running            a task is executing right now
 *   awaiting_decision  delivered a result; the main agent must keep or drop it.
 *                      turn_end sweeps undecided instances into `drop`.
 *   kept               explicitly retained for follow-up prompts (resident)
 *   recovered          loaded from disk after a crash/restart; no live process
 *
 * drop = kill the process (if any) + delete the instance directory.
 * keep = leave the resident process alive and the directory in place.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RpcSubprocess } from "./client.ts";
import type { DisplayItem, UsageStats } from "./render.ts";
import { instanceDir, mainSessionDir } from "./paths.ts";

export type InstanceStatus = "running" | "awaiting_decision" | "kept" | "recovered";

export interface InstanceMeta {
	id: string;
	agent: string;
	/** Pi session id (uuid); the session file is <dir>/<sessionId>.jsonl. */
	sessionId: string;
	task: string;
	/** Resolved spawn-time values (inheritance already applied); for display. */
	model?: string;
	thinking?: string;
	createdAt: number;
	updatedAt: number;
	status: InstanceStatus;
	/** Persisted mailbox state: an unread result survives a main-session
	 * restart; the settle sweep spares it until subagent_check reads it. */
	unread?: boolean;
	/** Persisted interruption detail, shown by subagent_check on recovery. */
	lastError?: string;
	/** Spawn-time structured-output contract: warm continuations must honor it
	 * even if the agent definition was edited or deleted meanwhile. */
	hasStructuredOutput?: boolean;
}

export interface Instance {
	meta: InstanceMeta;
	dir: string;
	/** Live RPC subprocess; absent for recovered/crashed instances. */
	client?: RpcSubprocess;
	/** Transient display state of the latest run. */
	displayItems: DisplayItem[];
	usage: UsageStats;
	finalOutput: string;
	/** Set when the main agent deliberately aborted this run: the background
	 * completion handler consumes the flag and skips the wake-up notification. */
	abortInitiated?: boolean;
	/** In-flight background run handler; subagent_abort awaits it so a
	 * continuation can never overlap the run it just interrupted. */
	runPromise?: Promise<void>;
}

const META_FILE = "meta.json";
const RESULT_FILE = "result.md";

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export class InstancePool {
	private instances = new Map<string, Instance>();
	private listeners = new Set<() => void>();

	constructor(private readonly mainSessionId: string) {}

	/** Subscribe to pool mutations (add/drop/status change/recovery). */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	get(id: string): Instance | undefined {
		return this.instances.get(id);
	}

	list(): Instance[] {
		return [...this.instances.values()].sort((a, b) => a.meta.createdAt - b.meta.createdAt);
	}

	add(instance: Instance): void {
		this.instances.set(instance.meta.id, instance);
		this.emit();
	}

	/** Persist meta.json so crash recovery can rebuild the pool from disk.
	 * Written atomically (tmp + rename): a force-kill mid-write must never
	 * leave a truncated meta behind, or recovery silently skips the instance. */
	saveMeta(instance: Instance): void {
		instance.meta.updatedAt = Date.now();
		try {
			fs.mkdirSync(instance.dir, { recursive: true });
			const target = path.join(instance.dir, META_FILE);
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, `${JSON.stringify(instance.meta, null, 2)}\n`, "utf-8");
			fs.renameSync(tmp, target);
		} catch {
			// Metadata is a recovery aid; never fail the tool over it.
		}
		this.emit();
	}

	/** Kill the process if alive, delete the directory, forget the instance. */
	drop(id: string): boolean {
		const instance = this.instances.get(id);
		if (!instance) return false;
		try {
			instance.client?.kill();
		} catch {
			// Already gone.
		}
		try {
			fs.rmSync(instance.dir, { recursive: true, force: true });
			// Remove the per-session folder too once its last instance is gone.
			const parent = path.dirname(instance.dir);
			if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
				fs.rmdirSync(parent);
			}
		} catch {
			// Directory removal is best-effort; a leftover dir is recoverable.
		}
		this.instances.delete(id);
		this.emit();
		return true;
	}

	/** Drop every instance still awaiting a keep/drop decision. Returns dropped ids.
	 * Instances with an UNREAD result are spared: the main agent has not had a
	 * chance to fetch it via subagent_check yet. */
	sweepUndecided(): string[] {
		const dropped: string[] = [];
		for (const instance of this.list()) {
			if (instance.meta.status === "awaiting_decision" && !instance.meta.unread) {
				this.drop(instance.meta.id);
				dropped.push(instance.meta.id);
			}
		}
		return dropped;
	}

	/**
	 * Shutdown reaping (parent exit / reload). The registry is cleared FIRST so
	 * any dying async callback (background completion racing the teardown) sees
	 * itself unregistered and stays silent — no ghost notifications waking the
	 * main agent while it is going away. Kills are synchronous and forced:
	 * timer-based escalation does not run inside exit handlers.
	 */
	killAll(): void {
		const instances = [...this.instances.values()];
		this.instances.clear();
		for (const instance of instances) {
			try {
				instance.client?.killSync();
			} catch {
				// Already gone.
			}
		}
	}

	/**
	 * Load instance directories left behind by an interrupted main session.
	 * Anything found on disk becomes a `recovered` instance with no process.
	 */
	recoverFromDisk(): Instance[] {
		const dir = mainSessionDir(this.mainSessionId);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}

		const recovered: Instance[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (this.instances.has(entry.name)) continue;
			const instancePath = instanceDir(this.mainSessionId, entry.name);
			let meta: InstanceMeta | undefined;
			try {
				meta = JSON.parse(fs.readFileSync(path.join(instancePath, META_FILE), "utf-8")) as InstanceMeta;
			} catch {
				continue; // No readable metadata: not one of ours / too corrupt.
			}
			// Whatever it was doing when the main session died, it is now an
			// on-disk leftover awaiting the main agent's decision. One exception:
			// an instance that had COMPLETED with an unread result keeps its
			// mailbox — the result file is the whole point of the mailbox model.
			const instance: Instance = {
				meta,
				dir: instancePath,
				displayItems: [],
				usage: emptyUsage(),
				finalOutput: "",
			};
			if (meta.status === "awaiting_decision") {
				try {
					instance.finalOutput = fs.readFileSync(path.join(instancePath, RESULT_FILE), "utf-8");
				} catch {
					// Result file missing/corrupt: degrade to a resumable leftover.
					meta.status = "recovered";
				}
			} else {
				meta.status = "recovered";
			}
			this.instances.set(meta.id, instance);
			recovered.push(instance);
		}
		if (recovered.length > 0) this.emit();
		return recovered;
	}
}
