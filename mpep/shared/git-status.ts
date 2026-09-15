/**
 * Git repository probing and formatting for the MPEP statusline.
 *
 * This module deliberately has no dependency on the Pi SDK, on rendering or on the locale:
 * it owns "what does the repository look like right now" while `statusline.ts` owns "how is
 * that drawn". Keeping the two apart lets the parsing rules and the refresh schedule be unit
 * tested without a terminal, and lets the display be restyled without touching the grammar.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Change counts by category, using the same letters as `git status --short`. */
export interface GitChangeCounts {
	modified: number;
	added: number;
	deleted: number;
	renamed: number;
	copied: number;
	typeChanged: number;
}

/** One probe result. Everything the statusline needs to draw the git area. */
export interface GitStatusSnapshot {
	/** Current branch, or null when HEAD is detached (or unreadable). */
	branch: string | null;
	/** Commits the branch is ahead of / behind its upstream. Zero when there is none. */
	ahead: number;
	behind: number;
	/**
	 * Changes by category, counting the staged and the unstaged zone together. A path is counted
	 * once per category it appears in, so a file that is both staged and modified again still
	 * reports as a single modified file.
	 */
	changes: GitChangeCounts;
	untracked: number;
	/** Unmerged paths. Reported separately because they block committing. */
	conflicted: number;
}

/** A display token. `alarm` asks the statusline for the alert colour. */
export interface GitStatusToken {
	text: string;
	alarm: boolean;
}

/** Ready-to-draw git area: the branch, whether anything changed, and the counters. */
export interface GitStatusDisplay {
	branch: string;
	clean: boolean;
	tokens: GitStatusToken[];
}

function emptyCounts(): GitChangeCounts {
	return { modified: 0, added: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 };
}

/** Display order of the counters and the letter each one is reported with. */
const COUNTER_ORDER: ReadonlyArray<readonly [keyof GitChangeCounts, string]> = [
	["modified", "M"],
	["added", "A"],
	["deleted", "D"],
	["renamed", "R"],
	["copied", "C"],
	["typeChanged", "T"],
];

/**
 * Count one path from its `XY` pair. The staged and unstaged zones are folded together: the pair
 * is inspected as a whole and each category the path appears in is counted once. So `MM` is a
 * single modified file, while `MD` contributes one modified *and* one deleted entry because the
 * path really is both staged as a modification and removed from the worktree.
 */
function countPair(counts: GitChangeCounts, xy: string): void {
	for (const [field, letter] of COUNTER_ORDER) {
		if (xy.includes(letter)) counts[field]++;
	}
}

/** Read the `# branch.*` header lines of `git status --porcelain=v2 --branch`. */
function applyHeader(snapshot: GitStatusSnapshot, body: string): void {
	if (body.startsWith("branch.head ")) {
		const name = body.slice("branch.head ".length).trim();
		// Git reports a detached HEAD as the literal "(detached)" instead of a name.
		snapshot.branch = name === "" || name === "(detached)" ? null : name;
		return;
	}
	if (body.startsWith("branch.ab ")) {
		const match = /^\+(\d+)\s+-(\d+)$/.exec(body.slice("branch.ab ".length).trim());
		if (match) {
			snapshot.ahead = Number(match[1]);
			snapshot.behind = Number(match[2]);
		}
	}
}

/**
 * Parse `git status --porcelain=v2 --branch --untracked-files=normal`.
 *
 * Only the record type and the `XY` pair are inspected, never a path, so quoted or
 * unusual file names cannot break the counts; unknown record types are skipped and a
 * wrapped path line simply matches nothing.
 */
export function parseGitStatus(stdout: string): GitStatusSnapshot {
	const snapshot: GitStatusSnapshot = {
		branch: null,
		ahead: 0,
		behind: 0,
		changes: emptyCounts(),
		untracked: 0,
		conflicted: 0,
	};
	for (const line of stdout.split("\n")) {
		if (line === "") continue;
		if (line.startsWith("# ")) {
			applyHeader(snapshot, line.slice(2));
			continue;
		}
		switch (line[0]) {
			case "1": // ordinary change
			case "2": // rename/copy: same XY semantics as "1"
				countPair(snapshot.changes, line.slice(2, 4));
				break;
			case "u": // unmerged: XY holds a conflict code, not a plain change
				snapshot.conflicted++;
				break;
			case "?":
				snapshot.untracked++;
				break;
			default:
				// "!" (ignored, only emitted with --ignored) and anything unknown.
				break;
		}
	}
	return snapshot;
}

/** Render the counters that are present, in the fixed display order. */
function formatCounts(counts: GitChangeCounts): string[] {
	const tokens: string[] = [];
	for (const [field, letter] of COUNTER_ORDER) {
		if (counts[field] > 0) tokens.push(`${letter}${counts[field]}`);
	}
	return tokens;
}

/**
 * Turn a snapshot into display tokens, e.g. `M3 A1 R1 ?2`.
 *
 * The order is fixed (conflicts, then M A D R C T, then untracked) so the line never reshuffles
 * between refreshes. Divergence from the upstream is deliberately not part of this: those
 * counters are rendered by the statusline, which is where the locale-aware wording lives.
 */
