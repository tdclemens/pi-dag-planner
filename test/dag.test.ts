import assert from "node:assert/strict";
import { test } from "node:test";
import { dependentsIndex, findCycle, topologicalLevels, validatePlan } from "../src/dag.ts";
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
