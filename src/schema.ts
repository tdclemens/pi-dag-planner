/**
 * The canonical JSON Schema for a DagPlan, plus automatic validation
 * (ajv). `validatePlan` (src/dag.ts) runs every plan through this schema
 * before it is saved or executed, so malformed LLM output is rejected with
 * a diagnostic instead of reaching the scheduler.
 *
 * The schema covers the data shape (types, id pattern, required fields,
 * no unknown properties). Graph-level rules the schema cannot express —
 * duplicate ids, unknown deps, self-deps, cycles — are checked right after
 * the schema check in dag.ts.
 */

import { Ajv2020, type ErrorObject, type SchemaObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { PlanValidation } from "./types.ts";

/** Allowed step id: short, unique-friendly, safe for prompts and file names. */
export const DAG_PLAN_ID_PATTERN = "^[a-zA-Z0-9_-]{1,64}$";

/** At least one non-whitespace character (matches the old `.trim()` checks). */
const NON_BLANK = "^\\s*\\S";

/**
 * JSON Schema (draft 2020-12) for a DagPlan. This is the output contract of
 * the planner and the input contract of the executor — the single source of
 * truth for what a plan looks like.
 */
export const DAG_PLAN_SCHEMA: SchemaObject = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://earendil-works.dev/pi-dag-plan/plan.schema.json",
	title: "DagPlan",
	description: "A DAG of subagent steps produced by /dag-plan.",
	type: "object",
	required: ["goal", "steps"],
	additionalProperties: false,
	properties: {
		goal: {
			type: "string",
			pattern: NON_BLANK,
			description: "One-sentence restatement of the user's goal.",
		},
		steps: {
			type: "array",
			minItems: 1,
			description: "Step definitions; dependsOn edges must form a DAG (checked in dag.ts).",
			items: {
				type: "object",
				required: ["id", "title", "prompt", "dependsOn"],
				additionalProperties: false,
				properties: {
					id: { type: "string", pattern: DAG_PLAN_ID_PATTERN },
					title: { type: "string", pattern: NON_BLANK },
					prompt: { type: "string", pattern: NON_BLANK },
					dependsOn: {
						type: "array",
						uniqueItems: true,
						items: { type: "string", pattern: NON_BLANK },
						description: "ids of prerequisite steps; [] = can start immediately.",
					},
					tools: {
						type: "array",
						uniqueItems: true,
						items: { type: "string", pattern: NON_BLANK },
						description: "Optional per-step tool allowlist for the subagent.",
					},
					touches: {
						type: "array",
						uniqueItems: true,
						items: { type: "string", pattern: NON_BLANK },
						description:
							"Files (relative to the repo root) and named shared resources this step creates or modifies (e.g. \"package-lock.json\", \"ports:3000\"). Steps whose touches overlap are serialized by the executor; parallel steps must have disjoint touches.",
					},
				},
			},
		},
	},
};

let validator: ValidateFunction | undefined;

/** Lazily compile the schema once (the Ajv instance is a cheap singleton). */
function getValidator(): ValidateFunction {
	if (!validator) {
		const ajv = new Ajv2020({ allErrors: true, verbose: true });
		validator = ajv.compile(DAG_PLAN_SCHEMA);
	}
	return validator;
}

/**
 * Validate an unknown value (untrusted LLM output) against DAG_PLAN_SCHEMA.
 * Returns the first violation as a readable diagnostic; never throws.
 */
export function validatePlanSchema(plan: unknown): PlanValidation {
	const validate = getValidator();
	if (validate(plan)) return { ok: true };
	return { ok: false, error: formatSchemaError(validate.errors) };
}

/** "/steps/1/id" → "steps[1].id"; "" → "plan" */
function pathLabel(instancePath: string): string {
	if (!instancePath) return "plan";
	return instancePath
		.replace(/^\//, "")
		.split("/")
		.map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`))
		.join("")
		.replace(/^\./, "");
}

/** Turn the first ajv ErrorObject into a message in the style of the old hand-rolled checks. */
function formatSchemaError(errors: ErrorObject[] | null | undefined): string {
	if (!errors || errors.length === 0) return "plan does not match the DAG plan schema";
	const e = errors[0]!;
	const path = pathLabel(e.instancePath);
	switch (e.keyword) {
		case "required": {
			const missing = (e.params as { missingProperty?: string }).missingProperty ?? "?";
			return `${path}.${missing} is required`;
		}
		case "type": {
			const t = (e.params as { type?: string }).type ?? "valid value";
			const article = /^[aeiou]/i.test(t) ? "an" : "a";
			return `${path} must be ${article} ${t}`;
		}
		case "minLength":
		case "pattern": {
			if (e.instancePath.endsWith("/id")) {
				const value = typeof e.data === "string" ? ` "${e.data}"` : "";
				return `${path}${value} must match ${DAG_PLAN_ID_PATTERN} (1-64 chars)`;
			}
			return `${path} must be a non-blank string`;
		}
		case "minItems":
			return path === "steps" ? "steps must be a non-empty array" : `${path} must have at least 1 item`;
		case "uniqueItems":
			return `${path} must not contain duplicates`;
		case "additionalProperties": {
			const extra = (e.params as { additionalProperty?: string }).additionalProperty ?? "?";
			return `${path} has an unknown property "${extra}"`;
		}
		default:
			return `${path} ${e.message ?? "does not match the schema"}`;
	}
}
