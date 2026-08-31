import assert from "node:assert/strict";
import { test } from "node:test";
import { dependentsIndex, findCycle, getHardMaxSteps, getMaxSteps, topologicalLevels, validatePlan, DEFAULT_MAX_STEPS, HARD_MAX_STEPS } from "../src/dag.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DAG_PLAN_SCHEMA, validatePlanSchema } from "../src/schema.ts";
import type { DagNode } from "../src/types.ts";

function node(id: string, dependsOn: string[] = []): DagNode {
	return { id, title: `Title ${id}`, prompt: `Do ${id}`, dependsOn };
}

/** `n` steps in a chain (all deps known, acyclic) — handy for step-count rules. */
function chain(n: number): DagNode[] {
	return Array.from({ length: n }, (_, i) => node(`n${i}`, i > 0 ? [`n${i - 1}`] : []));
}

const diamond = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];

test("validatePlan accepts a valid plan", () => {
	const v = validatePlan({ goal: "g", steps: diamond });
	assert.equal(v.ok, true);
});

test("validatePlan rejects missing goal / empty steps", () => {
	assert.equal(validatePlan({ steps: diamond }).ok, false);
	assert.equal(validatePlan({ goal: "g" }).ok, false);
	assert.equal(validatePlan({ goal: "g", steps: [] }).ok, false);
	assert.equal(validatePlan(null).ok, false);
});

// ---------------------------------------------------------------------------
// JSON schema (src/schema.ts) — automatic shape validation
// ---------------------------------------------------------------------------

