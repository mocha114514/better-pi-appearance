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
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isPluginEnabled } from "../manager/preferences.ts";
import { discoverAgents, seedPresets, type AgentConfig } from "./agents.ts";
import { RpcSubprocess } from "./client.ts";
import { emptyUsage, InstancePool, type Instance } from "./pool.ts";
import { ensureSubagentDirs, instanceDir } from "./paths.ts";
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
			// The structured-output channel must survive the allowlist: --tools
			// applies to extension tools too, so submit_result has to be in it.
			const tools = agent.output && !agent.tools.includes("submit_result")
				? [...agent.tools, "submit_result"]
				: agent.tools;
			args.push("--tools", tools.join(","));
		}
		if (agent.excludeTools) {
			args.push("--exclude-tools", agent.excludeTools.filter((t) => t !== "submit_result").join(","));
		}
		for (const extension of agent.extensions) {
			args.push("--extension", path.resolve(cwd, extension));
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
		"\n\n---\nREQUIRED: before finishing your current run, call subagent_decide with this instance id and " +
		"decision \"keep\" (retain it for follow-up exchanges) or \"drop\" (delete it). " +
		"If you have not decided by the time your run ends, it is dropped automatically.";

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
			let agentConfig: AgentConfig | undefined;

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
				agentConfig = discoverAgents().find((a) => a.name === instance!.meta.agent);
				if (!instance.client || !instance.client.alive) {
					if (!agentConfig) throw new Error(`Agent definition "${instance.meta.agent}" no longer exists; cannot respawn.`);
					fs.mkdirSync(instance.dir, { recursive: true });
					const spawnPlan = buildSpawn(agentConfig, instance, context.cwd, context.thinkingLevel ?? "off", context.model ? `${context.model.provider}/${context.model.id}` : undefined);
					instance.meta.model = spawnPlan.model;
					instance.meta.thinking = spawnPlan.thinking;
					const client = new RpcSubprocess(context.cwd, spawnPlan.args, spawnPlan.env);
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
				agentConfig = agent;
				const spawnPlan = buildSpawn(agent, instance, context.cwd, context.thinkingLevel ?? "off", context.model ? `${context.model.provider}/${context.model.id}` : undefined);
				instance.meta.model = spawnPlan.model;
				instance.meta.thinking = spawnPlan.thinking;
				const client = new RpcSubprocess(context.cwd, spawnPlan.args, spawnPlan.env);
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

			// A kept instance may hold a previous run's submission; clear it so a
			// stale file is never mistaken for this run's deliverable.
			if (agentConfig?.output) {
				fs.rmSync(path.join(instance.dir, "output.json"), { force: true });
			}

			try {
				const outcome = await runPrompt(instance, task, signal ?? undefined, onUpdate);
				let output = outcome.finalOutput;

				if (agentConfig?.output) {
					let submitted = readSubmittedOutput(instance);
					if (submitted === undefined) {
						// The child ended without submit_result: one explicit reminder
						// round-trip, then fall back to its raw text.
						await runPrompt(
							instance,
							"You finished without calling submit_result. Call submit_result exactly once now, with the required fields.",
							signal ?? undefined,
							onUpdate,
						);
						submitted = readSubmittedOutput(instance);
					}
					if (submitted !== undefined) {
						output = JSON.stringify(submitted, null, 2);
					} else if (output.trim()) {
						output = `${output}\n\n(note: the subagent did not submit the structured result; above is its raw text output)`;
					}
				}

				instance.finalOutput = output;
				instance.meta.status = "awaiting_decision";
				currentPool.saveMeta(instance);
				return resultFor(instance, output || "(subagent produced no text output)");
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
			"decide what happens to a subagent instance after a delivery: \"keep\" retains the resident process and " +
			"its context for follow-up exchanges; \"drop\" kills it and deletes its files. " +
			"Mandatory after every subagent delivery; undecided instances are dropped automatically when the run ends.",
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
		event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ""}\n\n${reminder}`;
	});

	pi.on("agent_settled", () => {
		// Hard guarantee behind the mandatory keep/drop question. The sweep must
		// wait for the whole run (not turn_end): a delivery and its decide call
		// land in DIFFERENT turns of the same run, so sweeping at turn_end would
		// drop every instance before the model gets a chance to decide.
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
		widget?.dispose();
		widget = undefined;
		pool?.killAll();
		pool = undefined;
		ctx = undefined;
		if (installations[SLOT] !== undefined) delete installations[SLOT];
	};
}
