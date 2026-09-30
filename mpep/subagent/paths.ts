/**
 * Directory layout for the subagent plugin.
 *
 * Everything lives under the shared MPEP cache (outside the installed package,
 * so updates never touch user data):
 *
 *   mpep-cache/subagent/
 *   ├── agents/                  agent definition .md files (user-editable)
 *   └── sessions/
 *       └── <main-session-id>/   one folder per owning main session
 *           └── <instance-id>/   one folder per subagent instance
 *               ├── prompt.md    rendered system-prompt appendix
 *               ├── meta.json    instance metadata (status, task, ...)
 *               └── <uuid>.jsonl the Pi session file (context on disk)
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getCacheDir } from "../shared/paths.ts";

/** Session ids are uuids, but stay defensive: keep folder names filesystem-safe. */
function sanitize(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function subagentRoot(): string {
	return join(getCacheDir(), "subagent");
}

export function agentsDir(): string {
	return join(subagentRoot(), "agents");
}

export function sessionsDir(): string {
	return join(subagentRoot(), "sessions");
}

export function mainSessionDir(mainSessionId: string): string {
	return join(sessionsDir(), sanitize(mainSessionId));
}

export function instanceDir(mainSessionId: string, instanceId: string): string {
	return join(mainSessionDir(mainSessionId), sanitize(instanceId));
}

export function ensureSubagentDirs(): void {
	mkdirSync(agentsDir(), { recursive: true });
	mkdirSync(sessionsDir(), { recursive: true });
}
