/**
 * Planner: LLM call (qna.ts pattern), robust JSON extraction, and plan
 * validation. `extractPlanJson` is pure and unit-testable.
 */

import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { validatePlan } from "./dag.ts";
import type { DagNode, DagPlan, PlannerResult, UsageStats } from "./types.ts";
import { emptyUsage } from "./types.ts";

export const PLANNER_SYSTEM_PROMPT = `You are a DAG planner. Decompose the user's request into 3-8 independent, verifiable steps that can be executed by isolated coding subagents.

Maximize parallelism: only add a "dependsOn" edge when a step genuinely needs another step's output. Each "prompt" must be self-contained — subagents share NO conversation context: state the goal, the concrete task, relevant file paths and commands, expected artifacts, and how to report results.

Respond with ONLY a JSON object — no prose, no markdown fences — matching exactly:
{
  "goal": "One-sentence restatement of the user's goal",
  "steps": [
    {
      "id": "s1",
      "title": "Short human label for this step",
      "prompt": "Self-contained task instructions for the subagent executing this step…",
      "dependsOn": [],
      "tools": ["read", "grep", "find", "ls"]
    }
  ]
}

Rules:
- 3-8 steps. ids are unique, short, kebab-case (s1, s2, … or analyze-repo).
- "dependsOn" lists ids of prerequisite steps. [] means the step can start immediately. Never reference unknown ids, and never create cycles.
- "tools" is optional. Include it only to restrict a step to a small tool set (e.g. ["read","grep","find","ls"] for research steps, ["read","edit","write","bash"] for implementation steps). Omit it to give the subagent the default tool set.
- The last step(s) should verify the work (run tests, build, or report findings).`;

export interface ExtractedPlan {
	plan: DagPlan;
	/** The plan as normalized JSON (source of truth for the saved markdown). */
	json: string;
}

/**
 * Extract a plan object from raw LLM output. Tries, in order: whole text,
 * ```fenced block, first-{ to last-} substring, and a trailing-comma-stripped
 * variant of each. First candidate that parses AND normalizes to a valid plan
 * shape wins. Throws with a diagnostic otherwise.
 */
export function extractPlanJson(text: string): ExtractedPlan {
	const raw: string[] = [text.trim()];
	const fence = text.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
	if (fence?.[1]) raw.push(fence[1].trim());
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) raw.push(text.slice(first, last + 1));

	const candidates: string[] = [];
	for (const c of raw) {
		if (!c) continue;
		candidates.push(c);
		candidates.push(c.replace(/,\s*([}\]])/g, "$1"));
	}

	let lastError = "no JSON object found in output";
	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch (e) {
			lastError = (e as Error).message;
			continue;
		}
		const plan = normalizePlan(parsed);
		if (plan) return { plan, json: JSON.stringify(plan, null, 2) };
	}
	throw new Error(`planner output is not a valid plan JSON (${lastError})`);
}

/** Coerce a parsed JSON value into a DagPlan shape, or null if not plan-shaped. */
export function normalizePlan(value: unknown): DagPlan | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.goal !== "string" || !v.goal.trim()) return null;
	if (!Array.isArray(v.steps) || v.steps.length === 0) return null;

	const steps: DagNode[] = [];
	for (const raw of v.steps) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const s = raw as Record<string, unknown>;
		if (typeof s.prompt !== "string" || !s.prompt.trim()) return null;
		const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : `s${steps.length + 1}`;
		const title =
			typeof s.title === "string" && s.title.trim() ? s.title.trim() : (s.prompt.split("\n")[0] ?? "").slice(0, 60) || id;
		const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === "string") : [];
		const tools = Array.isArray(s.tools) ? s.tools.filter((t): t is string => typeof t === "string") : undefined;
		steps.push({ id, title, prompt: s.prompt, dependsOn, ...(tools && tools.length > 0 ? { tools } : {}) });
	}
	return { goal: v.goal.trim(), steps };
}

export const PLANNER_MAX_ATTEMPTS = 2;

export interface PlanOptions {
	/** User feedback (refine) or prior validation error (retry). */
	feedback?: string;
	/** The prior plan JSON, when re-planning after refine. */
	priorPlanJson?: string;
}

/**
 * Call the active model to produce a plan. Returns null when aborted (Esc),
 * throws with a diagnostic otherwise (LLM error, bad JSON, invalid plan).
 */
export async function plan(
	ctx: ExtensionCommandContext,
	prompt: string,
	opts: PlanOptions = {},
	signal?: AbortSignal,
): Promise<PlannerResult | null> {
	const model = ctx.model;
	if (!model) throw new Error("no model selected (use /model)");

	const parts: string[] = [`Plan this task:\n\n${prompt}`];
	if (opts.priorPlanJson) parts.push(`A previous plan:\n\n${opts.priorPlanJson}`);
	if (opts.feedback)
		parts.push(
			`Address this feedback / error from the previous attempt:\n\n${opts.feedback}\n\nRespond again with ONLY the revised JSON plan.`,
		);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: parts.join("\n\n") }],
		timestamp: Date.now(),
	};

	const response = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: PLANNER_SYSTEM_PROMPT, messages: [userMessage] },
		{ signal },
	);

	if (response.stopReason === "aborted") return null;
	if (response.stopReason === "error") throw new Error(response.errorMessage ?? "planner model call failed");

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	const { plan: planObj, json } = extractPlanJson(text);
	const validation = validatePlan(planObj);
	if (!validation.ok) throw new Error(`invalid plan: ${validation.error}`);

	return { plan: planObj, rawJson: json, usage: toUsageStats(response.usage) };
}

function toUsageStats(usage: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
} | undefined): UsageStats {
	const u = emptyUsage();
	if (!usage) return u;
	u.input = usage.input ?? 0;
	u.output = usage.output ?? 0;
	u.cacheRead = usage.cacheRead ?? 0;
	u.cacheWrite = usage.cacheWrite ?? 0;
	u.cost = usage.cost?.total ?? 0;
	u.contextTokens = usage.totalTokens ?? 0;
	u.turns = 1;
	return u;
}
