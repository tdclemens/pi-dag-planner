import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { buildTaskPrompt, getMaxParallel, runPiSubagent, runPlan } from "../src/executor.ts";
import type { DagEvent, DagNode, DagPlan, NodeResult } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fake subprocess
// ---------------------------------------------------------------------------

class FakeProc extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;
	signals: string[] = [];
	closeOnKill = true;

	kill(signal?: string): boolean {
		this.killed = true;
		this.signals.push(signal ?? "SIGTERM");
		if (this.closeOnKill) setImmediate(() => this.emit("close", 1));
		return true;
	}

	/** Emit a complete success stream: one tool call + final assistant message. */
	emitSuccess(output: string, toolName = "bash", toolArgs: Record<string, unknown> = { command: "true" }): void {
		const lines = [
			{ type: "start", session: "x" },
			{ type: "tool_execution_start", toolCallId: "1", toolName, args: toolArgs },
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					model: "test/model",
					content: [{ type: "text", text: output }],
					usage: {
						input: 100,
						output: 40,
						cacheRead: 10,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
					},
				},
			},
		];
		this.stdout.emit("data", Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
		setImmediate(() => this.emit("close", 0));
	}

	emitFailure(exitCode = 1, stderrText = "boom: something broke"): void {
		if (stderrText) this.stderr.emit("data", Buffer.from(stderrText + "\n"));
		setImmediate(() => this.emit("close", exitCode));
	}

	emitError(err: Error): void {
		this.emit("error", err);
	}
}

interface SpawnRecord {
	command: string;
	args: string[];
	cwd: string;
	proc: FakeProc;
}

function makeHarness(opts?: {
	/** Return a pre-programmed proc per spawn; default: success. */
	program?: (record: SpawnRecord, index: number) => void;
}) {
	const spawns: SpawnRecord[] = [];
	let active = 0;
	let maxActive = 0;

	const spawnImpl = (command: string, args: string[], cwd: string): ChildProcess => {
		const proc = new FakeProc();
		const record: SpawnRecord = { command, args, cwd, proc };
		spawns.push(record);
		active++;
		maxActive = Math.max(maxActive, active);
		const origClose = proc.on.bind(proc);
		proc.on = ((event: string, ...fn: any[]) => {
			if (event === "close") {
				return origClose("close", (...a: any[]) => {
					active--;
					(fn as any[])[0](...a);
				});
			}
			return (origClose as (...a: unknown[]) => EventEmitter)(event, ...fn);
		}) as typeof proc.on;
		// Defer: a real child process emits output asynchronously, after the
		// parent has attached its listeners.
		setImmediate(() => {
			if (opts?.program) opts.program(record, spawns.length - 1);
			else proc.emitSuccess(`output of ${record.args[record.args.length - 1]!.slice(0, 24)}`);
		});
		return proc as unknown as ChildProcess;
	};

	return {
		spawnImpl,
		spawns,
		get maxActive() {
			return maxActive;
		},
	};
}

function node(id: string, dependsOn: string[] = []): DagNode {
	return { id, title: `Title ${id}`, prompt: `Do ${id}`, dependsOn };
}