export function formatGitStatus(snapshot: GitStatusSnapshot, detachedLabel: string): GitStatusDisplay {
	const tokens: GitStatusToken[] = [];
	if (snapshot.conflicted > 0) tokens.push({ text: `!${snapshot.conflicted}`, alarm: true });
	for (const text of formatCounts(snapshot.changes)) tokens.push({ text, alarm: false });
	if (snapshot.untracked > 0) tokens.push({ text: `?${snapshot.untracked}`, alarm: false });
	return { branch: snapshot.branch ?? detachedLabel, clean: tokens.length === 0, tokens };
}

/**
 * One status call returns the branch, the upstream divergence and every change record,
 * so a refresh costs a single git process instead of one per question.
 * `--no-optional-locks` keeps us from rewriting the index behind a concurrent git.
 */
const STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"];
/** A busy repository prints one line per changed path, so allow a generous pipe. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Throws when git is missing or `cwd` is not inside a repository. */
export async function readGitStatus(cwd: string): Promise<GitStatusSnapshot> {
	const { stdout } = await execFileAsync("git", STATUS_ARGS, {
		cwd,
		maxBuffer: MAX_OUTPUT_BYTES,
		windowsHide: true,
	});
	return parseGitStatus(stdout);
}

/** Repository root for `cwd`, or null when there is none. */
export async function resolveGitRoot(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], {
			cwd,
			windowsHide: true,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/** Where a tracker gets its data. Swapped out in tests to avoid spawning git. */
export interface GitStatusSource {
	readStatus(cwd: string): Promise<GitStatusSnapshot>;
	resolveRoot(cwd: string): Promise<string | null>;
}

/** The production source: the local `git` binary. */
export const gitBinarySource: GitStatusSource = { readStatus: readGitStatus, resolveRoot: resolveGitRoot };

export interface GitStatusTrackerOptions {
	/** Delay between automatic probes. */
	intervalMs: number;
	getCwd: () => string;
	/** Fired after every finished probe so the UI can repaint. */
	onUpdate?: () => void;
	source?: GitStatusSource;
}

/**
 * Keeps one cached snapshot fresh: a periodic probe plus on-demand refreshes.
 *
 * Probing is asynchronous and never throws at the caller; a failed probe (no git, not a
 * repository) simply clears the snapshot so the statusline drops the git area. Overlapping
 * probes are collapsed: a request arriving mid-flight only marks that one further pass is
 * needed, which keeps a burst of triggers from spawning a burst of git processes.
 */
export class GitStatusTracker {
	private snapshot: GitStatusSnapshot | null = null;
	private projectRoot: string | null = null;
	/** cwd the cached root was resolved for, so a session cwd change re-resolves it. */
	private rootCwd: string | null = null;
	private rootResolved = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight = false;
	private pending = false;
	private manualQueued = false;
	private refreshedAt = 0;

	private readonly options: GitStatusTrackerOptions;

	constructor(options: GitStatusTrackerOptions) {
		this.options = options;
	}

	private get source(): GitStatusSource {
		return this.options.source ?? gitBinarySource;
	}

	/** Begins the periodic probe and reads the status once right away. */
	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => void this.probe(), this.options.intervalMs);
		this.timer.unref();
		void this.probe();
	}

	/** Stops probing. Safe to call more than once. */
	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		this.pending = false;
		this.manualQueued = false;
	}

	/**
	 * Queues an immediate probe. Ignored until `start()` so background triggers such as
	 * an agent round ending do not spawn git while the statusline is unmounted.
	 */
	refresh(flags: { manual?: boolean } = {}): void {
		if (this.timer === null) return;
		if (flags.manual) this.manualQueued = true;
		if (this.inFlight) {
			this.pending = true;
			return;
		}
		void this.probe();
	}

	/** Latest snapshot, or null when git is unavailable or nothing has been read yet. */
	getSnapshot(): GitStatusSnapshot | null {
		return this.snapshot;
	}

	/** Repository root, or `fallback` while the first probe is still running. */
	getProjectRoot(fallback: string): string {
		return this.projectRoot ?? fallback;
	}

	/**
	 * Timestamp of the last completed on-demand refresh, or 0. The statusline uses it to
	 * show the "refreshed" marker for a moment; it is set on completion so the marker never
	 * claims a refresh that is still in flight.
	 */
	getLastManualRefreshAt(): number {
		return this.refreshedAt;
	}

	private async probe(): Promise<void> {
		if (this.inFlight) {
			this.pending = true;
			return;
		}
		this.inFlight = true;
		const manual = this.manualQueued;
		this.manualQueued = false;
		const cwd = this.options.getCwd();
		try {
			if (this.rootCwd !== cwd) {
				this.rootCwd = cwd;
				this.rootResolved = false;
				this.projectRoot = null;
			}
			if (!this.rootResolved) {
				this.projectRoot = await this.source.resolveRoot(cwd);
				this.rootResolved = true;
			}
			this.snapshot = await this.source.readStatus(cwd);
			if (manual) this.refreshedAt = Date.now();
		} catch {
			this.snapshot = null;
		} finally {
			this.inFlight = false;
			this.options.onUpdate?.();
			if (this.pending) {
				this.pending = false;
				void this.probe();
			}
		}
	}
}