test("DAG_PLAN_SCHEMA is a 2020-12 schema for the plan contract", () => {
	assert.equal(DAG_PLAN_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
	const steps = (DAG_PLAN_SCHEMA.properties as any).steps;
	const stepItem = steps.items;
	assert.deepEqual(DAG_PLAN_SCHEMA.required, ["goal", "steps"]);
	assert.deepEqual((DAG_PLAN_SCHEMA.properties as any).goal.type, "string");
	assert.equal(steps.minItems, 1);
	assert.deepEqual([...stepItem.required].sort(), ["dependsOn", "id", "prompt", "title"]);
	assert.equal(stepItem.properties.id.pattern, "^[a-zA-Z0-9_-]{1,64}$");
	assert.ok(stepItem.properties.dependsOn.uniqueItems);
});

test("validatePlanSchema accepts a well-formed plan", () => {
	assert.equal(validatePlanSchema({ goal: "g", steps: diamond }).ok, true);
	// tools is optional
	const v = validatePlanSchema({
		goal: "g",
		steps: [{ id: "a", title: "t", prompt: "p", dependsOn: [], tools: ["read"] }],
	});
	assert.equal(v.ok, true);
});

test("validatePlanSchema rejects malformed plans with readable diagnostics", () => {
	const cases: Array<[unknown, RegExp]> = [
		[null, /plan must be an object/],
		[{ steps: diamond }, /goal is required/],
		[{ goal: 42, steps: diamond }, /goal must be a string/],
		[{ goal: "g" }, /steps is required/],
		[{ goal: "g", steps: [] }, /steps must be a non-empty array/],
		[{ goal: "g", steps: [node("a"), node("b")], extra: 1 }, /unknown property "extra"/],
		[{ goal: "g", steps: [{ ...node("a"), extra: 1 }] }, /unknown property "extra"/],
		[{ goal: "g", steps: [{ ...node("a"), id: "bad id" }] }, /must match/],
		[{ goal: "g", steps: [{ ...node("a"), id: "a".repeat(65) }] }, /must match/],
		[{ goal: "g", steps: [{ ...node("a"), title: "   " }] }, /non-blank string/],
		[{ goal: "g", steps: [{ ...node("a"), prompt: "" }] }, /non-blank string/],
		[{ goal: "g", steps: [{ ...node("a"), dependsOn: "a" }] }, /dependsOn must be an array/],
		[{ goal: "g", steps: [{ ...node("a"), dependsOn: [42] }] }, /string/],
		[{ goal: "g", steps: [{ ...node("a"), dependsOn: ["a", "a"] }] }, /must not contain duplicates/],
		[{ goal: "g", steps: [{ id: "a", title: "t", prompt: "p" }] }, /dependsOn is required/],
	];
	for (const [input, re] of cases) {
		const v = validatePlanSchema(input);
		assert.equal(v.ok, false, `expected rejection: ${JSON.stringify(input)}`);
		assert.match((v as { error: string }).error, re);
	}
});

test("validatePlan rejects plans that fail the schema", () => {
	const bad: unknown[] = [
		{ goal: "   ", steps: diamond },
		{ goal: "g", steps: [{ ...node("a"), id: "Bad ID!" }] },
		{ goal: "g", steps: [{ ...node("a"), dependsOn: null }] },
		{ goal: "g", steps: [{ ...node("a"), tools: "read" }] },
		{ goal: "g", steps: [{ ...node("a"), touches: "src/a.ts" }] },
		{ goal: "g", steps: [{ ...node("a"), touches: [""] }] },
		{ goal: "g", steps: [{ ...node("a"), touches: ["x", "x"] }] },
	];
	for (const p of bad) {
		const v = validatePlan(p);
		assert.equal(v.ok, false, `expected rejection: ${JSON.stringify(p)}`);
	}
	const good = validatePlan({ goal: "g", steps: [{ ...node("a"), touches: ["src/a.ts", "ports:3000"] }] });
	assert.equal(good.ok, true, "well-formed touches are accepted");
});

test("validatePlan warns (but still ok) when unordered steps share a touches entry", () => {
	const v = validatePlan({
		goal: "g",
		steps: [
			{ ...node("a"), touches: ["src/app.ts"] },
			{ ...node("b"), touches: ["src/app.ts"] },
		],
	});
	assert.equal(v.ok, true);
	if (v.ok) {
		assert.equal(v.warnings?.length, 1);
		assert.match(v.warnings[0]!, /"a" and "b"/);
		assert.match(v.warnings[0]!, /src\/app\.ts/);
	}
});

test("validatePlan does not warn when overlapping touches are ordered (direct or transitive)", () => {
	const direct = validatePlan({
		goal: "g",
		steps: [{ ...node("a"), touches: ["x"] }, { ...node("b", ["a"]), touches: ["x"] }],
	});
	assert.ok(direct.ok && (direct.warnings ?? []).length === 0);
	const transitive = validatePlan({
		goal: "g",
		steps: [
			{ ...node("a"), touches: ["x"] },
			{ ...node("b", ["a"]) },
			{ ...node("c", ["b"]), touches: ["x"] },
		],
	});
	assert.ok(transitive.ok && (transitive.warnings ?? []).length === 0);
});

test("validatePlan warns per unordered pair per resource", () => {
	const v = validatePlan({
		goal: "g",
		steps: [
			{ ...node("a"), touches: ["x", "y"] },
			{ ...node("b"), touches: ["x"] },
			{ ...node("c"), touches: ["y"] },
		],
	});
	assert.ok(v.ok);
	const warnings = v.warnings ?? [];
	assert.equal(warnings.length, 2, "(a,b) on x and (a,c) on y");
	assert.ok(warnings.some((w) => w.includes('"a"') && w.includes('"b"') && w.includes('"x"')));
	assert.ok(warnings.some((w) => w.includes('"a"') && w.includes('"c"') && w.includes('"y"')));
});

test("validatePlan: no touches declarations → no warnings (back-compat)", () => {
	const v = validatePlan({ goal: "g", steps: [node("a"), node("b")] });
	assert.ok(v.ok && (v.warnings ?? []).length === 0);
	const v2 = validatePlan({ goal: "g", steps: [{ ...node("a"), touches: [] }] });
	assert.ok(v2.ok && (v2.warnings ?? []).length === 0);
});

test("validatePlan rejects duplicate ids", () => {
	const v = validatePlan({ goal: "g", steps: [node("a"), node("a")] });
	assert.equal(v.ok, false);
	assert.match((v as { error: string }).error, /duplicate/);
});

// ---------------------------------------------------------------------------
// Step-count caps: soft cap (planner guidance + warning) and hard ceiling
// ---------------------------------------------------------------------------

test("getMaxSteps reads the config soft cap (default 12)", () => {
	assert.equal(getMaxSteps(), DEFAULT_MAX_STEPS);
	assert.equal(getMaxSteps(), 12);
	assert.equal(getMaxSteps({ ...DEFAULT_CONFIG, maxSteps: 20 }), 20);
	for (const bad of [0, -3, 1.5]) {
		assert.equal(getMaxSteps({ ...DEFAULT_CONFIG, maxSteps: bad }), DEFAULT_MAX_STEPS);
	}
});

test("getHardMaxSteps is max(HARD_MAX_STEPS, configured soft cap)", () => {
	assert.equal(getHardMaxSteps(), HARD_MAX_STEPS);
	assert.equal(getHardMaxSteps({ ...DEFAULT_CONFIG, maxSteps: 20 }), HARD_MAX_STEPS);
	assert.equal(getHardMaxSteps({ ...DEFAULT_CONFIG, maxSteps: 40 }), 40);
});

test("validatePlan rejects plans above the hard step ceiling", () => {
	const v = validatePlan({ goal: "g", steps: chain(HARD_MAX_STEPS + 1) });
	assert.equal(v.ok, false);
	assert.match((v as { error: string }).error, /hard limit is 32/);
	assert.match((v as { error: string }).error, /maxSteps/);
	// exactly at the ceiling: accepted
	const at = validatePlan({ goal: "g", steps: chain(HARD_MAX_STEPS) });
	assert.equal(at.ok, true);
	// raising the soft cap raises the ceiling with it
	assert.equal(validatePlan({ goal: "g", steps: chain(40) }, { ...DEFAULT_CONFIG, maxSteps: 40 }).ok, true);
	const tooBig = validatePlan({ goal: "g", steps: chain(41) }, { ...DEFAULT_CONFIG, maxSteps: 40 });
	assert.equal(tooBig.ok, false);
	assert.match((tooBig as { error: string }).error, /hard limit is 40/);
});

test("validatePlan warns (but stays ok) above the soft step cap", () => {
	const v = validatePlan({ goal: "g", steps: chain(DEFAULT_MAX_STEPS + 1) });
	assert.equal(v.ok, true);
	assert.ok(
		v.ok && v.warnings?.some((w) => /13 steps/.test(w) && /maxSteps/.test(w) && /agent session/.test(w)),
	);
	// exactly at the soft cap: no warning
	const exact = validatePlan({ goal: "g", steps: chain(DEFAULT_MAX_STEPS) });
	assert.ok(exact.ok && (exact.warnings ?? []).length === 0);
	// a low soft cap warns for medium plans
	const low = validatePlan({ goal: "g", steps: chain(3) }, { ...DEFAULT_CONFIG, maxSteps: 2 });
	assert.ok(low.ok && low.warnings?.some((w) => /3 steps \(recommended max 2/.test(w)));
});

test("validatePlan rejects self-dependency", () => {
	const v = validatePlan({ goal: "g", steps: [node("a", ["a"])] });
	assert.equal(v.ok, false);
	assert.match((v as { error: string }).error, /itself/);
});

test("validatePlan rejects unknown dependency", () => {
	const v = validatePlan({ goal: "g", steps: [node("a", ["ghost"])] });
	assert.equal(v.ok, false);
	assert.match((v as { error: string }).error, /unknown id/);
});

test("validatePlan detects a 2-cycle", () => {
	const v = validatePlan({ goal: "g", steps: [node("a", ["b"]), node("b", ["a"])] });
	assert.equal(v.ok, false);
	assert.match((v as { error: string }).error, /cycle/);
});

test("validatePlan detects a 3-cycle", () => {
	const v = validatePlan({
		goal: "g",
		steps: [node("a", ["c"]), node("b", ["a"]), node("c", ["b"])],
	});
	assert.equal(v.ok, false);
	assert.match((v as { error: string }).error, /cycle/);
});

test("findCycle returns a readable cycle path", () => {
	const cycle = findCycle([node("x"), node("a", ["c"]), node("b", ["a"]), node("c", ["b"])]);
	assert.ok(cycle);
	assert.equal(cycle[0], cycle[cycle!.length - 1]);
	assert.deepEqual(new Set(cycle), new Set(["a", "b", "c"]));
});

test("findCycle returns null for a DAG", () => {
	assert.equal(findCycle(diamond), null);
});

test("topologicalLevels groups the diamond into 3 waves", () => {
	const levels = topologicalLevels(diamond);
	assert.equal(levels.length, 3);
	assert.deepEqual(levels[0].map((n) => n.id), ["a"]);
	assert.deepEqual(levels[1].map((n) => n.id), ["b", "c"]);
	assert.deepEqual(levels[2].map((n) => n.id), ["d"]);
});

test("topologicalLevels preserves plan order within a wave", () => {
	const levels = topologicalLevels([node("z"), node("a"), node("m")]);
	assert.deepEqual(levels[0].map((n) => n.id), ["z", "a", "m"]);
});

test("topologicalLevels throws on a cycle", () => {
	assert.throws(() => topologicalLevels([node("a", ["b"]), node("b", ["a"])]), /cycle/);
});

test("dependentsIndex maps deps to their dependents", () => {
	const idx = dependentsIndex(diamond);
	assert.deepEqual(idx.get("a"), ["b", "c"]);
	assert.deepEqual(idx.get("d"), []);
});
