import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	extractPlanFromMarkdown,
	extractPromptFromMarkdown,
	loadRunState,
	renderPlanMarkdown,
	revisePlan,
	runStatePath,
	saveRunState,
	setPlanFileStatus,
} from "../src/plans.ts";
import type { DagPlan, NodeResult } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

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

test("renderPlanMarkdown adds a Revised line (after Created, before Planned in) only when provided", () => {
	const md = renderPlanMarkdown(plan, "the prompt", "pending", 12000, "2025-01-01T12:00:00.000Z");
	assert.ok(md.includes("- **Revised:** 2025-01-01T12:00:00.000Z"), md);
	const createdIdx = md.indexOf("- **Created:**");
	const revisedIdx = md.indexOf("- **Revised:**");
	const plannedIdx = md.indexOf("- **Planned in:**");
	const statusIdx = md.indexOf("- **Status:**");
	assert.ok(createdIdx < revisedIdx && revisedIdx < plannedIdx && plannedIdx < statusIdx, md);
	const fresh = renderPlanMarkdown(plan, "the prompt", "pending", 12000);
	assert.ok(!fresh.includes("**Revised:**"), "no Revised line without a revision");
});

test("revisePlan rewrites the same file: new plan + pending status, original Created kept, Revised added", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dag-planner-revise-"));
	try {
		const file = path.join(dir, "20250101-120000-test-goal.md");
		const before = renderPlanMarkdown(plan, "the prompt", "pending");
		await fsp.writeFile(file, before, "utf8");
		const createdLine = before.match(/^(- \*\*Created:\*\* .*)$/m)?.[1];
		assert.ok(createdLine);

		const revised: DagPlan = {
			goal: "Test goal",
			steps: [
				{ id: "s1", title: "First", prompt: "do first (v2)", dependsOn: [] },
				{ id: "s2", title: "Second", prompt: "do second", dependsOn: ["s1"] },
				{ id: "s3", title: "Third", prompt: "do third", dependsOn: ["s2"] },
			],
		};
		const returned = await revisePlan(file, revised, "the prompt", 5000);
		assert.equal(returned, file, "the path is unchanged — no new -2.md file");

		const after = await fsp.readFile(file, "utf8");
		assert.ok(after.includes(createdLine!), "original Created timestamp preserved");
		assert.match(after, /^- \*\*Revised:\*\* /m, "Revised line added");
		assert.ok(after.includes("- **Status:** pending"), "status back to pending");
		assert.ok(after.includes("do first (v2)"), "revised step content");
		assert.ok(after.includes('"s3"'), "new step embedded in the JSON");
		assert.ok(after.includes("3. **s3** — Third — deps: s2"), "steps list re-rendered");
		const json = extractPlanFromMarkdown(after)!;
		assert.equal(json!.steps.length, 3);
		// Exactly one file in the directory — no litter per refine round.
		assert.deepEqual(await fsp.readdir(dir), ["20250101-120000-test-goal.md"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("revisePlan recreates the file when it was deleted out from under the plan", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dag-planner-revise-"));
	try {
		const file = path.join(dir, "gone.md");
		const returned = await revisePlan(file, plan, "the prompt");
		assert.equal(returned, file);
		const md = await fsp.readFile(file, "utf8");
		assert.ok(md.includes("- **Status:** pending"), md);
		assert.match(md, /^- \*\*Revised:\*\* /m);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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

// ---------------------------------------------------------------------------
// Run-state sidecar (resume support)
// ---------------------------------------------------------------------------

function doneResult(id: string, output: string): NodeResult {
	return { id, title: `Title ${id}`, status: "done", snippets: [], output, usage: emptyUsage() };
}

test("runStatePath derives the sidecar path from the plan file", () => {
	assert.equal(runStatePath("/p/plans/20250101-120000-x.md"), "/p/plans/20250101-120000-x.run.json");
	assert.equal(runStatePath("/p/plans/x"), "/p/plans/x.run.json");
});

test("saveRunState + loadRunState round-trip; missing/corrupt/wrong-version sidecar loads as null", async () => {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dag-plan-"));
	const planPath = path.join(dir, "20250101-120000-x.md");
	const state = {
		version: 1 as const,
		planPath,
		plan,
		prompt: "the prompt",
		status: "executing" as const,
		startedAt: 1,
		updatedAt: 2,
		results: { s1: doneResult("s1", "ok") },
	};
	assert.equal(await loadRunState(planPath), null, "missing sidecar → null");

	await saveRunState(state);
	assert.deepEqual(await loadRunState(planPath), state);
	// Atomic write leaves no temp file behind.
	assert.deepEqual(await fsp.readdir(dir), ["20250101-120000-x.run.json"]);

	await fsp.writeFile(path.join(dir, "20250101-120000-x.run.json"), "{not json", "utf8");
	assert.equal(await loadRunState(planPath), null, "corrupt sidecar → null");

	await fsp.writeFile(
		path.join(dir, "20250101-120000-x.run.json"),
		JSON.stringify({ ...state, version: 99 }),
		"utf8",
	);
	assert.equal(await loadRunState(planPath), null, "wrong version → null");
});

test("setPlanFileStatus flips the Status line; missing file is a no-op", async () => {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dag-plan-"));
	const planPath = path.join(dir, "x.md");
	await fsp.writeFile(planPath, renderPlanMarkdown(plan, "the prompt", "pending"), "utf8");
	await setPlanFileStatus(planPath, "executing");
	assert.ok((await fsp.readFile(planPath, "utf8")).includes("- **Status:** executing"));
	await setPlanFileStatus(path.join(dir, "missing.md"), "executing"); // must not throw
});

test("extractPlanFromMarkdown round-trips the embedded JSON; null without the section", () => {
	const md = renderPlanMarkdown(plan, "the prompt", "pending");
	assert.deepEqual(extractPlanFromMarkdown(md), plan);
	assert.equal(extractPlanFromMarkdown("# no plan here\n"), null);
});

test("extractPromptFromMarkdown reads the Prompt header line", () => {
	const md = renderPlanMarkdown(plan, "add the tests", "pending");
	assert.equal(extractPromptFromMarkdown(md), "add the tests");
	assert.equal(extractPromptFromMarkdown("# nothing\n"), "");
});
