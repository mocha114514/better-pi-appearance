/**
 * Agent definition discovery.
 *
 * Agents are Markdown files with YAML frontmatter in mpep-cache/subagent/agents/.
 * The frontmatter configures the spawned Pi process; the body is appended to
 * Pi's default system prompt (never replaces it).
 *
 * Supported frontmatter fields:
 *   name          (required) agent handle used by the main agent
 *   description   (required) one-liner shown to the main agent for selection
 *   model         model pattern, e.g. "anthropic/claude-haiku-4-5"; inherits the
 *                 dispatching session's model when omitted
 *   thinking      off|minimal|low|medium|high|xhigh|max; inherits when omitted
 *   tools         allowlist of tool names (comma string or YAML array)
 *   exclude_tools denylist of tool names (mutually exclusive with `tools`)
 *   extensions    extra extension files to load (YAML array); the subagent always
 *                 runs with --no-extensions, so only what is listed here is loaded
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentsDir } from "./paths.ts";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	excludeTools?: string[];
	model?: string;
	thinking?: string;
	extensions: string[];
	systemPrompt: string;
	filePath: string;
}

/** `parseFrontmatter` yields real YAML values, so validate every field. */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	exclude_tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	extensions?: unknown;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Accept both `tools: read, bash` and `tools: [read, bash]`. Bad values yield undefined. */
function parseStringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const items = raw
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function loadAgentFile(filePath: string): AgentConfig | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
		return undefined;
	}

	const thinking =
		typeof frontmatter.thinking === "string" && THINKING_LEVELS.has(frontmatter.thinking)
			? frontmatter.thinking
			: undefined;

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: parseStringList(frontmatter.tools),
		excludeTools: parseStringList(frontmatter.exclude_tools),
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking,
		extensions: parseStringList(frontmatter.extensions) ?? [],
		systemPrompt: body,
		filePath,
	};
}

/** Fresh scan on every call: agents can be edited mid-session. */
export function discoverAgents(): AgentConfig[] {
	const dir = agentsDir();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const agent = loadAgentFile(path.join(dir, entry.name));
		if (agent) agents.push(agent);
	}
	return agents;
}

/** Template seeded into an empty agents directory so users have a starting point. */
const TEMPLATE_AGENT = `---
name: scout
description: Fast read-only codebase reconnaissance; returns a compressed summary of relevant files and structure
tools: read, grep, find, ls, bash
thinking: medium
# model: anthropic/claude-haiku-4-5   # omit to inherit the dispatching session's model
# exclude_tools: write, edit          # alternative to \`tools\`: denylist instead of allowlist
# extensions:                         # extra extension files to load (runs with --no-extensions otherwise)
#   - ./some-extension.ts
---

You are a reconnaissance subagent. Explore the codebase to answer the task you
are given. Be fast and thorough, but strictly read-only: never modify files.

Deliver a compressed summary: key file paths with line references, relevant
structure, and direct answers. Omit anything the caller did not ask for.
`;

export function seedTemplateIfEmpty(): void {
	const dir = agentsDir();
	let hasAgent = false;
	try {
		hasAgent = fs.readdirSync(dir).some((name) => name.endsWith(".md"));
	} catch {
		hasAgent = false;
	}
	if (!hasAgent) {
		try {
			fs.writeFileSync(path.join(dir, "scout.md"), TEMPLATE_AGENT, "utf-8");
		} catch {
			// A missing template must never break plugin startup.
		}
	}
}
