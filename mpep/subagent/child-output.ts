/**
 * Child-side companion extension for structured subagent output.
 *
 * This file is loaded INTO THE SUBAGENT PROCESS via `-e <this file>` (the
 * parent adds it to the spawn arguments whenever the agent definition
 * declares an `output:` schema). It registers a `submit_result` tool whose
 * parameter schema IS the declared output schema, so the deliverable is
 * produced as a validated tool call instead of free-form text.
 *
 * Configuration arrives through environment variables set by the parent:
 *   MPEP_SUBAGENT_SCHEMA   JSON-encoded OutputSchemaNode tree
 *   MPEP_SUBAGENT_OUTPUT   absolute path of the output.json to write
 *
 * Without both variables this extension registers nothing and stays inert,
 * so accidentally loading it elsewhere is harmless.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { isOutputSchema, toTypeBox } from "./schema.ts";

export default function (pi: ExtensionAPI): void {
	const schemaJson = process.env.MPEP_SUBAGENT_SCHEMA;
	const outputPath = process.env.MPEP_SUBAGENT_OUTPUT;
	if (!schemaJson || !outputPath) return;

	let schema: TSchema;
	try {
		const node: unknown = JSON.parse(schemaJson);
		if (!isOutputSchema(node)) return;
		schema = toTypeBox(node);
	} catch {
		return; // A broken schema must not break the subagent entirely.
	}
	const validator = Compile(schema);

	pi.registerTool({
		name: "submit_result",
		label: "Submit Result",
		description:
			"Submit your final deliverable. Call this exactly once when the task is complete; " +
			"the fields of this tool are the required output format.",
		parameters: schema,
		async execute(_toolCallId, params) {
			// The provider already generated arguments under the schema, but
			// enforcement is best-effort across providers — revalidate here and
			// bounce invalid payloads back so the model can fix and resubmit.
			if (!validator.Check(params)) {
				const problems = [...validator.Errors(params)]
					.slice(0, 5)
					.map((e) => `${e.instancePath || "/"}: ${e.message}`)
					.join("; ");
				// Throw, don't return isError: pi 0.85.x does not consume a result's
				// isError field — a returned failure would be recorded as a
				// SUCCESSFUL submit_result and the model would stop. A thrown error
				// reaches the real error channel so the model fixes and resubmits.
				throw new Error(`submit_result validation failed: ${problems}. Fix the fields and call submit_result again.`);
			}
			try {
				fs.mkdirSync(path.dirname(outputPath), { recursive: true });
				fs.writeFileSync(outputPath, `${JSON.stringify(params, null, 2)}\n`, "utf-8");
			} catch (error) {
				throw new Error(`Failed to record the result: ${error instanceof Error ? error.message : String(error)}. Call submit_result again.`);
			}
			return {
				content: [{ type: "text" as const, text: "Result submitted. The task is complete; stop now." }],
				details: {},
			};
		},
	});
}