function collectEvents() {
	const events: DagEvent[] = [];
	return { events, onEvent: (e: DagEvent) => events.push(e) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("getMaxParallel reads DAG_PLAN_MAX_PARALLEL", () => {
	const old = process.env.DAG_PLAN_MAX_PARALLEL;
	try {
		process.env.DAG_PLAN_MAX_PARALLEL = "7";
		assert.equal(getMaxParallel(), 7);
		process.env.DAG_PLAN_MAX_PARALLEL = "0";
		assert.equal(getMaxParallel(), 4);
		process.env.DAG_PLAN_MAX_PARALLEL = "abc";
		assert.equal(getMaxParallel(), 4);
		delete process.env.DAG_PLAN_MAX_PARALLEL;
		assert.equal(getMaxParallel(), 4);
	} finally {
		if (old === undefined) delete process.env.DAG_PLAN_MAX_PARALLEL;
		else process.env.DAG_PLAN_MAX_PARALLEL = old;
	}
});

test("runPlan executes independent nodes in parallel within the bound", async () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1"), node("s2"), node("s3"), node("s4"), node("s5")] };
	const h = makeHarness();
	const { events, onEvent } = collectEvents();
	const signal = new AbortController().signal;

	const results = await runPlan(plan, {
		cwd: process.cwd(),
		signal,
		maxParallel: 2,
		spawnImpl: h.spawnImpl,
		onEvent,
	});

	assert.equal(results.length, 5);
	assert.ok(results.every((r) => r.status === "done"));
	assert.deepEqual(results.map((r) => r.id), ["s1", "s2", "s3", "s4", "s5"]);
	assert.equal(h.spawns.length, 5);
	assert.ok(h.maxActive <= 2, `maxActive was ${h.maxActive}`);
	assert.ok(h.maxActive >= 2, "expected some parallelism with 5 nodes and bound 2");

	const starts = events.filter((e) => e.type === "node-start").length;
	const ends = events.filter((e) => e.type === "node-end").length;
	const snippets = events.filter((e) => e.type === "snippet");
	assert.equal(starts, 5);
	assert.equal(ends, 5);
	assert.equal(snippets.length, 5);
});

test("runPlan passes model/thinking and pins per-node tools in the invocation", async () => {
	const plan: DagPlan = {
		goal: "g",
		steps: [
			{ ...node("s1"), tools: ["read", "bash"] },
			node("s2"),
		],
	};
	const h = makeHarness();
	await runPlan(plan, {
		cwd: "/tmp/x",
		model: "anthropic/claude-x",
		thinkingLevel: "medium",
		signal: new AbortController().signal,
		spawnImpl: h.spawnImpl,
	});
	const [r1, r2] = h.spawns;
	const flagStart = r1.args.indexOf("--mode");
	assert.ok(flagStart >= 0, "expected --mode flag");
	assert.deepEqual(r1.args.slice(flagStart, flagStart + 4), ["--mode", "json", "-p", "--no-session"]);
	assert.ok(r1.args.includes("--model"));
	assert.ok(r1.args.includes("anthropic/claude-x"));
	assert.ok(r1.args.includes("--thinking"));
	assert.ok(r1.args.includes("medium"));
	assert.ok(r1.args.includes("--tools"));
	assert.ok(r1.args.includes("read,bash"));
	assert.equal(r1.cwd, "/tmp/x");
	assert.ok(!r2.args.includes("--tools"));
	// Task prompt is the final positional arg.
	assert.match(r1.args[r1.args.length - 1]!, /Do s1/);
});

test("runPlan injects dependency outputs into dependent prompts", async () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1"), node("s2", ["s1"]), node("s3", ["s1", "s2"])] };
	const h = makeHarness({
		program: (record, i) => {
			record.proc.emitSuccess(i === 0 ? "S1 ARTIFACT: /tmp/out.txt" : `done s${i + 1}`);
		},
	});
	const results = await runPlan(plan, {
		cwd: process.cwd(),
		signal: new AbortController().signal,
		spawnImpl: h.spawnImpl,
	});
	assert.ok(results.every((r) => r.status === "done"));
	const prompt2 = h.spawns.find((s) => /Do s2/.test(s.args[s.args.length - 1]!))!;
	assert.match(prompt2.args[prompt2.args.length - 1]!, /S1 ARTIFACT: \/tmp\/out\.txt/);
	const prompt3 = h.spawns.find((s) => /Do s3/.test(s.args[s.args.length - 1]!))!;
	const p3 = prompt3.args[prompt3.args.length - 1]!;
	assert.match(p3, /\[s1\]/);
	assert.match(p3, /\[s2\]/);
});

