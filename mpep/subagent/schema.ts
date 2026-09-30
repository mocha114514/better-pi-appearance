/**
 * Structured-output schema support.
 *
 * Agent .md files may declare an `output:` frontmatter field using a compact
 * YAML schema (same shape as oh-my-pi's agent definitions):
 *
 *   output:
 *     properties:                       # required fields
 *       summary: { type: string }
 *     optionalProperties:               # optional fields
 *       findings:
 *         elements:                     # array item type
 *           properties: { ... }
 *       confidence: { type: number }
 *     # field metadata: { metadata: { description: "..." } }
 *     # constrained values: { enum: [correct, incorrect] }
 *
 * The node tree is translated to TypeBox twice over: once to build the
 * child-side submit_result tool's parameter schema (provider-enforced at
 * tool-call time) and once to validate the submitted payload.
 */

import { Type, type TSchema } from "typebox";

export interface OutputSchemaNode {
	type?: string;
	enum?: unknown[];
	elements?: OutputSchemaNode;
	properties?: Record<string, OutputSchemaNode>;
	optionalProperties?: Record<string, OutputSchemaNode>;
	metadata?: { description?: string };
}

/** Shallow sanity check: a usable schema is an object with at least one property. */
export function isOutputSchema(value: unknown): value is OutputSchemaNode {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const props = (value as OutputSchemaNode).properties;
	return props !== undefined && typeof props === "object" && props !== null && !Array.isArray(props);
}

export function toTypeBox(node: OutputSchemaNode): TSchema {
	const options = node.metadata?.description ? { description: node.metadata.description } : {};

	if (Array.isArray(node.enum) && node.enum.length > 0) {
		const literals = node.enum.map((v) => Type.Literal(v as string | number | boolean));
		return literals.length === 1 ? literals[0] : Type.Union(literals, options);
	}
	if (node.properties || node.optionalProperties) {
		const shape: Record<string, TSchema> = {};
		for (const [key, child] of Object.entries(node.properties ?? {})) {
			shape[key] = toTypeBox(child);
		}
		for (const [key, child] of Object.entries(node.optionalProperties ?? {})) {
			shape[key] = Type.Optional(toTypeBox(child));
		}
		return Type.Object(shape, options);
	}
	if (node.elements) return Type.Array(toTypeBox(node.elements), options);

	switch (node.type) {
		case "number":
			return Type.Number(options);
		case "boolean":
			return Type.Boolean(options);
		case "string":
		default:
			return Type.String(options);
	}
}

/** Human-readable field listing, injected into the child's system prompt. */
export function describeSchema(node: OutputSchemaNode, indent = ""): string {
	const lines: string[] = [];
	const render = (name: string, child: OutputSchemaNode, required: boolean) => {
		const type = child.enum
			? `one of [${child.enum.map(String).join(", ")}]`
			: child.elements
				? "array"
				: child.properties || child.optionalProperties
					? "object"
					: (child.type ?? "string");
		const desc = child.metadata?.description ? ` — ${child.metadata.description}` : "";
		lines.push(`${indent}- ${name} (${type}${required ? ", required" : ", optional"})${desc}`);
		if (child.properties || child.optionalProperties) lines.push(describeSchema(child, `${indent}  `));
		if (child.elements) lines.push(describeSchema({ properties: { item: child.elements } }, `${indent}  `));
	};
	for (const [key, child] of Object.entries(node.properties ?? {})) render(key, child, true);
	for (const [key, child] of Object.entries(node.optionalProperties ?? {})) render(key, child, false);
	return lines.join("\n");
}
