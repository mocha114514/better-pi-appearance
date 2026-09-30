/**
 * Subagent plugin: delegate tasks to specialized agents running as resident
 * `pi --mode rpc` subprocesses with isolated context windows.
 *
 * Layout (see paths.ts):
 *   mpep-cache/subagent/agents/             agent definitions (.md)
 *   mpep-cache/subagent/sessions/<main>/<instance>/   session files + metadata
 *
 * Lifecycle contract with the main agent:
 *   - every delivery is followed by a mandatory keep/drop decision via
 *     subagent_decide; undecided instances are swept (dropped) at turn end;
 *   - "keep" retains the resident process and its on-disk session for exactly
 *     one follow-up; the question is asked again after the next delivery;
 *   - anything left on disk by an interrupted run is recovered at session
 *     start and reported to the main agent, which must resume or drop it.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isPluginEnabled } from "../manager/preferences.ts";
import { discoverAgents, seedTemplateIfEmpty, type AgentConfig } from "./agents.ts";
import { RpcSubprocess } from "./client.ts";
import { emptyUsage, InstancePool, type Instance } from "./pool.ts";
import { ensureSubagentDirs, instanceDir } from "./paths.ts";
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
	seedTemplateIfEmpty();

	let ctx: ExtensionContext | undefined;
	let pool: InstancePool | undefined;
	let pendingReminder: string | undefined;

	/** The pool is keyed by main session; rebuild it whenever the session changes. */
	function ensurePool(context: ExtensionContext): InstancePool {
		const sessionId = context.sessionManager.getSessionId() || `pid-${process.pid}`;
		if (!pool || context !== ctx) {
			ctx = context;
			pool = new InstancePool(sessionId);
		}
		return pool;
	}

	function buildSpawnArgs(agent: AgentConfig, instance: Instance, cwd: string, inheritThinking: string): string[] {
		const args = [
			"--mode", "rpc",
			"--no-extensions", // no plugin discovery: prevents recursive subagent loading
			"--session-dir", instance.dir,
			"--session-id", instance.meta.sessionId,
		];
		if (agent.model) args.push("--model", agent.model);
		args.push("--thinking", agent.thinking ?? inheritThinking);
		if (agent.tools) args.push("--tools", agent.tools.join(","));
		if (agent.excludeTools) args.push("--exclude-tools", agent.excludeTools.join(","));
		for (const extension of agent.extensions) {
			args.push("--extension", path.resolve(cwd, extension));
		}
		if (agent.systemPrompt.trim()) {
			const promptFile = path.join(instance.dir, "prompt.md");
			fs.writeFileSync(promptFile, agent.systemPrompt, "utf-8");
			args.push("--append-system-prompt", promptFile);
		}
		return args;
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

		return new Promise<RunOutcome>((resolve, reject) => {
			let currentTextItem = "";
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
				} else if (event.type === "agent_end") {
					cleanup();
					const messages = event.messages;
					instance.usage = aggregateUsage(messages);
					resolve({ finalOutput: extractFinalText(messages), messages });
				}
			});

			const offExit = (code: number | null) => {
				cleanup();
				reject(new Error(`subagent process exited mid-run (code ${code}). ${client.stderrText()}`.trim()));
			};
			client.onExit(offExit);

			const onAbort = () => {
				cleanup();
				void client.abort();
				client.kill();
				reject(new Error("aborted by user"));
			};
			const cleanup = () => {
				offEvent();
				signal?.removeEventListener("abort", onAbort);
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			client.prompt(task).catch((error: unknown) => {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	const DECISION_INSTRUCTION =
		"\n\n---\nREQUIRED: before finishing your turn, call subagent_decide with this instance id and " +
		"decision \"keep\" (retain it for exactly one follow-up exchange) or \"drop\" (delete it). " +
		"If you do not decide, it is dropped automatically at turn end.";

	function resultFor(instance: Instance, output: string, isError = false) {
		return {
			content: [{ type: "text" as const, text: output + (isError ? "" : DECISION_INSTRUCTION) }],
			details: {
				instanceId: instance.meta.id,
				agent: instance.meta.agent,
				displayItems: instance.displayItems,
				finalOutput: output,
				usage: instance.usage,
				isError,
			},
			isError,
		};
	}

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
			"After EVERY delivery you must call subagent_decide to keep or drop the instance.",
		promptSnippet: "delegate an isolated task to a specialized subagent process",
		promptGuidelines: [
			"After each subagent delivery, immediately call subagent_decide (keep or drop) for that instance.",
			"Pass the instance id to continue a kept subagent instead of starting a new one.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent name from a .md definition (required for a new instance)." })),
			task: Type.String({ description: "The task or follow-up instruction for the subagent." }),
			instance: Type.Optional(Type.String({ description: "Existing instance id to continue; omit to start fresh." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, context) {
			const currentPool = ensurePool(context);
			const task = params.task;
			let instance: Instance | undefined;

			if (params.instance) {
				// Continue an existing instance: resident process if kept, otherwise
				// respawn from the on-disk session (recovered leftovers).
				instance = currentPool.get(params.instance);
				if (!instance) {
					throw new Error(`No subagent instance "${params.instance}" in this session. Use subagent_list to inspect.`);
				}
				if (instance.meta.status === "running") {
					throw new Error(`Subagent instance "${instance.meta.id}" is still running its previous task.`);
				}
				const agent = discoverAgents().find((a) => a.name === instance!.meta.agent);
				if (!instance.client || !instance.client.alive) {
					if (!agent) throw new Error(`Agent definition "${instance.meta.agent}" no longer exists; cannot respawn.`);
					fs.mkdirSync(instance.dir, { recursive: true });
					const client = new RpcSubprocess(context.cwd, buildSpawnArgs(agent, instance, context.cwd, context.thinkingLevel ?? "off"));
					await client.start();
					instance.client = client;
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
				const id = `${agent.name}-${randomUUID().slice(0, 8)}`;
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
					},
					dir,
					displayItems: [],
					usage: emptyUsage(),
					finalOutput: "",
				};
				currentPool.add(instance);
				currentPool.saveMeta(instance);
				const client = new RpcSubprocess(context.cwd, buildSpawnArgs(agent, instance, context.cwd, context.thinkingLevel ?? "off"));
				try {
					await client.start();
				} catch (error) {
					// Startup failure: keep the directory so the failure is inspectable,
					// mark it recovered, and surface the error.
					instance.meta.status = "recovered";
					currentPool.saveMeta(instance);
					throw error;
				}
				instance.client = client;
			}

			instance.meta.status = "running";
			instance.displayItems = [];
			currentPool.saveMeta(instance);

			try {
				const outcome = await runPrompt(instance, task, signal ?? undefined, onUpdate);
				instance.finalOutput = outcome.finalOutput;
				instance.meta.status = "awaiting_decision";
				currentPool.saveMeta(instance);
				return resultFor(instance, outcome.finalOutput || "(subagent produced no text output)");
			} catch (error) {
				// Aborted or crashed mid-run: the session file stays on disk and the
				// instance becomes a leftover the main agent can resume or drop.
				instance.meta.status = "recovered";
				currentPool.saveMeta(instance);
				const message = error instanceof Error ? error.message : String(error);
				return resultFor(instance, `Subagent "${instance.meta.id}" was interrupted: ${message}\nIts context is preserved on disk; resume it later with subagent({ instance: "${instance.meta.id}", task }) or drop it with subagent_decide.`, true);
			}
		},

		renderCall: (args, theme) => renderSubagentCall(args as Record<string, unknown>, theme),
		renderResult: (result, { expanded }, theme) => renderSubagentResult(result, { expanded }, theme),
	});

	pi.registerTool({
		name: "subagent_decide",
		label: "Decide Subagent Fate",
		description:
			"Decide what happens to a subagent instance after a delivery: \"keep\" retains the resident process and " +
			"its context for exactly one follow-up exchange; \"drop\" kills it and deletes its files. " +
			"Mandatory after every subagent delivery; undecided instances are dropped automatically at turn end.",
		promptSnippet: "keep or drop a delivered subagent instance",
		parameters: Type.Object({
			instance: Type.String({ description: "Instance id from the subagent tool result." }),
			decision: Type.Union([Type.Literal("keep"), Type.Literal("drop")], { description: "\"keep\" or \"drop\"." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const currentPool = ensurePool(context);
			const instance = currentPool.get(params.instance);
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
		name: "subagent_list",
		label: "List Subagents",
		description:
			"List the subagent instances of the current session with their status " +
			"(running / awaiting decision / kept / recovered leftover) and whether the process is alive.",
		promptSnippet: "list the subagent instances of the current session",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, context) {
			const currentPool = ensurePool(context);
			const instances = currentPool.list();
			const lines = instances.length === 0
				? ["Instances: none"]
				: ["Instances:", ...instances.map((i) => {
						const live = i.client?.alive ? "resident" : "no process";
						return `  ${i.meta.id} [${i.meta.status}, ${live}] agent=${i.meta.agent} task="${truncate(i.meta.task, 80)}"`;
					})];
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
		},
	});

	// ---- Session lifecycle: recovery scan, reminder injection, sweep, cleanup ----

	pi.on("session_start", (_event, context) => {
		ctx = context;
		pool = new InstancePool(context.sessionManager.getSessionId() || `pid-${process.pid}`);
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
		event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ""}\n\n${reminder}`;
	});

	pi.on("turn_end", () => {
		// Hard guarantee behind the mandatory keep/drop question: an undecided
		// instance is disposable by definition, so sweep it.
		pool?.sweepUndecided();
	});

	// Best-effort child reaping when the main process goes away. A force-kill of
	// the parent cannot be intercepted, but crash recovery covers that case.
	const killAll = () => pool?.killAll();
	process.on("exit", killAll);
	process.on("SIGINT", killAll);
	process.on("SIGTERM", killAll);

	installations[SLOT] = () => {
		process.off("exit", killAll);
		process.off("SIGINT", killAll);
		process.off("SIGTERM", killAll);
		pool?.killAll();
		pool = undefined;
		ctx = undefined;
		if (installations[SLOT] !== undefined) delete installations[SLOT];
	};
}
