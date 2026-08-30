import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPlanJson, normalizePlan } from "../src/planner.ts";

test("extractPlanJson parses raw JSON", () => {
	const raw = JSON.stringify({
		goal: "Refactor the API",
		steps: [
			{ id: "s1", title: "Analyze", prompt: "Analyze the API surface.", dependsOn: [] },
			{ id: "s2", title: "Refactor", prompt: "Refactor based on s1.", dependsOn: ["s1"] },
		],
	});
	const { plan, json } = extractPlanJson(raw);
	assert.equal(plan.goal, "Refactor the API");
	assert.equal(plan.steps.length, 2);
	assert.deepEqual(plan.steps[1].dependsOn, ["s1"]);
	assert.deepEqual(JSON.parse(json), plan);
});

test("extractPlanJson parses a fenced block with prose around it", () => {
	const raw = 'Here is the plan:\n\n```json\n' + JSON.stringify({
		goal: "Ship the fix",
		steps: [{ id: "s1", title: "Fix", prompt: "Fix it.", dependsOn: [] }],
	}) + "\n```\n\nLet me know if you want changes.";
	const { plan } = extractPlanJson(raw);
	assert.equal(plan.goal, "Ship the fix");
	assert.equal(plan.steps[0].id, "s1");
});

test("extractPlanJson rescues trailing commas", () => {
	const raw = `{
		"goal": "G",
		"steps": [
			{ "id": "s1", "title": "T", "prompt": "P", "dependsOn": [], },
			{ "id": "s2", "title": "T2", "prompt": "P2", "dependsOn": ["s1"], },
		],
	}`;
	const { plan } = extractPlanJson(raw);
	assert.equal(plan.steps.length, 2);
});

test("extractPlanJson extracts the outermost object from prose", () => {
	const raw =
		'Sure! {"goal": "G", "steps": [{"id": "s1", "title": "T", "prompt": "P"}]} hope that helps.';
	const { plan } = extractPlanJson(raw);
	assert.equal(plan.goal, "G");
});

test("normalizePlan fills defaults for missing title/id/dependsOn", () => {
	const p = normalizePlan({
		goal: "G",
		steps: [
			{ prompt: "First line of prompt.\nMore detail." },
			{ id: "two", prompt: "p2", dependsOn: [] },
		],
	});
	assert.ok(p);
	assert.equal(p.steps[0].id, "s1");
	assert.equal(p.steps[0].title, "First line of prompt.");
	assert.deepEqual(p.steps[0].dependsOn, []);
	assert.equal(p.steps[1].id, "two");
});

test("normalizePlan filters non-string dependsOn/tools entries", () => {
	const p = normalizePlan({
		goal: "G",
		steps: [{ id: "s1", title: "T", prompt: "P", dependsOn: ["a", 42, null], tools: ["read", 7] }],
	});
	assert.ok(p);
	assert.deepEqual(p.steps[0].dependsOn, ["a"]);
	assert.deepEqual(p.steps[0].tools, ["read"]);
});

test("normalizePlan rejects non-plan shapes", () => {
	assert.equal(normalizePlan(null), null);
	assert.equal(normalizePlan({ steps: [] }), null);
	assert.equal(normalizePlan({ goal: "G" }), null);
	assert.equal(normalizePlan({ goal: "G", steps: [{ title: "no prompt" }] }), null);
	assert.equal(normalizePlan("G"), null);
});

test("extractPlanJson throws a diagnostic for garbage output", () => {
	assert.throws(() => extractPlanJson("I cannot produce JSON right now."), /not a valid plan/);
	assert.throws(() => extractPlanJson('{"unrelated": true}'), /not a valid plan/);
});
