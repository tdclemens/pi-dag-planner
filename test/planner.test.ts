import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import {
	buildPlannerArgs,
	blindPlannerPrompt,
	extractPlanJson,
	normalizePlan,
	plannerExplores,
	plan,
	plannerSystemPrompt,
} from "../src/planner.ts";
import { DEFAULT_MAX_STEPS } from "../src/dag.ts";

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

test("normalizePlan carries touches through (trimmed, non-strings/blank filtered, absent when empty)", () => {
	const p = normalizePlan({
		goal: "G",
		steps: [{ id: "s1", title: "T", prompt: "P", touches: ["a.ts", "  ", 42, " package-lock.json "] }],
	});
	assert.ok(p);
	assert.deepEqual(p.steps[0].touches, ["a.ts", "package-lock.json"]);
	const p2 = normalizePlan({ goal: "G", steps: [{ id: "s1", title: "T", prompt: "P" }] });
	assert.ok(p2);
	assert.equal(p2.steps[0].touches, undefined, "no key when the model omitted touches");
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

// ---------------------------------------------------------------------------
// Exploring planner (read-only pi subprocess) vs. blind single completion
// ---------------------------------------------------------------------------

const validPlanJson = JSON.stringify({
	goal: "Add tests for the parser",
	steps: [
		{ id: "s1", title: "Survey", prompt: "Survey the repo.", dependsOn: [] },
		{ id: "s2", title: "Verify", prompt: "Run the test suite.", dependsOn: ["s1"] },
	],
});

const cyclicPlanJson = JSON.stringify({
	goal: "Loop forever",
	steps: [
		{ id: "s1", title: "One", prompt: "Do one.", dependsOn: ["s2"] },
		{ id: "s2", title: "Two", prompt: "Do two.", dependsOn: ["s1"] },
	],
});

const malformedPlanJson = JSON.stringify({
	goal: "Bad ids",
	steps: [{ id: "Bad ID!", title: "One", prompt: "Do one.", dependsOn: [] }],
});

/** Minimal ExtensionCommandContext for plan() (model + cwd + thinking). */
function fakeCtx(): any {
	return { model: { provider: "test", id: "model" }, cwd: "/tmp/repo", thinkingLevel: undefined };
}

/**
 * Fake pi subprocess: emits the given JSONL events on stdout (plus optional
 * stderr), then closes with `exitCode`. Always closes so aborts can't hang.
 */
function fakeProc(events: unknown[], exitCode = 0, stderr = ""): ChildProcess {
	const proc = new EventEmitter() as any;
	const out = new EventEmitter();
	const err = new EventEmitter();
	proc.stdout = out;
	proc.stderr = err;
	proc.killed = false;
	proc.kill = () => {
		proc.killed = true;
		return true;
	};
	setImmediate(() => {
		if (stderr) err.emit("data", Buffer.from(stderr + "\n"));
		if (events.length > 0) out.emit("data", Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
		proc.emit("close", exitCode);
	});
	return proc as unknown as ChildProcess;
}

function assistantMessage(text: string, extra: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		stopReason: "stop",
		model: "test/model",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
		...extra,
	};
}

test("buildPlannerArgs pins a read-only, extension-free planner subagent", () => {
	assert.deepEqual(buildPlannerArgs("anthropic/claude-x", "medium", 12), [
		"--mode", "json", "-p", "--no-session",
		"--model", "anthropic/claude-x",
		"--thinking", "medium",
		"--no-extensions", "--no-skills", "--no-context-files",
		"--tools", "read,grep,find,ls",
		"--system-prompt", plannerSystemPrompt(12),
	]);
});

test("buildPlannerArgs defaults maxSteps from DAG_PLAN_MAX_STEPS", () => {
	const saved = process.env.DAG_PLAN_MAX_STEPS;
	try {
		delete process.env.DAG_PLAN_MAX_STEPS;
		const def = buildPlannerArgs("p/m");
		assert.equal(def[def.indexOf("--system-prompt") + 1], plannerSystemPrompt(DEFAULT_MAX_STEPS));
		process.env.DAG_PLAN_MAX_STEPS = "20";
		const custom = buildPlannerArgs("p/m");
		assert.equal(custom[custom.indexOf("--system-prompt") + 1], plannerSystemPrompt(20));
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_MAX_STEPS;
		else process.env.DAG_PLAN_MAX_STEPS = saved;
	}
});

test("planner prompts interpolate the soft step cap", () => {
	assert.match(plannerSystemPrompt(12), /up to 12 for large multi-module tasks/);
	assert.match(plannerSystemPrompt(20), /up to 20 for large multi-module tasks/);
	assert.doesNotMatch(plannerSystemPrompt(20), /up to 12/);
	assert.match(blindPlannerPrompt(15), /up to 15 for large multi-module tasks/);
});

test("buildPlannerArgs omits --thinking when undefined", () => {
	assert.ok(!buildPlannerArgs("p/m").includes("--thinking"));
});

test("agentic prompt requires exploration + verification; both prompts contract on touches", () => {
	const prompt = plannerSystemPrompt(12);
	assert.match(prompt, /explore the repository/i);
	assert.match(prompt, /read-only/i);
	assert.match(prompt, /verification is required/i);
	assert.match(prompt, /ONLY a JSON object/i);
	assert.match(prompt, /"touches"/);
	assert.match(prompt, /package-lock\.json/, "shared resources (lockfiles) must be declared");
	assert.match(blindPlannerPrompt(12), /ONLY a JSON object/i);
	assert.match(blindPlannerPrompt(12), /"touches"/);
	assert.match(blindPlannerPrompt(12), /serialized at run time/);
});

test("plannerExplores env parsing (on by default)", () => {
	const saved = process.env.DAG_PLAN_PLANNER_EXPLORE;
	try {
		delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		assert.equal(plannerExplores(), true);
		process.env.DAG_PLAN_PLANNER_EXPLORE = "1";
		assert.equal(plannerExplores(), true);
		for (const off of ["0", "false", "off", " OFF "]) {
			process.env.DAG_PLAN_PLANNER_EXPLORE = off;
			assert.equal(plannerExplores(), false);
		}
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		else process.env.DAG_PLAN_PLANNER_EXPLORE = saved;
	}
});

test("plan() explores via subprocess and extracts the plan", async () => {
	const saved = process.env.DAG_PLAN_PLANNER_EXPLORE;
	const savedSteps = process.env.DAG_PLAN_MAX_STEPS;
	delete process.env.DAG_PLAN_PLANNER_EXPLORE;
	delete process.env.DAG_PLAN_MAX_STEPS;
	try {
		const snippets: string[] = [];
		const result = await plan(fakeCtx(), "Add tests", {
			onExplore: (s) => snippets.push(s),
			spawnImpl: (_command, args, cwd) => {
				assert.equal(cwd, "/tmp/repo");
				assert.equal(args[args.indexOf("--system-prompt") + 1], plannerSystemPrompt(DEFAULT_MAX_STEPS));
				assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
				return fakeProc([
					{ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { file_path: "package.json" } },
					{ type: "message_end", message: assistantMessage(`Plan:\n\n\u0060\u0060\u0060json\n${validPlanJson}\n\u0060\u0060\u0060`) },
				]);
			},
		});
		assert.ok(result);
		assert.equal(result!.plan.steps.length, 2);
		assert.equal(result!.usage.input, 10);
		assert.equal(result!.usage.turns, 1);
		assert.deepEqual(snippets, ["read package.json"]);
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		else process.env.DAG_PLAN_PLANNER_EXPLORE = saved;
		if (savedSteps === undefined) delete process.env.DAG_PLAN_MAX_STEPS;
		else process.env.DAG_PLAN_MAX_STEPS = savedSteps;
	}
});

test("plan() returns null when aborted", async () => {
	const saved = process.env.DAG_PLAN_PLANNER_EXPLORE;
	delete process.env.DAG_PLAN_PLANNER_EXPLORE;
	try {
		const ctrl = new AbortController();
		ctrl.abort();
		const result = await plan(fakeCtx(), "x", { spawnImpl: () => fakeProc([], 130) }, ctrl.signal);
		assert.equal(result, null);
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		else process.env.DAG_PLAN_PLANNER_EXPLORE = saved;
	}
});

test("plan() throws a diagnostic when the planner subagent fails", async () => {
	const saved = process.env.DAG_PLAN_PLANNER_EXPLORE;
	delete process.env.DAG_PLAN_PLANNER_EXPLORE;
	try {
		await assert.rejects(
			plan(fakeCtx(), "x", { spawnImpl: () => fakeProc([], 1, "npm: command not found") }),
			/command not found/,
		);
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		else process.env.DAG_PLAN_PLANNER_EXPLORE = saved;
	}
});

test("plan() throws when the planner output is not a valid plan", async () => {
	const saved = process.env.DAG_PLAN_PLANNER_EXPLORE;
	delete process.env.DAG_PLAN_PLANNER_EXPLORE;
	try {
		await assert.rejects(
			plan(fakeCtx(), "x", {
				spawnImpl: () => fakeProc([{ type: "message_end", message: assistantMessage("I cannot do that.") }]),
			}),
			/not a valid plan/,
		);
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		else process.env.DAG_PLAN_PLANNER_EXPLORE = saved;
	}
});

test("plan() automatically rejects a cyclic plan (schema + cycle check)", async () => {
	const saved = process.env.DAG_PLAN_PLANNER_EXPLORE;
	delete process.env.DAG_PLAN_PLANNER_EXPLORE;
	try {
		await assert.rejects(
			plan(fakeCtx(), "x", {
				spawnImpl: () => fakeProc([{ type: "message_end", message: assistantMessage(cyclicPlanJson) }]),
			}),
			/invalid plan: cycle detected: s1 → s2 → s1/,
		);
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		else process.env.DAG_PLAN_PLANNER_EXPLORE = saved;
	}
});

test("plan() automatically rejects a plan that fails the JSON schema", async () => {
	const saved = process.env.DAG_PLAN_PLANNER_EXPLORE;
	delete process.env.DAG_PLAN_PLANNER_EXPLORE;
	try {
		await assert.rejects(
			plan(fakeCtx(), "x", {
				spawnImpl: () => fakeProc([{ type: "message_end", message: assistantMessage(malformedPlanJson) }]),
			}),
			/invalid plan: .*must match/,
		);
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		else process.env.DAG_PLAN_PLANNER_EXPLORE = saved;
	}
});

test("plan() uses the blind single completion when exploration is disabled", async () => {
	const saved = process.env.DAG_PLAN_PLANNER_EXPLORE;
	const savedSteps = process.env.DAG_PLAN_MAX_STEPS;
	process.env.DAG_PLAN_PLANNER_EXPLORE = "0";
	delete process.env.DAG_PLAN_MAX_STEPS;
	try {
		let capturedSystemPrompt: string | undefined;
		const ctx: any = {
			...fakeCtx(),
			modelRegistry: {
				complete: async (_model: unknown, req: { systemPrompt: string }) => {
					capturedSystemPrompt = req.systemPrompt;
					return {
						stopReason: "stop",
						content: [{ type: "text", text: validPlanJson }],
						usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } },
					};
				},
			},
		};
		const result = await plan(ctx, "x");
		assert.ok(result);
		assert.equal(capturedSystemPrompt, blindPlannerPrompt(DEFAULT_MAX_STEPS));
	} finally {
		if (saved === undefined) delete process.env.DAG_PLAN_PLANNER_EXPLORE;
		else process.env.DAG_PLAN_PLANNER_EXPLORE = saved;
		if (savedSteps === undefined) delete process.env.DAG_PLAN_MAX_STEPS;
		else process.env.DAG_PLAN_MAX_STEPS = savedSteps;
	}
});
