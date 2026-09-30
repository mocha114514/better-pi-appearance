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
}

const META_FILE = "meta.json";

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

	/** Persist meta.json so crash recovery can rebuild the pool from disk. */
	saveMeta(instance: Instance): void {
		instance.meta.updatedAt = Date.now();
		try {
			fs.mkdirSync(instance.dir, { recursive: true });
			fs.writeFileSync(path.join(instance.dir, META_FILE), `${JSON.stringify(instance.meta, null, 2)}\n`, "utf-8");
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

	/** Drop every instance still awaiting a keep/drop decision. Returns dropped ids. */
	sweepUndecided(): string[] {
		const dropped: string[] = [];
		for (const instance of this.list()) {
			if (instance.meta.status === "awaiting_decision") {
				this.drop(instance.meta.id);
				dropped.push(instance.meta.id);
			}
		}
		return dropped;
	}

	/** Best-effort kill of all live subprocesses (parent shutdown). */
	killAll(): void {
		for (const instance of this.instances.values()) {
			try {
				instance.client?.kill();
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
			// on-disk leftover awaiting the main agent's decision.
			meta.status = "recovered";
			const instance: Instance = {
				meta,
				dir: instancePath,
				displayItems: [],
				usage: emptyUsage(),
				finalOutput: "",
			};
			this.instances.set(meta.id, instance);
			recovered.push(instance);
		}
		if (recovered.length > 0) this.emit();
		return recovered;
	}
}
