import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPlanMarkdown } from "../src/plans.ts";
import type { DagPlan } from "../src/types.ts";

const plan: DagPlan = {
	goal: "Test goal",
	steps: [
		{ id: "s1", title: "First", prompt: "do first", dependsOn: [] },
		{ id: "s2", title: "Second", prompt: "do second", dependsOn: ["s1"] },
	],
};

test("renderPlanMarkdown includes the plan-phase duration when provided", () => {
	const md = renderPlanMarkdown(plan, "the prompt", "pending", 42300);
	assert.ok(md.includes("- **Planned in:** 42.3s"), md);
	// Duration line sits in the header, right after Created and before Status.
	const createdIdx = md.indexOf("- **Created:**");
	const plannedIdx = md.indexOf("- **Planned in:**");
	const statusIdx = md.indexOf("- **Status:**");
	assert.ok(createdIdx !== -1 && plannedIdx !== -1 && statusIdx !== -1, md);
	assert.ok(createdIdx < plannedIdx && plannedIdx < statusIdx, md);
});

test("renderPlanMarkdown omits the duration line when unknown", () => {
	const md = renderPlanMarkdown(plan, "the prompt", "pending");
	assert.ok(!md.includes("**Planned in:**"), md);
	assert.ok(md.includes("- **Status:** pending"), md);
});
