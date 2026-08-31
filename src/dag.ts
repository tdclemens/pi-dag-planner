/**
 * Pure DAG utilities: validation (JSON schema + graph rules: cycles, missing
 * deps), Kahn topological levels, dependents index. No runtime pi imports —
 * unit-testable on its own (the DagPlanConfig import is type-only).
 */

import { validatePlanSchema } from "./schema.ts";
import type { DagPlanConfig } from "./config.ts";
import type { DagNode, DagPlan, PlanValidation } from "./types.ts";

export type { PlanValidation };

/** Recommended (soft) step count: planner guidance + plan-card warning. */
export const DEFAULT_MAX_STEPS = 12;

/**
 * Hard step-count ceiling enforced by validatePlan: a runaway plan that
 * slipped past the prompt guidance is rejected (the planner re-plans with
 * the error as feedback) instead of executing dozens of agent sessions.
 */
export const HARD_MAX_STEPS = 32;

/** Soft step count from config "maxSteps" (defaults to DEFAULT_MAX_STEPS). */
export function getMaxSteps(config?: DagPlanConfig): number {
	const n = config?.maxSteps;
	if (typeof n === "number" && Number.isInteger(n) && n >= 1) return n;
	return DEFAULT_MAX_STEPS;
}

/** Hard ceiling: the configured soft cap may raise it, but never lower it. */
export function getHardMaxSteps(config?: DagPlanConfig): number {
	return Math.max(HARD_MAX_STEPS, getMaxSteps(config));
}

/**
 * Validate a plan: first the canonical JSON schema (src/schema.ts — types,
 * required fields, id pattern, no unknown properties), then the graph rules
 * the schema cannot express: unique ids, known deps, no self-deps, acyclic.
 * `plan` may be unknown (from untrusted LLM output) — this returns a
 * structured error instead of throwing. Rejects plans with cycles, so no
 * cyclic plan can ever reach the scheduler. Also rejects plans above the
 * hard step ceiling (getHardMaxSteps) — the prompt guidance is soft, the
 * ceiling is not.
 *
 * Non-fatal: unordered `touches` overlap (two steps may modify the same
 * file without a dependency between them) does NOT reject the plan — the
 * executor serializes those steps at run time — but it is reported as a
 * warning so the user sees the implied loss of parallelism before
 * approving. Likewise, exceeding the soft step cap (getMaxSteps) is a
 * warning, not a rejection.
 */
export function validatePlan(plan: unknown, config?: DagPlanConfig): PlanValidation {
	const schema = validatePlanSchema(plan);
	if (!schema.ok) return schema;
	const steps = (plan as DagPlan).steps;

	const hardMax = getHardMaxSteps(config);
	if (steps.length > hardMax)
		return {
			ok: false,
			error: `plan has ${steps.length} steps; hard limit is ${hardMax} (raise "maxSteps" in the dag-plan.json config to allow larger plans)`,
		};

	const seen = new Set<string>();
	for (const step of steps) {
		if (seen.has(step.id)) return { ok: false, error: `duplicate step id "${step.id}"` };
		seen.add(step.id);
		if (step.dependsOn.includes(step.id))
			return { ok: false, error: `step "${step.id}" depends on itself` };
	}
	for (const s of steps) {
		for (const d of s.dependsOn) {
			if (!seen.has(d)) return { ok: false, error: `step "${s.id}" depends on unknown id "${d}"` };
		}
	}
	const cycle = findCycle(steps);
	if (cycle) return { ok: false, error: `cycle detected: ${cycle.join(" → ")}` };
	const warnings: string[] = [];
	const softMax = getMaxSteps(config);
	if (steps.length > softMax)
		warnings.push(
			`plan has ${steps.length} steps (recommended max ${softMax} — raise "maxSteps" in dag-plan.json) — each step is a separate agent session, review before executing`,
		);
	warnings.push(...touchesOverlapWarnings(steps));
	return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}

/**
 * One warning per unordered pair of steps sharing a `touches` entry. A pair
 * is "ordered" when one step transitively depends on the other. Plans with
 * no `touches` declarations produce no warnings (the planner prompt asks
 * for them; older/external plans may lack them).
 */
