import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPlannerArgs,
	blindPlannerPrompt,
	extractPlanJson,
	loadPlannerInstructions,
	normalizePlan,
	PlanError,
	plannerExplores,
	plan,
	planWithRetries,
	plannerSystemPrompt,
	PLANNER_MAX_ATTEMPTS,
	MAX_PLAN_MD_CHARS,
	PLANNER_INSTRUCTIONS_FILE,
} from "../src/planner.ts";
import { DEFAULT_MAX_STEPS } from "../src/dag.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { emptyUsage } from "../src/types.ts";

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
	assert.deepEqual(buildPlannerArgs("anthropic/claude-x", "medium", { ...DEFAULT_CONFIG, maxSteps: 12 }), [
		"--mode", "json", "-p", "--no-session",
		"--model", "anthropic/claude-x",
		"--thinking", "medium",
		"--no-extensions", "--no-skills", "--no-context-files",
		"--tools", "read,grep,find,ls",
		"--system-prompt", plannerSystemPrompt(12),
	]);
});

test("buildPlannerArgs interpolates the configured (or default) soft cap", () => {
	const def = buildPlannerArgs("p/m");
	assert.equal(def[def.indexOf("--system-prompt") + 1], plannerSystemPrompt(DEFAULT_MAX_STEPS));
	const custom = buildPlannerArgs("p/m", undefined, { ...DEFAULT_CONFIG, maxSteps: 20 });
	assert.equal(custom[custom.indexOf("--system-prompt") + 1], plannerSystemPrompt(20));
});

test("buildPlannerArgs loads configured planner extensions and drops the read-only tool lock", () => {
	const cfg = { ...DEFAULT_CONFIG, plannerExtensions: ["/tmp/plan-ext.ts", "/tmp/other.ts"] };
	const args = buildPlannerArgs("p/m", undefined, cfg);
	assert.deepEqual(args.slice(args.indexOf("-e"), args.indexOf("--system-prompt")), [
		"-e",
		"/tmp/plan-ext.ts",
		"-e",
		"/tmp/other.ts",
	]);
	assert.ok(!args.includes("--tools"), "no strict --tools allow-list once extensions add tools");
	assert.ok(
		args.includes("--no-extensions") && args.includes("--no-skills") && args.includes("--no-context-files"),
		"still locked down from auto-discovery",
	);
	// without extensions the read-only tool set returns
	const bare = buildPlannerArgs("p/m");
	assert.equal(bare[bare.indexOf("--tools") + 1], "read,grep,find,ls");
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

test("plannerExplores reads the config flag (on by default)", () => {
	assert.equal(plannerExplores(), true);
	assert.equal(plannerExplores({ ...DEFAULT_CONFIG, plannerExplore: true }), true);
	assert.equal(plannerExplores({ ...DEFAULT_CONFIG, plannerExplore: false }), false);
});

test("plan() explores via subprocess and extracts the plan", async () => {
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
});

test("plan() returns null when aborted", async () => {
	const ctrl = new AbortController();
	ctrl.abort();
	const result = await plan(fakeCtx(), "x", { spawnImpl: () => fakeProc([], 130) }, ctrl.signal);
	assert.equal(result, null);
});

test("plan() throws a diagnostic when the planner subagent fails", async () => {
	await assert.rejects(
		plan(fakeCtx(), "x", { spawnImpl: () => fakeProc([], 1, "npm: command not found") }),
		/command not found/,
	);
});

test("plan() throws when the planner output is not a valid plan", async () => {
	await assert.rejects(
		plan(fakeCtx(), "x", {
			spawnImpl: () => fakeProc([{ type: "message_end", message: assistantMessage("I cannot do that.") }]),
		}),
		/not a valid plan/,
	);
});

test("plan() automatically rejects a cyclic plan (schema + cycle check)", async () => {
	await assert.rejects(
		plan(fakeCtx(), "x", {
			spawnImpl: () => fakeProc([{ type: "message_end", message: assistantMessage(cyclicPlanJson) }]),
		}),
		/invalid plan: cycle detected: s1 → s2 → s1/,
	);
});

test("plan() automatically rejects a plan that fails the JSON schema", async () => {
	await assert.rejects(
		plan(fakeCtx(), "x", {
			spawnImpl: () => fakeProc([{ type: "message_end", message: assistantMessage(malformedPlanJson) }]),
		}),
		/invalid plan: .*must match/,
	);
});

test("plan() uses the blind single completion when exploration is disabled", async () => {
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
	const result = await plan(ctx, "x", { config: { ...DEFAULT_CONFIG, plannerExplore: false } });
	assert.ok(result);
	assert.equal(capturedSystemPrompt, blindPlannerPrompt(DEFAULT_MAX_STEPS));
});

// ---------------------------------------------------------------------------
// planWithRetries: bounded retry loop shared by initial planning and refine
// ---------------------------------------------------------------------------

const retryPlanResult = {
	plan: { goal: "G", steps: [{ id: "s1", title: "T", prompt: "P", dependsOn: [] }] },
	rawJson: "{}",
	usage: emptyUsage(),
};

test("planWithRetries retries with the error as feedback and the raw output as prior", async () => {
	const calls: { feedback?: string; prior?: string }[] = [];
	const broken = '{"goal": "G", "steps": [';
	const outcome = await planWithRetries(async (feedback, prior) => {
		calls.push({ feedback, prior });
		if (calls.length === 1)
			return {
				error: "planner output is not a valid plan JSON (Unterminated string in JSON at position 10)",
				rawOutput: broken,
			};
		return retryPlanResult;
	});
	assert.equal(outcome.ok, true);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].feedback, undefined);
	assert.equal(calls[0].prior, undefined);
	assert.equal(
		calls[1].feedback,
		"planner output is not a valid plan JSON (Unterminated string in JSON at position 10)",
	);
	assert.equal(calls[1].prior, broken, "failed raw output is fed back as the prior plan");
});