test("runPlan marks dependents of a failed node as skipped (transitively)", async () => {
	const plan: DagPlan = {
		goal: "g",
		steps: [node("bad"), node("kid", ["bad"]), node("grandkid", ["kid"]), node("solo")],
	};
	const h = makeHarness({
		program: (record) => {
			if (/Do bad/.test(record.args[record.args.length - 1]!)) record.proc.emitFailure(1, "kaboom");
			else record.proc.emitSuccess("ok");
		},
	});
	const { events, onEvent } = collectEvents();
	const results = await runPlan(plan, {
		cwd: process.cwd(),
		signal: new AbortController().signal,
		spawnImpl: h.spawnImpl,
		onEvent,
	});
	const byId = new Map(results.map((r) => [r.id, r]));
	assert.equal(byId.get("bad")!.status, "failed");
	assert.match(byId.get("bad")!.error!, /kaboom/);
	assert.equal(byId.get("kid")!.status, "skipped");
	assert.match(byId.get("kid")!.skipReason!, /bad/);
	assert.equal(byId.get("grandkid")!.status, "skipped");
	assert.equal(byId.get("solo")!.status, "done");
	// Only non-skipped nodes spawned.
	assert.equal(h.spawns.length, 2);
	const skippedEnds = events.filter(
		(e) => e.type === "node-end" && (e as { result: NodeResult }).result.status === "skipped",
	);
	assert.equal(skippedEnds.length, 2);
});

test("runPlan: model error stopReason counts as failure", async () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1")] };
	const h = makeHarness({
		program: (record) => {
			record.proc.stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							stopReason: "error",
							errorMessage: "rate limited",
							content: [],
						},
					}) + "\n",
				),
			);
			setImmediate(() => record.proc.emit("close", 0));
		},
	});
	const results = await runPlan(plan, {
		cwd: process.cwd(),
		signal: new AbortController().signal,
		spawnImpl: h.spawnImpl,
	});
	assert.equal(results[0]!.status, "failed");
	assert.match(results[0]!.error!, /rate limited/);
});

test("runPlan aborts in-flight nodes and marks pending ones aborted", async () => {
	const plan: DagPlan = { goal: "g", steps: [node("slow"), node("never")] };
	const controller = new AbortController();
	let slowProc: FakeProc | undefined;

	// program: () => {} means the child never speaks or exits on its own.
	const h = makeHarness({ program: () => {} });
	const promise = runPlan(plan, {
		cwd: process.cwd(),
		signal: controller.signal,
		maxParallel: 1, // "never" stays pending
		spawnImpl: (command, args, cwd) => {
			const proc = h.spawnImpl(command, args, cwd) as unknown as FakeProc;
			if (/Do slow/.test(args[args.length - 1]!)) {
				slowProc = proc;
				proc.closeOnKill = true; // ends only when killed
			}
			return proc as unknown as ChildProcess;
		},
	});

	// Wait for the slow node to start, then abort.
	await new Promise((r) => setTimeout(r, 50));
	controller.abort();
	const results = await promise;
	const byId = new Map(results.map((r) => [r.id, r]));
	assert.equal(byId.get("slow")!.status, "aborted");
	assert.equal(byId.get("never")!.status, "aborted");
	assert.ok(slowProc!.killed);
	assert.ok(slowProc!.signals.includes("SIGTERM"));
});

test("runPlan accumulates usage across turns", async () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1")] };
	const h = makeHarness({
		program: (record) => {
			const msg = (output: string) =>
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: output === "second" ? "stop" : "toolUse",
						model: "test/model",
						content: [{ type: "text", text: output }],
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
					},
				});
			record.proc.stdout.emit("data", Buffer.from(msg("first") + "\n" + msg("second") + "\n"));
			setImmediate(() => record.proc.emit("close", 0));
		},
	});
	const results = await runPlan(plan, {
		cwd: process.cwd(),
		signal: new AbortController().signal,
		spawnImpl: h.spawnImpl,
	});
	assert.equal(results[0]!.status, "done");
	assert.equal(results[0]!.usage.turns, 2);
	assert.equal(results[0]!.usage.input, 20);
	assert.equal(results[0]!.usage.output, 10);
	assert.equal(results[0]!.output, "second");
	assert.equal(results[0]!.model, "test/model");
});

test("buildTaskPrompt truncates oversized dep outputs", () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1"), node("s2", ["s1"])] };
	const big1 = "A".repeat(9 * 1024);
	const big2 = "B".repeat(9 * 1024);
	const deps = new Map([["s1", big1]]);
	const prompt = buildTaskPrompt(plan, plan.steps[1]!, deps);
	assert.match(prompt, /\[truncated\]/);
	// Per-dep cap enforced: fewer than 9KB of A's.
	const aCount = (prompt.match(/A/g) ?? []).length;
	assert.ok(aCount < 9 * 1024);
	assert.ok(aCount >= 8 * 1024 - 100);
	void big2;
});

