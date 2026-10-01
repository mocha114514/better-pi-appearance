/**
 * Subagent plugin: delegate tasks to specialized agents running as resident
 * `pi --mode rpc` subprocesses with isolated context windows.
 *
 * Layout (see paths.ts):
 *   mpep-cache/subagent/agents/             agent definitions (.md)
 *   mpep-cache/subagent/sessions/<main>/<instance>/   session files + metadata
 *
 * Lifecycle contract with the main agent (all dispatches are ASYNC):
 *   - the subagent tool returns immediately; completion is announced by a
 *     light steer notification and the result is fetched via subagent_check
 *     (mailbox model — results are never pushed in full);
 *   - after reading a result the main agent must keep or drop the instance
 *     via subagent_decide; undecided READ instances are swept (dropped) at
 *     turn end, unread results are spared;
 *   - "keep" retains the resident process and its on-disk session for exactly
 *     one follow-up; the question is asked again after the next delivery;
 *   - anything left on disk by an interrupted run is recovered at session
 *     start and reported to the main agent, which must resume or drop it.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isPluginEnabled } from "../manager/preferences.ts";
import { discoverAgents, seedPresets, type AgentConfig } from "./agents.ts";
import { RpcSubprocess } from "./client.ts";
import { emptyUsage, InstancePool, type Instance } from "./pool.ts";
import { canonicalId, ensureSubagentDirs, instanceDir } from "./paths.ts";
import { describeSchema } from "./schema.ts";
import { installSubagentWidget, type SubagentWidgetController } from "./widget.ts";
import {
	aggregateUsage,
	extractFinalText,
	formatToolCallItem,
	formatUsageStats,
	renderSubagentCall,
	renderSubagentResult,
	truncate,
} from "./render.ts";

// Extensions can be reloaded; the symbol slot lets a fresh copy tear down the
// previous installation instead of stacking handlers and resident processes.
const SLOT = Symbol.for("mpep.subagent.dispose");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;

interface RunOutcome {
	finalOutput: string;
	messages: unknown;
}

export default function (pi: ExtensionAPI): void {
	if (!isPluginEnabled("subagent")) return;
	installations[SLOT]?.();

	ensureSubagentDirs();
	seedPresets();

	/** Absolute path of the child-side companion extension (this plugin ships it). */
	const childExtensionPath = fileURLToPath(new URL("./child-output.ts", import.meta.url));
	/** Sibling plugin loaded into every subagent by default: pre-compaction
	 * forewarning matters just as much in a child's context window. Its own
	 * isPluginEnabled guard still applies, so disabling it in the plugin
	 * manager disables it for subagents too. */
	const compactForewarnPath = fileURLToPath(new URL("../compact-forewarn/index.ts", import.meta.url));

	let ctx: ExtensionContext | undefined;
	let pool: InstancePool | undefined;
	let poolSessionId = "";
	let pendingReminder: string | undefined;
	let widget: SubagentWidgetController | undefined;

	// Key the pool by SESSION ID, never by context identity: pi hands a fresh
	// ExtensionContext object to each tool call, so comparing context references
	// would silently rebuild (and empty) the pool on every call.
	function ensurePool(context: ExtensionContext): InstancePool {
		const sessionId = context.sessionManager.getSessionId() || `pid-${process.pid}`;
		if (!pool || poolSessionId !== sessionId) {
			pool = new InstancePool(sessionId);
			poolSessionId = sessionId;
		}
		ctx = context;
		return pool;
	}

	function buildSpawn(
		agent: AgentConfig,
		instance: Instance,
		cwd: string,
		inheritThinking: string,
		inheritModel?: string,
	): { args: string[]; env?: Record<string, string>; model?: string; thinking: string } {
		const args = [
			"--mode", "rpc",
			"--no-extensions", // no plugin discovery: prevents recursive subagent loading
			"--session-dir", instance.dir,
			"--session-id", instance.meta.sessionId,
		];
		// Omitted in the .md means "inherit the dispatching session", for both
		// model and thinking level; without --model the child would fall back to
		// pi's global default instead of the session's current model.
		const model = agent.model ?? inheritModel;
		const thinking = agent.thinking ?? inheritThinking;
		if (model) args.push("--model", model);
		args.push("--thinking", thinking);
		if (agent.tools) {
			// The allowlist applies to extension tools too, so the channels the
			// child needs must survive it: submit_result (structured delivery)
			// and request_compaction (compact-forewarn is loaded by default).
			const tools = new Set(agent.tools);
			if (agent.output) tools.add("submit_result");
			tools.add("request_compaction");
			args.push("--tools", [...tools].join(","));
		}
		if (agent.excludeTools) {
			args.push("--exclude-tools", agent.excludeTools.filter((t) => t !== "submit_result").join(","));
		}
		// Default sibling extensions + the agent's own declared ones (deduped).
		const extensionPaths = new Set<string>([compactForewarnPath]);
		for (const extension of agent.extensions) {
			extensionPaths.add(path.resolve(cwd, extension));
		}
		for (const extensionPath of extensionPaths) {
			args.push("--extension", extensionPath);
		}

		// Structured output: load the companion extension into the child and hand
		// it the schema + output path through the environment.
		let env: Record<string, string> | undefined;
		if (agent.output) {
			args.push("--extension", childExtensionPath);
			env = {
				MPEP_SUBAGENT_SCHEMA: JSON.stringify(agent.output),
				MPEP_SUBAGENT_OUTPUT: path.join(instance.dir, "output.json"),
			};
		}

		const promptBody = agent.output
			? `${agent.systemPrompt}\n\n<structured-output>\nWhen the task is complete you MUST call the submit_result tool exactly once. ` +
				`Its parameters are your deliverable; do not also repeat them in prose. Required format:\n${describeSchema(agent.output)}\n</structured-output>`
			: agent.systemPrompt;
		if (promptBody.trim()) {
			const promptFile = path.join(instance.dir, "prompt.md");
			fs.writeFileSync(promptFile, promptBody, "utf-8");
			args.push("--append-system-prompt", promptFile);
		}
		return { args, env, model, thinking };
	}

	/** Read and parse the child's submitted output.json; undefined when absent/invalid. */
	function readSubmittedOutput(instance: Instance): unknown {
		try {
			return JSON.parse(fs.readFileSync(path.join(instance.dir, "output.json"), "utf-8"));
		} catch {
			return undefined;
		}
	}

	/**
	 * Post-run structured-output handling shared by the foreground and
	 * background paths: read output.json, nudge once when missing, then fall
	 * back to the raw text.
	 */
	async function finalizeStructuredOutput(
		instance: Instance,
		expectsOutput: boolean,
		outcome: RunOutcome,
		signal?: AbortSignal,
	): Promise<string> {
		let output = outcome.finalOutput;
		if (!expectsOutput) return output;
		let submitted = readSubmittedOutput(instance);
		if (submitted === undefined && !signal?.aborted) {
			// The child ended without submit_result: one explicit reminder
			// round-trip, then fall back to its raw text.
			await runPrompt(
				instance,
				"You finished without calling submit_result. Call submit_result exactly once now, with the required fields.",
				signal,
				undefined,
			);
			submitted = readSubmittedOutput(instance);
		}
		if (submitted !== undefined) return JSON.stringify(submitted, null, 2);
		if (output.trim()) {
			output = `${output}\n\n(note: the subagent did not submit the structured result; above is its raw text output)`;
		}
		return output;
	}

	/**
	 * Async completion path (mailbox model). The dispatch tool call has already
	 * returned; the full result waits in the instance until the main agent
	 * fetches it via subagent_check. Only a LIGHT steer notification is pushed:
	 * it lands at the next tool boundary mid-run, or wakes the main agent when
	 * idle. Results are never pushed in full — the main agent pulls them.
	 */
	function runInBackground(instance: Instance, expectsOutput: boolean, task: string, currentPool: InstancePool): void {
		instance.runPromise = (async () => {
			// True while this instance is registered; drop() removes it and
			// shutdown clears the whole registry, so any async continuation must
			// then stay silent (no ghost writes, no ghost notifications).
			const stillRegistered = () => currentPool.get(instance.meta.id) === instance;
			const notify = (content: string) => {
				try {
					pi.sendMessage(
						{ customType: "mpep-subagent-notice", display: false, content },
						{ triggerTurn: true, deliverAs: "steer" },
					);
				} catch {
					// During reload/shutdown the old extension context is already
					// invalidated; the instance stays discoverable via subagent_list.
				}
			};
			try {
				const outcome = await runPrompt(instance, task, undefined, undefined);
				// Deliberate abort: consume the run silently. The abort tool already
				// moved the instance to awaiting_decision and told the main agent.
				// Checked BEFORE and AFTER finalization: the abort may also arrive
				// while the structured-output nudge round is in flight.
				if (instance.abortInitiated) {
					instance.abortInitiated = false;
					return;
				}
				if (!stillRegistered()) return;
				const output = await finalizeStructuredOutput(instance, expectsOutput, outcome);
				if (instance.abortInitiated) {
					instance.abortInitiated = false;
					return;
				}
				if (!stillRegistered()) return;
				if (!output.trim()) {
					// Zero-output "completion": almost always a provider failure that
					// ended the run before any prose or submit_result (observed live:
					// local providers intermittently return empty responses). Treat it
					// as an interruption, not a delivery — the context is intact and
					// the work is usually harvestable by a cheap continuation.
					instance.meta.lastError = "Run ended without producing any output (likely a provider failure). The context is intact.";
					instance.meta.unread = true;
					instance.meta.status = "recovered";
					currentPool.saveMeta(instance);
					notify(
						`Subagent "${instance.meta.id}" (agent: ${instance.meta.agent}) ended WITHOUT producing any output (likely a provider failure). ` +
							`Its context is intact. Call subagent_check({ instance: "${instance.meta.id}" }) for details; ` +
							`the work is usually harvestable by resuming with a wrap-up instruction.`,
					);
					return;
				}
				// Persist the mailbox: result.md holds the deliverable, meta holds
				// the unread mark, so a main-session restart never loses a result.
				instance.finalOutput = output;
				instance.meta.status = "awaiting_decision";
				instance.meta.unread = true;
				instance.meta.lastError = undefined;
				try {
					fs.writeFileSync(path.join(instance.dir, "result.md"), output, "utf-8");
				} catch {
					// Best-effort; the in-memory copy still serves this session.
				}
				currentPool.saveMeta(instance);
				notify(
					`Subagent "${instance.meta.id}" (agent: ${instance.meta.agent}) has completed. ` +
						`Call subagent_check({ instance: "${instance.meta.id}" }) to read its result, then keep or drop it.`,
				);
			} catch (error) {
				if (instance.abortInitiated) {
					instance.abortInitiated = false;
					return;
				}
				if (!stillRegistered()) return;
				const message = error instanceof Error ? error.message : String(error);
				instance.meta.lastError = message;
				instance.meta.unread = true;
				instance.meta.status = "recovered";
				currentPool.saveMeta(instance);
				notify(
					`Subagent "${instance.meta.id}" (agent: ${instance.meta.agent}) was interrupted: ${truncate(message, 200)} ` +
						`Its context is intact. Call subagent_check({ instance: "${instance.meta.id}" }) for details, ` +
						`then resume it with a wrap-up inquiry to harvest partial work before deciding to drop.`,
				);
			}
		})();
	}

	/** Run one prompt on a live client, streaming progress via onUpdate. */
	function runPrompt(
		instance: Instance,
		task: string,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
	): Promise<RunOutcome> {
		const client = instance.client;
		if (!client) return Promise.reject(new Error("instance has no live process"));
		// An already-aborted signal (e.g. Esc during startup) must not send the task.
		if (signal?.aborted) return Promise.reject(new Error("aborted by user"));
		// Usage is per-task and reset by the dispatch site; nudge rounds of the
		// same delivery (finalizeStructuredOutput) must accumulate onto it.

		return new Promise<RunOutcome>((resolve, reject) => {
			let currentTextItem = "";
			let lastMessages: unknown;
			let done = false;
			let settleTimer: ReturnType<typeof setTimeout> | undefined;
			let pollActive = false;
			let sawRunStart = false;
			let sawAgentEnd = false;
			let idleStreak = 0;
			let probes = 0;
			const pushToolItem = (text: string) => {
				currentTextItem = "";
				instance.displayItems.push({ type: "toolCall", text });
			};
			const report = (note: string) => {
				onUpdate?.({
					content: [{ type: "text", text: note }],
					details: {
						instanceId: instance.meta.id,
						agent: instance.meta.agent,
						displayItems: [...instance.displayItems],
						finalOutput: "",
						usage: instance.usage,
					},
				});
			};

			const offEvent = client.onEvent((event) => {
				if (event.type === "message_update") {
					const delta = (event.assistantMessageEvent as { type?: string; delta?: string } | undefined);
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						currentTextItem += delta.delta;
						const last = instance.displayItems[instance.displayItems.length - 1];
						if (last?.type === "text") last.text = truncate(currentTextItem, 200);
						else instance.displayItems.push({ type: "text", text: truncate(currentTextItem, 200) });
						report("subagent running");
					}
				} else if (event.type === "tool_execution_start") {
					pushToolItem(formatToolCallItem(String(event.toolName ?? "?"), (event.args ?? {}) as Record<string, unknown>));
					report("subagent running");
				} else if (event.type === "tool_execution_end" && event.isError) {
					instance.displayItems.push({ type: "toolResult", text: String(event.toolName ?? ""), isError: true });
				} else if (event.type === "agent_start") {
					sawRunStart = true;
				} else if (event.type === "agent_end") {
					// NOT the finish line: retries and compaction continuations (e.g.
					// the injected compact-forewarn) resume the child after agent_end.
					// Accumulate usage per segment; the run truly ends at agent_settled.
					lastMessages = event.messages;
					sawAgentEnd = true;
					const segment = aggregateUsage(event.messages);
					instance.usage.turns += segment.turns;
					instance.usage.input += segment.input;
					instance.usage.output += segment.output;
					instance.usage.cacheRead += segment.cacheRead;
					instance.usage.cacheWrite += segment.cacheWrite;
					instance.usage.cost += segment.cost;
					instance.usage.contextTokens = segment.contextTokens;
				} else if (event.type === "agent_settled") {
					void confirmIdle();
				}
			});

			// 0.85.x runs auto-compaction asynchronously AFTER agent_settled, and a
			// compaction-resumed run produces further output afterwards. Worse, a
			// FAILED compaction emits no settle at all, and a prompt handled as an
			// extension command starts no run at all (no events, no settle). So the
			// poll loop is armed the moment the prompt is accepted: probe live state
			// until the child is durably idle, then deliver. The no-run watchdog
			// (20 idle probes without agent_start ~ 10s) frees command-only prompts;
			// the probe cap guarantees delivery even if the child wedges.
			const confirmIdle = () => {
				// Single polling chain per run: prompt-accept AND every agent_settled
				// may arm this, and concurrent chains would share (and burn) the
				// probe budget N times faster. The guard is held across the in-flight
				// probe too — a settle arriving mid-request must not arm a parallel
				// timer. It is released only when deliberately re-arming or retiring.
				if (done || pollActive) return;
				pollActive = true;
				settleTimer = setTimeout(() => {
					void (async () => {
						if (done) {
							pollActive = false;
							return;
						}
						try {
							const state = await client.getState();
							const busy = state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0;
							idleStreak = busy ? 0 : idleStreak + 1;
							probes += 1;
							const delivered = (sawAgentEnd && idleStreak >= 2) || (!sawRunStart && idleStreak >= 20);
							if (!delivered && probes < 1200) {
								pollActive = false;
								confirmIdle();
								return;
							}
						} catch {
							pollActive = false;
							return; // process gone: offExit handles the rejection
						}
						finish();
					})();
				}, 500);
			};
			const finish = () => {
				if (done) return;
				done = true;
				cleanup();
				resolve({ finalOutput: extractFinalText(lastMessages), messages: lastMessages });
			};

			const offExit = client.onExit((code) => {
				cleanup();
				reject(new Error(`subagent process exited mid-run (code ${code}). ${client.stderrText()}`.trim()));
			});

			const onAbort = () => {
				cleanup();
				void client.abort();
				client.kill();
				reject(new Error("aborted by user"));
			};
			const cleanup = () => {
				offEvent();
				offExit();
				if (settleTimer) clearTimeout(settleTimer);
				pollActive = false;
				signal?.removeEventListener("abort", onAbort);
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			client.prompt(task).then(
				() => confirmIdle(), // arm the idle watchdog as soon as accepted
				(error: unknown) => {
					cleanup();
					reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
		});
	}

	const INSTANCE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

	/**
	 * Compose the instance id as "<agent>-<name>". The name is chosen by the
	 * main agent for readability; invalid characters are REJECTED rather than
	 * sanitized, so the id the caller remembers always matches reality.
	 * Uniqueness is enforced among living instances only: dead ids are
	 * reusable (the directory is gone by then).
	 */
	function composeInstanceId(agentName: string, name: string | undefined, pool: InstancePool): string {
		const trimmed = name?.trim();
		if (!trimmed) return `${agentName}-${randomUUID().slice(0, 8)}`;
		if (!INSTANCE_NAME_PATTERN.test(trimmed)) {
			throw new Error(`Invalid subagent name "${trimmed}": use 1-64 characters of letters, digits, underscore or hyphen.`);
		}
		const id = `${agentName}-${trimmed}`;
		// Directory identity is the real constraint: Windows filesystems are
		// case-insensitive, so scout-Foo and scout-foo would silently share one
		// directory (and one session file) if only the raw id were compared.
		const idCanonical = canonicalId(id);
		if (pool.list().some((i) => canonicalId(i.meta.id) === idCanonical)) {
			throw new Error(`A living subagent instance "${id}" already exists; pick a different name.`);
		}
		return id;
	}

	/**
	 * Resolve an instance reference. Exact id first; otherwise a unique
	 * "<agent>-<ref>" suffix match. Models sometimes remember only the name
	 * they chose, not the composed id — be forgiving on lookup (never on
	 * creation, where ambiguity would bite later).
	 */
	function resolveInstance(pool: InstancePool, ref: string): Instance | undefined {
		const exact = pool.get(ref);
		if (exact) return exact;
		const matches = pool.list().filter((i) => i.meta.id.endsWith(`-${ref}`));
		return matches.length === 1 ? matches[0] : undefined;
	}

	const decisionInstruction = (id: string) =>
		"\n\n---\nREQUIRED: before finishing your current run, call subagent_decide with " +
		`instance "${id}" and decision "keep" (retain it for follow-up exchanges) or "drop" (delete it). ` +
		"If you have not decided by the time your run ends, it is dropped automatically.";

	// Embed the agent list so the model sees its options without a discovery
	// round-trip. Registration-time snapshot: agents edited mid-session are
	// picked up on dispatch (discovery re-scans), subagent_list shows latest.
	const agentsSummary = discoverAgents().map((a) => `${a.name}: ${a.description}`).join("; ") || "none yet";

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a specialized subagent running as an isolated resident Pi process. " +
			"Start a new one with { agent, task }; continue an existing one with { instance, task }. " +
			`Available agents: ${agentsSummary}. ` +
			"Every dispatch is ASYNCHRONOUS: the call returns immediately, a light notification arrives when the " +
			"subagent completes, and you fetch the full result with subagent_check. " +
			"After reading a result you must call subagent_decide to keep or drop the instance.",
		promptSnippet: "delegate an isolated task to a specialized subagent process",
		promptGuidelines: [
			"After reading a subagent result via subagent_check, immediately call subagent_decide (keep or drop) for that instance.",
			"Pass the instance id to continue a kept subagent instead of starting a new one.",
			"Dispatches are asynchronous: do not idle-wait after dispatching; the completion notification will arrive.",
			"When a subagent is interrupted or ends without output (usually a provider failure), do NOT drop it immediately: resume it with a short wrap-up inquiry first — its accumulated work is usually still in context and harvestable.",
			"Name new instances meaningfully (snake_case via the name parameter), e.g. name: frontend_auth_investigation.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent name from a .md definition (required for a new instance)." })),
			task: Type.String({ description: "The task or follow-up instruction for the subagent." }),
			instance: Type.Optional(Type.String({ description: "Existing instance id to continue; omit to start fresh." })),
			name: Type.Optional(Type.String({
			description:
				"Custom name for a NEW instance (ignored when continuing via instance). The full id becomes \"<agent>-<name>\". " +
				"Pick a self-explanatory snake_case name describing the task, e.g. scout-frontend_auth_investigation. " +
				"Allowed: letters, digits, underscore, hyphen; max 64 chars; must be unique among living instances. " +
				"Omit for a random suffix.",
			})),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, context) {
			const currentPool = ensurePool(context);
			const task = params.task;
			let instance: Instance | undefined;
			let agentConfig: AgentConfig | undefined;

			if (params.instance) {
				// Continue an existing instance: resident process if kept, otherwise
				// respawn from the on-disk session (recovered leftovers).
				instance = resolveInstance(currentPool, params.instance);
				if (!instance) {
					throw new Error(`No subagent instance "${params.instance}" in this session. Use subagent_list to inspect.`);
				}
				if (instance.meta.status === "running") {
					throw new Error(`Subagent instance "${instance.meta.id}" is still running its previous task.`);
				}
				agentConfig = discoverAgents().find((a) => a.name === instance!.meta.agent);
				if (!instance.client || !instance.client.alive) {
					if (!agentConfig) throw new Error(`Agent definition "${instance.meta.agent}" no longer exists; cannot respawn.`);
					// Reserve synchronously BEFORE the async startup: pi executes tool
					// calls in parallel, and two continuations of one instance must not
					// both spawn children onto the same session directory.
					const previousStatus = instance.meta.status;
					instance.meta.status = "running";
					let client: RpcSubprocess;
					try {
						// All synchronous preparation lives inside the reservation: a
						// throw here must roll the status back, or the instance wedges
						// as "running" with no process behind it.
						fs.mkdirSync(instance.dir, { recursive: true });
						const spawnPlan = buildSpawn(agentConfig, instance, context.cwd, context.thinkingLevel ?? "off", context.model ? `${context.model.provider}/${context.model.id}` : undefined);
						instance.meta.model = spawnPlan.model;
						instance.meta.thinking = spawnPlan.thinking;
						client = new RpcSubprocess(context.cwd, spawnPlan.args, spawnPlan.env);
					} catch (error) {
						instance.meta.status = previousStatus;
						throw error;
					}
					const onStartAbort = () => client.kill();
					signal?.addEventListener("abort", onStartAbort, { once: true });
					// Attach BEFORE the async startup: a parallel decide(drop) during
					// the handshake kills via instance.client — without this it would
					// find nothing to kill and leave a ghost process behind.
					instance.client = client;
					try {
						await client.start();
					} catch (error) {
						if (currentPool.get(instance.meta.id) === instance) {
							instance.meta.status = previousStatus;
							currentPool.saveMeta(instance);
						}
						throw error;
					} finally {
						signal?.removeEventListener("abort", onStartAbort);
					}
					if (currentPool.get(instance.meta.id) !== instance) {
						client.killSync();
						throw new Error(`Subagent instance "${instance.meta.id}" was dropped while its process was starting up.`);
					}
				}
				instance.meta.task = task;
			} else {
				// New dispatch: requires a known agent definition.
				if (!params.agent) throw new Error("Parameter \"agent\" is required when starting a new subagent.");
				const agents = discoverAgents();
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => `${a.name}: ${a.description}`).join("\n") || "(none)";
					throw new Error(`Unknown agent "${params.agent}". Available agents:\n${available}`);
				}
				const id = composeInstanceId(agent.name, params.name, currentPool);
				const dir = instanceDir(context.sessionManager.getSessionId() || `pid-${process.pid}`, id);
				fs.mkdirSync(dir, { recursive: true });
				instance = {
					meta: {
						id,
						agent: agent.name,
						sessionId: randomUUID(),
						task,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						status: "running",
						// The structured-output contract survives definition edits: a warm
						// continuation of a kept process still faces the ORIGINAL child's
						// submit_result tool, even if the .md changed meanwhile.
						hasStructuredOutput: agent.output !== undefined,
					},
					dir,
					displayItems: [],
					usage: emptyUsage(),
					finalOutput: "",
				};
				currentPool.add(instance);
				currentPool.saveMeta(instance);
				agentConfig = agent;
				const spawnPlan = buildSpawn(agent, instance, context.cwd, context.thinkingLevel ?? "off", context.model ? `${context.model.provider}/${context.model.id}` : undefined);
				instance.meta.model = spawnPlan.model;
				instance.meta.thinking = spawnPlan.thinking;
				const client = new RpcSubprocess(context.cwd, spawnPlan.args, spawnPlan.env);
				// Attach BEFORE the async startup (same ghost-process reasoning as the
				// respawn branch above).
				instance.client = client;
				const onStartAbort = () => client.kill();
				signal?.addEventListener("abort", onStartAbort, { once: true });
				try {
					await client.start();
				} catch (error) {
					// Startup failure: keep the directory so the failure is inspectable,
					// mark it recovered, and surface the error. Skip the bookkeeping
					// entirely if a parallel drop already removed the instance.
					if (currentPool.get(instance.meta.id) === instance) {
						instance.meta.status = "recovered";
						currentPool.saveMeta(instance);
					}
					throw error;
				} finally {
					signal?.removeEventListener("abort", onStartAbort);
				}
				if (currentPool.get(instance.meta.id) !== instance) {
					client.killSync();
					throw new Error(`Subagent instance "${instance.meta.id}" was dropped while its process was starting up.`);
				}
			}

			instance.meta.status = "running";
			instance.displayItems = [];
			// Per-task reset: usage accumulates across the whole delivery (including
			// nudge rounds), and a previous task's mailbox contents must never leak
			// into this one (a freshly aborted run would otherwise "deliver" the
			// stale result of the task before it).
			instance.usage = emptyUsage();
			instance.finalOutput = "";
			instance.meta.lastError = undefined;
			instance.meta.unread = false;
			// Invalidate the persisted mailbox too: a restart between an abort and
			// the next delivery must never hydrate the PREVIOUS task's result.md
			// and present it as this task's deliverable.
			try {
				fs.rmSync(path.join(instance.dir, "result.md"), { force: true });
			} catch {
				// Best-effort; recovery degrades to "no result" instead.
			}
			currentPool.saveMeta(instance);

			// The structured-output contract comes from the DEFINITION on a cold
			// spawn, but from the SPAWN-TIME record on a warm continuation: the
			// resident child still has its original submit_result even if the .md
			// was edited or deleted meanwhile.
			const expectsOutput = agentConfig?.output !== undefined || instance.meta.hasStructuredOutput === true;

			// A kept instance may hold a previous run's submission; clear it so a
			// stale file is never mistaken for this run's deliverable.
			if (expectsOutput) {
				fs.rmSync(path.join(instance.dir, "output.json"), { force: true });
			}

			runInBackground(instance, expectsOutput, task, currentPool);
			return {
				content: [{
					type: "text" as const,
					text: `Subagent "${instance.meta.id}" is now running asynchronously. ` +
						"You will receive a light notification when it completes; fetch its result with subagent_check. " +
						"Do not idle-wait for it: continue with other work or end your turn. To interrupt it, call subagent_abort.",
				}],
				details: {
					instanceId: instance.meta.id,
					agent: instance.meta.agent,
					displayItems: instance.displayItems,
					finalOutput: "",
					usage: instance.usage,
				},
			};
		},

		renderCall: (args, theme) => renderSubagentCall(args as Record<string, unknown>, theme),
		renderResult: (result, { expanded }, theme) => renderSubagentResult(result, { expanded }, theme),
	});

	pi.registerTool({
		name: "subagent_decide",
		label: "Decide Subagent Fate",
		description:
			"decide what happens to a subagent instance after its result has been read via subagent_check: " +
			"\"keep\" retains the resident process and its context for follow-up exchanges; \"drop\" kills it and deletes its files. " +
			"Mandatory after every subagent_check of a finished instance; undecided instances are dropped automatically when the run ends.",
		promptSnippet: "keep or drop a delivered subagent instance",
		parameters: Type.Object({
			instance: Type.String({ description: "Instance id from the subagent tool result." }),
			decision: Type.Union([Type.Literal("keep"), Type.Literal("drop")], { description: "\"keep\" or \"drop\"." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const currentPool = ensurePool(context);
			const instance = resolveInstance(currentPool, params.instance);
			if (!instance) throw new Error(`No subagent instance "${params.instance}" in this session.`);

			if (params.decision === "drop") {
				currentPool.drop(instance.meta.id);
				return {
					content: [{ type: "text" as const, text: `Subagent instance "${instance.meta.id}" dropped and its files deleted.` }],
					details: { instanceId: instance.meta.id, decision: "drop" },
				};
			}

			instance.meta.status = "kept";
			currentPool.saveMeta(instance);
			return {
				content: [{
					type: "text" as const,
					text: `Subagent instance "${instance.meta.id}" kept resident. Continue it with subagent({ instance: "${instance.meta.id}", task }). ` +
						"After the next delivery you must decide again; it is dropped automatically if you do not.",
				}],
				details: { instanceId: instance.meta.id, decision: "keep" },
			};
		},
	});

	pi.registerTool({
		name: "subagent_abort",
		label: "Abort Subagent Run",
		description:
			"Interrupt a running subagent WITHOUT killing it: aborts its current task but keeps the process and " +
			"its full context alive, so you can then continue it with new instructions via subagent({ instance, task }) " +
			"or drop it via subagent_decide. Mainly for instances stuck in loops or heading the wrong way. " +
			"(Subagents are decoupled from the main agent: the user interrupting YOU with Esc never affects them — " +
			"this tool is the only way to interrupt one.)",
		promptSnippet: "interrupt a running subagent, keeping its process and context alive",
		parameters: Type.Object({
			instance: Type.String({ description: "Instance id of the running subagent to interrupt." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const currentPool = ensurePool(context);
			const instance = resolveInstance(currentPool, params.instance);
			if (!instance) throw new Error(`No subagent instance "${params.instance}" in this session.`);
			if (instance.meta.status !== "running" || !instance.client?.alive) {
				throw new Error(`Subagent instance "${instance.meta.id}" is not running (status: ${instance.meta.status}).`);
			}

			// Set the flag BEFORE aborting: the background completion handler may
			// fire as soon as the child's run ends, and it must skip the wake-up.
			instance.abortInitiated = true;
			// ONE deadline covers BOTH phases: the RPC abort itself can pend forever
			// (a child stuck in an abort-insensitive tool, or not answering RPC at
			// all — our send() has no timeout), and the run handler's retirement
			// (our own idle polling) may lag behind it. If either phase wedges, the
			// child is declared stuck: force-reap it SYNCHRONOUSLY (killSync — a
			// soft kill's grace window would let a respawn overlap the old process
			// on the same session directory), then degrade to a resumable leftover.
			let retireTimer: ReturnType<typeof setTimeout> | undefined;
			let retired = false;
			try {
				retired = await Promise.race([
					(async () => {
						await instance.client!.abort();
						await instance.runPromise?.catch(() => undefined);
						return true;
					})(),
					new Promise<false>((resolve) => {
						retireTimer = setTimeout(() => resolve(false), 15_000);
					}),
				]);
			} finally {
				// A referenced timer would keep a short-lived print-mode process
				// alive for the full 15s after the race already settled.
				if (retireTimer) clearTimeout(retireTimer);
			}
			if (!retired && instance.client.alive) {
				instance.client.killSync();
				await instance.runPromise?.catch(() => undefined);
			}
			// A parallel decide(drop) may have deleted the instance while we
			// awaited: never persist or report state for an unregistered instance
			// (saveMeta would resurrect the deleted directory).
			if (currentPool.get(instance.meta.id) !== instance) {
				return {
					content: [{ type: "text" as const, text: `Subagent "${instance.meta.id}" was dropped while the abort was in flight; nothing left to update.` }],
					details: { instanceId: instance.meta.id, aborted: true },
				};
			}
			if (!retired) {
				instance.meta.status = "recovered";
				instance.meta.lastError = "Aborted run wedged and the process was killed; resume it from disk via subagent({ instance, task }) or drop it.";
				currentPool.saveMeta(instance);
				return {
					content: [{
						type: "text" as const,
						text: `Subagent "${instance.meta.id}" did not stop cleanly within 15s and its process was killed. ` +
							`Its context is preserved. Do NOT drop it right away: resume it first with a short wrap-up inquiry, e.g. ` +
							`subagent({ instance: "${instance.meta.id}", task: "You were interrupted. Report what you accomplished so far, then submit your partial findings." }) ` +
							`— interrupted work is usually still in context and harvestable. Only drop it (subagent_decide) if the resume also fails.`,
					}],
					details: { instanceId: instance.meta.id, aborted: true, killed: true },
				};
			}
			instance.meta.lastError = "Run aborted by the main agent; no result was produced.";
			instance.meta.status = "awaiting_decision";
			currentPool.saveMeta(instance);

			return {
				content: [{
					type: "text" as const,
					text: `Subagent "${instance.meta.id}" aborted. Its process and context are intact. ` +
						`Continue it with subagent({ instance: "${instance.meta.id}", task }) or drop it with subagent_decide.` +
						decisionInstruction(instance.meta.id),
				}],
				details: { instanceId: instance.meta.id, aborted: true },
			};
		},
	});

	pi.registerTool({
		name: "subagent_check",
		label: "Check Subagent Result",
		description:
			"Fetch the result of a subagent instance and mark it as read. This is the ONLY way results are " +
			"delivered: completion notifications are light pings, the full output lives here. " +
			"Works for finished (awaiting decision), interrupted (recovered) and kept instances; for a still-running " +
			"instance it reports progress instead. After reading a finished result you MUST keep or drop it via subagent_decide.",
		promptSnippet: "fetch a subagent's result and mark it read",
		parameters: Type.Object({
			instance: Type.String({ description: "Instance id to check (exact id or the unique name suffix)." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const currentPool = ensurePool(context);
			const instance = resolveInstance(currentPool, params.instance);
			if (!instance) throw new Error(`No subagent instance "${params.instance}" in this session. Use subagent_list to inspect.`);

			if (instance.meta.status === "running") {
				return {
					content: [{
						type: "text" as const,
						text: `Subagent "${instance.meta.id}" is still running. You will be notified when it completes; there is no result to read yet.`,
					}],
					details: {
						instanceId: instance.meta.id,
						agent: instance.meta.agent,
						displayItems: instance.displayItems,
						finalOutput: "",
						usage: instance.usage,
						status: "running",
					},
				};
			}

			// Reading the result consumes the unread mark: the settle sweep may
			// reclaim this instance once the current run ends without a decision.
			instance.meta.unread = false;
			currentPool.saveMeta(instance);

			if (instance.meta.status === "recovered") {
				return {
					content: [{
						type: "text" as const,
						text: `Subagent "${instance.meta.id}" was interrupted and has no result.\n` +
							(instance.meta.lastError ? `Last error: ${instance.meta.lastError}\n` : "") +
							`Its context is preserved. Do NOT drop it right away: resume it first with a short wrap-up inquiry, e.g. ` +
							`subagent({ instance: "${instance.meta.id}", task: "You were interrupted. Report what you accomplished so far, then submit your partial findings." }) ` +
							`— interrupted work is usually still in context and harvestable. Only drop it (subagent_decide) if the resume also fails.`,
					}],
					details: {
						instanceId: instance.meta.id,
						agent: instance.meta.agent,
						displayItems: instance.displayItems,
						finalOutput: "",
						usage: instance.usage,
						status: "recovered",
						isError: true,
					},
					isError: true,
				};
			}

			const output = instance.finalOutput
				|| (instance.meta.lastError ? `No result was produced. ${instance.meta.lastError}` : "(subagent produced no text output)");
			return {
				content: [{ type: "text" as const, text: output + decisionInstruction(instance.meta.id) }],
				details: {
					instanceId: instance.meta.id,
					agent: instance.meta.agent,
					displayItems: instance.displayItems,
					finalOutput: output,
					usage: instance.usage,
				},
			};
		},

		renderCall: (args, theme) => renderSubagentCall(args as Record<string, unknown>, theme),
		renderResult: (result, { expanded }, theme) => renderSubagentResult(result, { expanded }, theme),
	});

	pi.registerTool({
		name: "subagent_list",
		label: "List Subagents",
		description:
			"List the subagent instances of the current session with their status " +
			"(running / awaiting decision / kept / recovered leftover), whether the process is alive, " +
			"and an UNREAD marker on results not yet fetched via subagent_check.",
		promptSnippet: "list the subagent instances of the current session",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, context) {
			const currentPool = ensurePool(context);
			const instances = currentPool.list();
			const lines = instances.length === 0
				? ["Instances: none"]
				: ["Instances:", ...instances.map((i) => {
						const live = i.client?.alive ? "resident" : "no process";
						const unread = i.meta.unread ? " UNREAD (call subagent_check)" : "";
						return `  ${i.meta.id} [${i.meta.status}, ${live}${unread}] agent=${i.meta.agent} task="${truncate(i.meta.task, 80)}"`;
					})];
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
		},
	});

	// ---- Session lifecycle: recovery scan, reminder injection, sweep, cleanup ----

	pi.on("session_start", (_event, context) => {
		ctx = context;
		poolSessionId = context.sessionManager.getSessionId() || `pid-${process.pid}`;
		pool = new InstancePool(poolSessionId);
		// Rebind the presence widget to the fresh pool.
		widget?.dispose();
		widget = installSubagentWidget(context, pool);
		const recovered = pool.recoverFromDisk();
		pendingReminder = recovered.length === 0
			? undefined
			: [
					"[MPEP subagent] This session has leftover subagent instances from an interrupted run:",
					...recovered.map((i) => `  - ${i.meta.id} (agent: ${i.meta.agent}) task: "${truncate(i.meta.task, 100)}"`),
					"Inspect them with subagent_list, then either resume one via subagent({ instance, task }) " +
						"or delete it via subagent_decide({ instance, decision: \"drop\" }). " +
						"Leftovers stay on disk until dropped.",
				].join("\n");
	});

	pi.on("before_agent_start", (event) => {
		if (!pendingReminder) return;
		const reminder = pendingReminder;
		pendingReminder = undefined;
		// Contract of the installed Pi (0.85.x): mutations of systemPromptOptions
		// are ignored; the system prompt changes only via the returned value.
		// (Newer Pi also honors the return contract, so this works on both.)
		return { systemPrompt: `${event.systemPrompt}\n\n${reminder}` };
	});

	// A new run means queued follow-up notifications have been consumed: from
	// now on the sweep may reclaim those instances if the model never decides.
	// (Unread results are spared by the sweep; see pool.sweepUndecided.)

	pi.on("agent_settled", () => {
		// Hard guarantee behind the mandatory keep/drop question. The sweep must
		// wait for the whole run (not turn_end): a delivery and its decide call
		// land in DIFFERENT turns of the same run, so sweeping at turn_end would
		// drop every instance before the model gets a chance to decide.
		pool?.sweepUndecided();
	});

	// Best-effort child reaping when the main process goes away. A force-kill of
	// the parent cannot be intercepted, but crash recovery covers that case.
	// Headless children CANNOT outlive the parent anyway: the RPC transport is
	// a parent-owned pipe, and 0.85.x treats stdin EOF as session shutdown.
	// So reaping is unconditional in every mode; print/json leftovers are
	// recovered from disk by the next session.
	const killAll = () => pool?.killAll();
	process.on("exit", killAll);
	// Signals: registering a plain listener would SWALLOW Ctrl+C (Node drops its
	// default termination once any listener exists). Reap, then re-raise so the
	// default behavior (or the host's own handler) still runs.
	const onSigint = () => {
		process.off("SIGINT", onSigint);
		killAll();
		process.kill(process.pid, "SIGINT");
	};
	const onSigterm = () => {
		process.off("SIGTERM", onSigterm);
		killAll();
		process.kill(process.pid, "SIGTERM");
	};
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	// TUI reload / session replacement invalidates this context right after; all
	// UI teardown must happen here while the context is still valid.
	pi.on("session_shutdown", () => {
		try {
			widget?.dispose();
		} catch {
			// UI teardown must never block process cleanup.
		}
		widget = undefined;
		killAll();
	});

	installations[SLOT] = () => {
		process.off("exit", killAll);
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		try {
			widget?.dispose();
		} catch {
			// The context may already be invalidated (reload ordering).
		} finally {
			widget = undefined;
			killAll();
			pool = undefined;
			ctx = undefined;
		}
		if (installations[SLOT] !== undefined) delete installations[SLOT];
	};
}