test("planWithRetries keeps initial feedback and appends the latest error", async () => {
	const calls: { feedback?: string; prior?: string }[] = [];
	await planWithRetries(
		async (feedback, prior) => {
			calls.push({ feedback, prior });
			return { error: "invalid plan: cycle detected: s1 → s2 → s1", rawOutput: "failed-output" };
		},
		{ initialFeedback: "split into smaller steps", initialPriorJson: "gate-json" },
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].feedback, "split into smaller steps");
	assert.equal(calls[0].prior, "gate-json");
	assert.equal(calls[1].feedback, "split into smaller steps\n\nLatest error: invalid plan: cycle detected: s1 → s2 → s1");
	assert.equal(calls[1].prior, "failed-output");
});

test("planWithRetries gives up after PLANNER_MAX_ATTEMPTS", async () => {
	let attempts = 0;
	const outcome = await planWithRetries(async () => {
		attempts++;
		return { error: `fail ${attempts}` };
	});
	assert.deepEqual(outcome, { ok: false, aborted: false, error: "fail 2" });
	assert.equal(attempts, PLANNER_MAX_ATTEMPTS);
});

test("planWithRetries does not retry on abort", async () => {
	let attempts = 0;
	const aborted = await planWithRetries(async () => {
		attempts++;
		return null;
	});
	assert.deepEqual(aborted, { ok: false, aborted: true, error: null });
	assert.equal(attempts, 1);

	attempts = 0;
	const preAborted = await planWithRetries(
		async () => {
			attempts++;
			return { error: "x" };
		},
		{ isAborted: () => true },
	);
	assert.deepEqual(preAborted, { ok: false, aborted: true, error: null });
	assert.equal(attempts, 0, "aborted before the first attempt");
});

test("planWithRetries keeps the prior output when a failure has no raw output", async () => {
	const calls: { prior?: string }[] = [];
	await planWithRetries(
		async (_feedback, prior) => {
			calls.push({ prior });
			return { error: "planner subagent exited with code 1" };
		},
		{ initialPriorJson: "gate-json" },
	);
	assert.equal(calls[0].prior, "gate-json");
	assert.equal(calls[1].prior, "gate-json", "spawn failure carries no raw output; keep the prior plan");
});

// ---------------------------------------------------------------------------
// PlanError: raw output attached to parse/validation failures, and the
// retry prompt (prior output + truncation hint + cap)
// ---------------------------------------------------------------------------

const truncatedPlanText = '{"goal": "G", "steps": [{"id": "s1", "title": "T", "prompt": "cut off mid';

test("plan() throws PlanError carrying the raw output on parse failure", async () => {
	await assert.rejects(
		plan(fakeCtx(), "x", {
			spawnImpl: () => fakeProc([{ type: "message_end", message: assistantMessage(truncatedPlanText) }]),
		}),
		(e: unknown) => {
			assert.ok(e instanceof PlanError, `expected PlanError, got: ${e}`);
			assert.match(e.message, /not a valid plan/);
			assert.equal(e.rawOutput, truncatedPlanText);
			return true;
		},
	);
});

test("plan() throws PlanError carrying the normalized JSON on validation failure", async () => {
	await assert.rejects(
		plan(fakeCtx(), "x", {
			spawnImpl: () => fakeProc([{ type: "message_end", message: assistantMessage(cyclicPlanJson) }]),
		}),
		(e: unknown) => {
			assert.ok(e instanceof PlanError, `expected PlanError, got: ${e}`);
			assert.match(e.message, /invalid plan: cycle detected/);
			assert.deepEqual(JSON.parse(e.rawOutput!), JSON.parse(cyclicPlanJson));
			return true;
		},
	);
});

