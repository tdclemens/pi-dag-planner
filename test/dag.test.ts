import assert from "node:assert/strict";
import { test } from "node:test";
import { dependentsIndex, findCycle, topologicalLevels, validatePlan } from "../src/dag.ts";
import { DAG_PLAN_SCHEMA, validatePlanSchema } from "../src/schema.ts";
import type { DagNode } from "../src/types.ts";

function node(id: string, dependsOn: string[] = []): DagNode {
	return { id, title: `Title ${id}`, prompt: `Do ${id}`, dependsOn };
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
	];
	for (const p of bad) {
		const v = validatePlan(p);
		assert.equal(v.ok, false, `expected rejection: ${JSON.stringify(p)}`);
	}
});

test("validatePlan rejects duplicate ids", () => {
	const v = validatePlan({ goal: "g", steps: [node("a"), node("a")] });
	assert.equal(v.ok, false);
	assert.match((v as { error: string }).error, /duplicate/);
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