test("buildTaskPrompt omits missing dep outputs", () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1"), node("s2", ["s1"])] };
	const prompt = buildTaskPrompt(plan, plan.steps[1]!, new Map());
	assert.ok(!prompt.includes("Outputs from prerequisite steps"));
});

test("buildTaskPrompt injects the original user request verbatim", () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1"), node("s2", ["s1"])] };
	const original = "Migrate the project from CommonJS to ESM without breaking the test suite";
	const prompt = buildTaskPrompt(plan, plan.steps[1]!, new Map([["s1", "artifacts"]]), original);
	assert.ok(prompt.includes(`Original request (verbatim, from the user): ${original}`));
	// Placed right after the goal, before the step prompt.
	assert.ok(prompt.indexOf("Overall goal") < prompt.indexOf("Original request"));
	assert.ok(prompt.indexOf("Original request") < prompt.indexOf("Your step"));
});

test("buildTaskPrompt omits the original request when not provided or blank", () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1")] };
	const p1 = buildTaskPrompt(plan, plan.steps[0]!, new Map());
	const p2 = buildTaskPrompt(plan, plan.steps[0]!, new Map(), "   ");
	assert.ok(!p1.includes("Original request"));
	assert.ok(!p2.includes("Original request"));
});

test("runPlan passes the original request into every node prompt", async () => {
	const plan: DagPlan = { goal: "g", steps: [node("s1"), node("s2", ["s1"])] };
	const h = makeHarness();
	const results = await runPlan(plan, {
		cwd: process.cwd(),
		signal: new AbortController().signal,
		originalPrompt: "Do the thing, carefully",
		spawnImpl: h.spawnImpl,
	});
	assert.ok(results.every((r) => r.status === "done"));
	for (const rec of h.spawns) {
		assert.match(rec.args[rec.args.length - 1]!, /Original request \(verbatim, from the user\): Do the thing, carefully/);
	}
});

// ---------------------------------------------------------------------------
// runPiSubagent (shared runner: executor nodes + exploring planner)
// ---------------------------------------------------------------------------

test("runPiSubagent collects output, usage, and live tool calls", async () => {
	const h = makeHarness({
		program: (record) => {
			record.proc.emitSuccess("final report", "read", { file_path: "package.json" });
		},
	});
	const calls: Array<[string, Record<string, unknown>]> = [];
	const run = await runPiSubagent({
		cwd: "/tmp/x",
		signal: new AbortController().signal,
		args: ["--mode", "json", "-p", "--no-session", "--model", "test/model"],
		prompt: "PLAN THIS",
		spawnImpl: h.spawnImpl,
		onToolCall: (toolName, args) => calls.push([toolName, args]),
	});
	assert.equal(run.exitCode, 0);
	assert.equal(run.output, "final report");
	assert.equal(run.usage.turns, 1);
	assert.equal(run.usage.input, 100);
	assert.equal(run.model, "test/model");
	assert.equal(run.wasAborted, false);
	assert.deepEqual(calls, [["read", { file_path: "package.json" }]]);
	// Prompt is the trailing positional arg; cwd is passed through.
	const [rec] = h.spawns;
	assert.equal(rec.args[rec.args.length - 1], "PLAN THIS");
	assert.equal(rec.cwd, "/tmp/x");
});

test("runPiSubagent captures stderr for failure diagnostics", async () => {
	const h = makeHarness({
		program: (record) => record.proc.emitFailure(2, "line one\nline two"),
	});
	const run = await runPiSubagent({
		cwd: process.cwd(),
		signal: new AbortController().signal,
		args: [],
		prompt: "x",
		spawnImpl: h.spawnImpl,
	});
	assert.equal(run.exitCode, 2);
	assert.match(run.stderr, /line two/);
});

test("runPiSubagent with a pre-aborted signal kills the child", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = makeHarness({ program: () => {} });
	const run = await runPiSubagent({
		cwd: process.cwd(),
		signal: controller.signal,
		args: [],
		prompt: "x",
		spawnImpl: h.spawnImpl,
	});
	assert.equal(run.wasAborted, true);
	assert.ok(h.spawns[0]!.proc.killed);
	assert.ok(h.spawns[0]!.proc.signals.includes("SIGTERM"));
});