test("plan() retry prompt includes the failed output and a conciseness hint for truncation", async () => {
	const prompts: string[] = [];
	const outcome = await planWithRetries(async (feedback, prior) => {
		try {
			return await plan(fakeCtx(), "Add tests", {
				feedback,
				priorPlanJson: prior,
				spawnImpl: (_command, args) => {
					prompts.push(args[args.length - 1]);
					return fakeProc([{ type: "message_end", message: assistantMessage(truncatedPlanText) }]);
				},
			});
		} catch (e) {
			if (e instanceof PlanError) return { error: e.message, rawOutput: e.rawOutput };
			throw e;
		}
	});
	assert.equal(outcome.ok, false);
	assert.equal(prompts.length, 2);
	assert.ok(!prompts[0].includes("previous attempt"), "first attempt has no prior output");
	assert.match(prompts[1], /A previous attempt's output/, "retry includes the failed output");
	assert.ok(prompts[1].includes(truncatedPlanText), "retry includes the raw broken text");
	assert.match(prompts[1], /cut off before the JSON was complete/i, "truncation hint present");
	assert.match(prompts[1], /more concise plan/i);
});

test("plan() blind path attaches the raw output and honors the truncation hint", async () => {
	let capturedText: string | undefined;
	const ctx: any = {
		...fakeCtx(),
		modelRegistry: {
			complete: async (_model: unknown, req: { messages: { content: { text: string }[] }[] }) => {
				capturedText = req.messages[0].content[0].text;
				return {
					stopReason: "stop",
					content: [{ type: "text", text: truncatedPlanText }],
					usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } },
				};
			},
		},
	};
	await assert.rejects(
		plan(ctx, "x", {
			config: { ...DEFAULT_CONFIG, plannerExplore: false },
			feedback: "planner output is not a valid plan JSON (Unterminated string in JSON at position 5)",
			priorPlanJson: truncatedPlanText,
		}),
		(e: unknown) => {
			assert.ok(e instanceof PlanError, `expected PlanError, got: ${e}`);
			assert.equal(e.rawOutput, truncatedPlanText);
			return true;
		},
	);
	assert.ok(capturedText!.includes(truncatedPlanText), "prior output included in the prompt");
	assert.match(capturedText!, /more concise plan/i, "truncation hint included");
});

// ---------------------------------------------------------------------------
// PLAN.md: project-specific planning instructions (planner-only injection)
// ---------------------------------------------------------------------------

/** A temp project root (mkdtemp) for PLAN.md injection tests. */
function tempCwd(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dag-planner-planmd-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loadPlannerInstructions returns the trimmed PLAN.md content", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, PLANNER_INSTRUCTIONS_FILE), "\n  use tabs and run npm test\n\n");
		assert.equal(await loadPlannerInstructions(dir), "use tabs and run npm test");
	} finally {
		cleanup();
	}
});

test("loadPlannerInstructions returns undefined for missing cwd/dir/file or whitespace-only content", async () => {
	assert.equal(await loadPlannerInstructions(), undefined, "no cwd");
	assert.equal(await loadPlannerInstructions("/nonexistent-dag-planner-root-123"), undefined, "missing dir");
	const { dir, cleanup } = tempCwd();
	try {
		assert.equal(await loadPlannerInstructions(dir), undefined, "dir without PLAN.md");
		writeFileSync(join(dir, PLANNER_INSTRUCTIONS_FILE), "   \n\t  \n");
		assert.equal(await loadPlannerInstructions(dir), undefined, "whitespace-only PLAN.md");
	} finally {
		cleanup();
	}
});

test("loadPlannerInstructions truncates PLAN.md above MAX_PLAN_MD_CHARS with the marker", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		const marker = "…(PLAN.md truncated)";
		writeFileSync(
			join(dir, PLANNER_INSTRUCTIONS_FILE),
			"H".repeat(1000) + "M".repeat(MAX_PLAN_MD_CHARS + 5000) + "T".repeat(1000),
		);
		const result = (await loadPlannerInstructions(dir))!;
		assert.ok(result.startsWith("H".repeat(1000)), "head kept");
		assert.ok(result.endsWith(marker), "truncation marker appended");
		assert.equal(result.length, MAX_PLAN_MD_CHARS + marker.length);
		assert.ok(!result.includes("T".repeat(100)), "tail elided");
	} finally {
		cleanup();
	}
});

test("planner prompts state that PLAN.md is authoritative project guidance", () => {
	for (const prompt of [plannerSystemPrompt(12), blindPlannerPrompt(12)]) {
		assert.match(prompt, /PLAN\.md/);
		assert.match(prompt, /'Project planning instructions'/);
		assert.match(prompt, /authoritative project guidance/);
	}
});

