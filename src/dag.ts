/**
 * Pure DAG utilities: validation (cycles, missing deps), Kahn topological
 * levels, dependents index. No pi imports — unit-testable on its own.
 */

import type { DagNode, DagPlan } from "./types.ts";

export type PlanValidation = { ok: true } | { ok: false; error: string };

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate a plan: non-empty steps, unique ids, known deps, no self-deps,
 * acyclic. `plan` may be unknown (from untrusted LLM output) — this returns a
 * structured error instead of throwing.
 */
export function validatePlan(plan: unknown): PlanValidation {
	if (!plan || typeof plan !== "object") return { ok: false, error: "plan must be an object" };
	const p = plan as Partial<DagPlan>;
	if (typeof p.goal !== "string" || !p.goal.trim()) return { ok: false, error: "goal must be a non-empty string" };
	if (!Array.isArray(p.steps) || p.steps.length === 0) return { ok: false, error: "steps must be a non-empty array" };

	const seen = new Set<string>();
	for (let i = 0; i < p.steps.length; i++) {
		const s = p.steps[i];
		if (!s || typeof s !== "object") return { ok: false, error: `steps[${i}] must be an object` };
		const step = s as Partial<DagNode>;
		if (typeof step.id !== "string" || !step.id.trim())
			return { ok: false, error: `steps[${i}].id must be a non-empty string` };
		if (!ID_RE.test(step.id))
			return { ok: false, error: `steps[${i}].id "${step.id}" must match [a-zA-Z0-9_-] (1-64 chars)` };
		if (seen.has(step.id)) return { ok: false, error: `duplicate step id "${step.id}"` };
		seen.add(step.id);
		if (typeof step.title !== "string" || !step.title.trim())
			return { ok: false, error: `steps[${i}].title must be a non-empty string` };
		if (typeof step.prompt !== "string" || !step.prompt.trim())
			return { ok: false, error: `steps[${i}].prompt must be a non-empty string` };
		const deps = step.dependsOn ?? [];
		if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string"))
			return { ok: false, error: `steps[${i}].dependsOn must be an array of step ids` };
		for (const d of deps) {
			if (d === step.id) return { ok: false, error: `step "${step.id}" depends on itself` };
		}
	}
	for (const s of p.steps) {
		for (const d of s.dependsOn ?? []) {
			if (!seen.has(d)) return { ok: false, error: `step "${s.id}" depends on unknown id "${d}"` };
		}
	}
	const cycle = findCycle(p.steps);
	if (cycle) return { ok: false, error: `cycle detected: ${cycle.join(" → ")}` };
	return { ok: true };
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