export function touchesOverlapWarnings(steps: DagNode[]): string[] {
	const byResource = new Map<string, string[]>();
	for (const s of steps) {
		for (const t of new Set(s.touches ?? [])) {
			const list = byResource.get(t) ?? [];
			list.push(s.id);
			byResource.set(t, list);
		}
	}
	if (byResource.size === 0) return [];
	const deps = transitiveDepClosure(steps);
	const warnings: string[] = [];
	for (const [resource, ids] of byResource) {
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const a = ids[i]!;
				const b = ids[j]!;
				const ordered = (deps.get(a)?.has(b) ?? false) || (deps.get(b)?.has(a) ?? false);
				if (!ordered)
					warnings.push(
						`steps "${a}" and "${b}" both touch ${JSON.stringify(resource)} but are not ordered by a dependency; they will be serialized by the file lock`,
					);
			}
		}
	}
	return warnings;
}

/** id -> set of all transitive prerequisite ids. Assumes an acyclic plan. */
function transitiveDepClosure(steps: DagNode[]): Map<string, Set<string>> {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const memo = new Map<string, Set<string>>();
	const visit = (id: string): Set<string> => {
		const cached = memo.get(id);
		if (cached) return cached;
		const out = new Set<string>();
		for (const d of byId.get(id)?.dependsOn ?? []) {
			out.add(d);
			for (const t of visit(d)) out.add(t);
		}
		memo.set(id, out);
		return out;
	};
	for (const s of steps) visit(s.id);
	return memo;
}

/** DFS cycle detection; returns one cycle path (ending back at its start, e.g. [a,b,c,a]) or null. */
export function findCycle(steps: DagNode[]): string[] | null {
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map<string, number>(steps.map((s) => [s.id, WHITE]));

	const visit = (id: string, stack: string[]): string[] | null => {
		color.set(id, GRAY);
		stack.push(id);
		const step = steps.find((s) => s.id === id);
		for (const dep of step?.dependsOn ?? []) {
			const c = color.get(dep) ?? WHITE;
			if (c === GRAY) {
				const start = stack.indexOf(dep);
				return [...stack.slice(start), dep];
			}
			if (c === WHITE) {
				const found = visit(dep, stack);
				if (found) return found;
			}
		}
		stack.pop();
		color.set(id, BLACK);
		return null;
	};

	for (const s of steps) {
		if ((color.get(s.id) ?? WHITE) === WHITE) {
			const found = visit(s.id, []);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Kahn's algorithm levelization: level k = nodes whose deps all completed in
 * levels < k. Order within a level follows plan order. Throws on cycles (call
 * validatePlan first).
 */
export function topologicalLevels(steps: DagNode[]): DagNode[][] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const indegree = new Map<string, number>(steps.map((s) => [s.id, (s.dependsOn ?? []).length]));
	const dependents = dependentsIndex(steps);

	let frontier = steps.filter((s) => (indegree.get(s.id) ?? 0) === 0);
	const levels: DagNode[][] = [];
	let processed = 0;
	while (frontier.length > 0) {
		levels.push(frontier);
		processed += frontier.length;
		const next: DagNode[] = [];
		for (const node of frontier) {
			for (const depId of dependents.get(node.id) ?? []) {
				const deg = (indegree.get(depId) ?? 0) - 1;
				indegree.set(depId, deg);
				if (deg === 0) next.push(byId.get(depId)!);
			}
		}
		frontier = next;
	}
	if (processed !== steps.length) throw new Error("cycle detected in DAG (validatePlan first)");
	return levels;
}

/** id -> ids of nodes that directly depend on it. */
export function dependentsIndex(steps: DagNode[]): Map<string, string[]> {
	const idx = new Map<string, string[]>(steps.map((s) => [s.id, []]));
	for (const s of steps) {
		for (const d of s.dependsOn ?? []) {
			idx.get(d)?.push(s.id);
		}
	}
	return idx;
}
