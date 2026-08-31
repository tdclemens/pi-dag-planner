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

test("renderPlanMarkdown lists touches on step lines only when declared", () => {
	const planWithTouches: DagPlan = {
		goal: "g",
		steps: [
			{ id: "a", title: "A", prompt: "p", dependsOn: [], touches: ["src/a.ts", "package-lock.json"] },
			{ id: "b", title: "B", prompt: "p", dependsOn: ["a"] },
		],
	};
	const md = renderPlanMarkdown(planWithTouches, "raw", "pending");
	assert.ok(md.includes("1. **a** — A — deps: — — touches: src/a.ts, package-lock.json"), md);
	assert.ok(md.includes("2. **b** — B — deps: a"), md);
	assert.ok(!/\*\*b\*\*[^\n]*touches/.test(md), "step without touches has no touches suffix");
	// The embedded JSON keeps touches too (resume source of truth).
	const jsonSection = md.slice(md.indexOf("```json"));
	assert.ok(jsonSection.includes('"touches"'), md);
	assert.ok(jsonSection.includes('"src/a.ts"') && jsonSection.includes('"package-lock.json"'), md);
});
