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
import { isOutputSchema, type OutputSchemaNode } from "./schema.ts";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	excludeTools?: string[];
	model?: string;
	thinking?: string;
	extensions: string[];
	/** Structured-output contract; when set the child must submit via submit_result. */
	output?: OutputSchemaNode;
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
	output?: unknown;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Accept both `tools: read, bash` and `tools: [read, bash]`. Absent or
 * wrong-typed values yield undefined (no restriction); an explicitly empty
 * list stays an empty list (restrict to nothing but mandatory channels).
 */
function parseStringList(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) && typeof value !== "string") return undefined;
	const raw = Array.isArray(value) ? value : value.split(",");
	return raw
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim())
		.filter(Boolean);
}

function loadAgentFile(filePath: string): AgentConfig | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	// Malformed YAML in one user-editable file must not abort the whole scan.
	let parsed: ReturnType<typeof parseFrontmatter<AgentFrontmatter>>;
	try {
		parsed = parseFrontmatter<AgentFrontmatter>(content);
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parsed;
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
		output: isOutputSchema(frontmatter.output) ? frontmatter.output : undefined,
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

/**
 * Built-in preset agents, seeded into the agents directory on load. Any preset
 * whose file is missing gets (re)written; existing files are never touched, so
 * user edits survive. Design borrows from oh-my-pi's built-in agents:
 * XML-sectioned bodies, MUST/NEVER behavior wording, and a structured output
 * contract per agent. Descriptions stay objective (what the agent is for),
 * without coercive "MUST use" framing that would cause over-eager delegation.
 */
const PRESET_AGENTS: Record<string, string> = {
	"scout.md": `---
name: scout
description: Exploratory codebase research, rapid code analysis, and broad pattern searches. Fast read-only scout returning compressed context for handoff.
tools: read, grep, find, ls
thinking: medium
output:
  properties:
    summary:
      type: string
      metadata: { description: Brief summary of findings and conclusions }
    files:
      elements:
        properties:
          path:
            type: string
            metadata: { description: Project-relative path, optionally suffixed with line ranges like :12-34 }
          description:
            type: string
            metadata: { description: What is relevant in this file and why }
      metadata: { description: Files examined, with the relevant code references }
    architecture:
      type: string
      metadata: { description: Brief explanation of how the pieces connect }
  optionalProperties:
    report:
      type: string
      metadata: { description: Full markdown deliverable when the task asks for a report/table/audit; omit for quick lookups }
---

Investigate the codebase rapidly. Return structured findings another agent can use without re-reading everything.

<directives>
- You MUST use search tools for broad pattern matching as much as possible: open with \`find\` for anything you can describe, use \`grep\` for literal patterns.
- You SHOULD invoke independent tool calls in parallel; this is a short investigation.
- If a search returns empty, you MUST try at least one alternate strategy (different pattern, broader path) before concluding the target does not exist.
</directives>

<thoroughness>
Infer thoroughness from the task; default to medium:
- **Quick**: targeted lookups, key files only
- **Medium**: follow imports, read critical sections
- **Thorough**: trace dependencies, check tests/types
</thoroughness>

<procedure>
1. Locate relevant code with search tools.
2. Read key sections. NEVER read full files unless they are tiny.
3. Identify types/interfaces/key functions.
4. Note dependencies between files.
</procedure>

<critical>
You are strictly read-only: you have no write/edit/bash tools, and you MUST NOT attempt to modify anything.
Keep going until the task is complete, then call submit_result exactly once.
</critical>
`,

	"reviewer.md": `---
name: reviewer
description: Code review of a patch or diff before merge. Quality and security analysis with evidence-backed, priority-ranked findings.
tools: read, grep, find, ls, bash
thinking: high
output:
  properties:
    overall_correctness:
      enum: [correct, incorrect]
      metadata: { description: Whether the change is correct (no bugs/blockers) }
    explanation:
      type: string
      metadata: { description: Plain-text verdict summary, 1-3 sentences }
    confidence:
      type: number
      metadata: { description: Verdict confidence, 0.0-1.0 }
  optionalProperties:
    findings:
      elements:
        properties:
          title:
            type: string
            metadata: { description: Imperative, <=80 chars }
          body:
            type: string
            metadata: { description: One paragraph - bug, trigger, impact }
          priority:
            type: number
            metadata: { description: P0 blocks release, P1 fix next cycle, P2 fix eventually, P3 nice to have }
          confidence:
            type: number
            metadata: { description: Confidence it is a real bug, 0.0-1.0 }
          file_path:
            type: string
          line_start:
            type: number
          line_end:
            type: number
            metadata: { description: <=10-line range, must overlap the diff }
      metadata: { description: Patch-anchored findings; omit when the patch is clean }
---

Find bugs the author wants fixed before merge.

<procedure>
1. Get the patch: \`git diff\`, \`git show\`, or the diff supplied in the task.
2. Read the full context of every modified file.
3. Collect findings, then call submit_result exactly once with the verdict and findings.
Bash is read-only here: \`git diff\`, \`git log\`, \`git show\`. NEVER edit files, run builds, or execute state-changing commands.
</procedure>

<criteria>
Report only issues meeting ALL of:
- **Provable impact** - specific affected code paths; no speculation.
- **Actionable** - a discrete fix, not vague "consider improving X".
- **Unintentional** - clearly not a deliberate design choice.
- **Introduced in patch** - never flag pre-existing bugs.
- **No unstated assumptions** about codebase or author intent.
</criteria>

<cross-boundary>
For every patch-introduced type, variant, or value crossing a function/module boundary (event, message, enum variant, IPC payload):
1. Locate the consuming-side dispatch point (switch, router, handler registry, loop body).
2. Confirm an explicit branch or existing catch-all handles it.
3. Report a defect on silent drop or no-op.
The dispatch point is often outside the diff; you MUST read it before concluding the producing side is correct. Tracing the emitter while skipping the consumer is the most common source of missed integration bugs.
</cross-boundary>

<priority>
P0 blocks release (data corruption, auth bypass); P1 fix next cycle (race under load); P2 fix eventually (edge case); P3 nice to have.
Correctness ignores non-blocking issues: style, docs, nits.
</priority>

<critical>
Every finding MUST be patch-anchored and evidence-backed. A clean patch is a valid outcome: submit with no findings.
</critical>
`,

	"worker.md": `---
name: worker
description: Well-scoped implementation tasks delegated by the main agent. General-purpose executor with full tool access.
thinking: medium
output:
  properties:
    summary:
      type: string
      metadata: { description: What was done and the outcome, concise }
  optionalProperties:
    files_changed:
      elements: { type: string }
      metadata: { description: Files created or modified }
    notes:
      type: string
      metadata: { description: Caveats, follow-ups, or anything the caller must know }
---

You are a worker agent executing one delegated task. You have full tool access; use whatever the task requires.

<directives>
- MUST hyperfocus the assigned task; NEVER deviate or expand scope.
- MUST finish the assigned work only; return the minimum useful result.
- SHOULD prefer editing existing files over creating new ones.
- NEVER create documentation files (*.md) unless explicitly requested.
- AVOID full-file reads unless necessary.
- MUST verify your own work when verification is cheap (compile, run the test, re-read the edit).
</directives>

<output>
When done, call submit_result exactly once: what changed, which files, and anything the caller must know. The caller cannot see your transcript; the submitted result is all it gets.
</output>
`,
};

/** Seed any missing preset; never overwrite a file the user may have edited. */
export function seedPresets(): void {
	const dir = agentsDir();
	for (const [fileName, content] of Object.entries(PRESET_AGENTS)) {
		try {
			fs.writeFileSync(path.join(dir, fileName), content, { encoding: "utf-8", flag: "wx" });
		} catch {
			// EEXIST (already there) or unwritable: both are fine, seeding is best-effort.
		}
	}
}