test("plan() injects PLAN.md into the exploring planner prompt before the task when present", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		const planMd = "Use pnpm, not npm; always run pnpm test before reporting done.";
		writeFileSync(join(dir, PLANNER_INSTRUCTIONS_FILE), planMd);
		const ctx: any = { ...fakeCtx(), cwd: dir };
		const result = await plan(ctx, "Add tests", {
			spawnImpl: (_command, args, cwd) => {
				assert.equal(cwd, dir);
				const prompt = args[args.length - 1];
				assert.ok(prompt.startsWith("Project planning instructions (from PLAN.md):"), "instructions come first");
				assert.ok(prompt.includes(planMd), "PLAN.md content present");
				assert.match(prompt, /planning-only instructions/i, "note about planner-only visibility");
				assert.ok(
					prompt.indexOf("Project planning instructions") < prompt.indexOf("Plan this task:"),
					"instructions precede the task",
				);
				return fakeProc([{ type: "message_end", message: assistantMessage(validPlanJson) }]);
			},
		});
		assert.ok(result);
		assert.equal(result!.plan.steps.length, 2);
	} finally {
		cleanup();
	}
});

test("plan() omits the instructions part from the exploring prompt when PLAN.md is absent", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		const ctx: any = { ...fakeCtx(), cwd: dir };
		const result = await plan(ctx, "x", {
			spawnImpl: (_command, args) => {
				const prompt = args[args.length - 1];
				assert.ok(!prompt.includes("Project planning instructions"), "no instructions part without PLAN.md");
				assert.ok(prompt.startsWith("Plan this task:"), "prompt starts with the task");
				return fakeProc([{ type: "message_end", message: assistantMessage(validPlanJson) }]);
			},
		});
		assert.ok(result);
	} finally {
		cleanup();
	}
});

test("plan() blind path includes the PLAN.md instructions in the user message", async () => {
	const { dir, cleanup } = tempCwd();
	let capturedText: string | undefined;
	try {
		const planMd = "Prefer vitest over jest for new tests.";
		writeFileSync(join(dir, PLANNER_INSTRUCTIONS_FILE), planMd);
		const ctx: any = {
			...fakeCtx(),
			cwd: dir,
			modelRegistry: {
				complete: async (_model: unknown, req: { messages: { content: { text: string }[] }[] }) => {
					capturedText = req.messages[0].content[0].text;
					return {
						stopReason: "stop",
						content: [{ type: "text", text: validPlanJson }],
						usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } },
					};
				},
			},
		};
		const result = await plan(ctx, "x", { config: { ...DEFAULT_CONFIG, plannerExplore: false } });
		assert.ok(result);
		assert.match(capturedText!, /Project planning instructions \(from PLAN\.md\):/);
		assert.ok(capturedText!.includes(planMd));
		assert.ok(
			capturedText!.indexOf("Project planning instructions") < capturedText!.indexOf("Plan this task:"),
			"instructions precede the task",
		);
	} finally {
		cleanup();
	}
});

test("plan() blind path omits the instructions part when PLAN.md is absent", async () => {
	const { dir, cleanup } = tempCwd();
	let capturedText: string | undefined;
	try {
		const ctx: any = {
			...fakeCtx(),
			cwd: dir,
			modelRegistry: {
				complete: async (_model: unknown, req: { messages: { content: { text: string }[] }[] }) => {
					capturedText = req.messages[0].content[0].text;
					return {
						stopReason: "stop",
						content: [{ type: "text", text: validPlanJson }],
						usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } },
					};
				},
			},
		};
		const result = await plan(ctx, "x", { config: { ...DEFAULT_CONFIG, plannerExplore: false } });
		assert.ok(result);
		assert.ok(!capturedText!.includes("Project planning instructions"));
		assert.ok(capturedText!.startsWith("Plan this task:"));
	} finally {
		cleanup();
	}
});

test("plan() caps very large prior output, keeping the tail", async () => {
	let capturedText: string | undefined;
	const ctx: any = {
		...fakeCtx(),
		modelRegistry: {
			complete: async (_model: unknown, req: { messages: { content: { text: string }[] }[] }) => {
				capturedText = req.messages[0].content[0].text;
				return {
					stopReason: "stop",
					content: [{ type: "text", text: validPlanJson }],
					usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } },
				};
			},
		},
	};
	const prior = "HEAD-MARKER-".padEnd(12000, "x") + "TAIL-MARKER-".padEnd(12000, "y");
	await plan(ctx, "x", { config: { ...DEFAULT_CONFIG, plannerExplore: false }, priorPlanJson: prior });
	assert.match(capturedText!, /earlier output elided/);
	assert.ok(capturedText!.includes("TAIL-MARKER"), "tail kept");
	assert.ok(!capturedText!.includes("HEAD-MARKER"), "head elided");
});
