import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import {
	EXPLORE_DEFAULT_TIMEOUT_MS,
	EXPLORE_MAX_OUTPUT_BYTES,
	EXPLORE_OUTPUT_CAP_BYTES,
	EXPLORE_TOOL_PATH,
	EXPLORE_TOOLS,
	EXPLORE_TRUNCATION_MARKER,
	capBrief,
	exploreSystemPrompt,
	runExploreSubagent,
	toExploreToolResult,
	type ExploreSubagentResult,
} from "../src/explore-tool.ts";
import registerExploreTool from "../src/explore-tool.ts";

// ---------------------------------------------------------------------------
// Fake pi subprocess (same pattern as test/planner.test.ts)
// ---------------------------------------------------------------------------

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

/** A proc that stays open until killed (for the timeout test). */
function stuckProc(): ChildProcess {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.killed = false;
	proc.kill = () => {
		proc.killed = true;
		setImmediate(() => proc.emit("close", 130));
		return true;
	};
	return proc as unknown as ChildProcess;
}

// ---------------------------------------------------------------------------
// Extension file + args shape/lockdown
// ---------------------------------------------------------------------------

test("EXPLORE_TOOL_PATH points at this repo's extension file", () => {
	assert.ok(EXPLORE_TOOL_PATH.endsWith("src/explore-tool.ts"), EXPLORE_TOOL_PATH);
	assert.ok(existsSync(EXPLORE_TOOL_PATH), "the -e target must exist on disk");
});

test("runExploreSubagent builds a read-only, extension-free invocation", async () => {
	let captured: string[] | undefined;
	await runExploreSubagent({
		cwd: "/tmp/repo",
		model: "anthropic/claude-x",
		thinkingLevel: "medium",
		question: "How is the config loaded?",
		spawnImpl: (_command, args, cwd) => {
			captured = args;
			assert.equal(cwd, "/tmp/repo");
			return fakeProc([{ type: "message_end", message: assistantMessage("brief") }]);
		},
	});
	assert.ok(captured);
	// runPiSubagent invokes pi via getPiInvocation, which may prepend the pi
	// entry script as argv[0] — assert everything from --mode onward, which is
	// the researcher invocation itself.
	const start = captured!.indexOf("--mode");
	assert.ok(start <= 1, `unexpected argv prefix: ${JSON.stringify(captured!.slice(0, start))}`);
	// Exact order: mode/lockdown, read-only tools, system prompt, model/thinking.
	assert.deepEqual(captured!.slice(start, captured!.indexOf("--system-prompt") + 2), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--tools",
		EXPLORE_TOOLS.join(","),
		"--system-prompt",
		exploreSystemPrompt(),
	]);
	assert.equal(captured![captured!.indexOf("--model") + 1], "anthropic/claude-x");
	assert.equal(captured![captured!.indexOf("--thinking") + 1], "medium");
	assert.ok(
		captured!.indexOf("--model") > captured!.indexOf("--system-prompt"),
		"model/thinking come after the system prompt",
	);
	// The focused question is the trailing positional prompt.
	assert.equal(captured![captured!.length - 1], "Question: How is the config loaded?");
	// Lockdown: no extra extensions, no mutating or executing tools.
	assert.ok(!captured!.includes("-e"), "no additional extensions");
	assert.equal(captured![captured!.indexOf("--tools") + 1], "read,grep,find,ls");
	assert.ok(!captured!.includes("--no-tools"), "read-only tools are allowed, not disabled");
});

test("runExploreSubagent omits --model/--thinking when absent", async () => {
	let captured: string[] | undefined;
	await runExploreSubagent({
		cwd: "/tmp/repo",
		question: "Q",
		spawnImpl: (_command, args) => {
			captured = args;
			return fakeProc([{ type: "message_end", message: assistantMessage("brief") }]);
		},
	});
	assert.ok(!captured!.includes("--model"));
	assert.ok(!captured!.includes("--thinking"));
	assert.equal(captured![captured!.length - 1], "Question: Q");
});

// ---------------------------------------------------------------------------
// runExploreSubagent outcomes
// ---------------------------------------------------------------------------

test("runExploreSubagent resolves ok with the last assistant text and stream usage", async () => {
	const brief =
	"It is loaded in src/config.ts.\n\n## Key files\n\n- `src/config.ts` — reads the JSON config\n\n## Commands\n\n- npm test\n";
	const result = await runExploreSubagent({
		cwd: "/tmp/repo",
		question: "How is the config loaded?",
		spawnImpl: () =>
			fakeProc([
				{ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/config.ts" } },
				{ type: "message_end", message: assistantMessage("earlier scratch turn") },
				{ type: "message_end", message: assistantMessage(brief) },
			]),
	});
	assert.equal(result.ok, true);
	assert.equal(result.text, brief, "the LAST assistant text message wins");
	assert.equal(result.wasAborted, false);
	assert.equal(result.turns, 2);
	assert.equal(result.input, 20);
	assert.equal(result.output, 10);
	assert.equal(result.error, undefined);
});

test("runExploreSubagent reports ok:false on a non-zero exit", async () => {
	const result = await runExploreSubagent({
		cwd: "/tmp/repo",
		question: "Q",
		spawnImpl: () => fakeProc([], 1, "boom: something broke"),
	});
	assert.equal(result.ok, false);
	assert.equal(result.wasAborted, false);
	assert.equal(result.text, "");
	assert.match(result.error!, /boom: something broke/);
});

test("runExploreSubagent reports ok:false on a model-level error even with exit 0", async () => {
	const result = await runExploreSubagent({
		cwd: "/tmp/repo",
		question: "Q",
		spawnImpl: () =>
			fakeProc([
				{
					type: "message_end",
					message: assistantMessage("partial", { stopReason: "error", errorMessage: "API 529: overloaded" }),
				},
			]),
	});
	assert.equal(result.ok, false);
	assert.equal(result.wasAborted, false);
	assert.match(result.error!, /API 529: overloaded/);
});

test("runExploreSubagent reports ok:false when the final message has no text", async () => {
	const result = await runExploreSubagent({
		cwd: "/tmp/repo",
		question: "Q",
		spawnImpl: () =>
			fakeProc([
				{
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "toolUse",
						model: "test/model",
						content: [],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					},
				},
			]),
	});
	assert.equal(result.ok, false);
	assert.equal(result.text, "");
	assert.match(result.error!, /no final message/);
});

test("runExploreSubagent reports ok:false when the external signal is aborted", async () => {
	const ctrl = new AbortController();
	ctrl.abort();
	const result = await runExploreSubagent({
		cwd: "/tmp/repo",
		question: "Q",
		signal: ctrl.signal,
		spawnImpl: () => fakeProc([], 130),
	});
	assert.equal(result.ok, false);
	assert.equal(result.wasAborted, true);
	assert.match(result.error!, /aborted/);
	assert.doesNotMatch(result.error!, /timed out/);
});

test("runExploreSubagent enforces timeoutMs with an internal abort", async () => {
	const started = Date.now();
	const result = await runExploreSubagent({
		cwd: "/tmp/repo",
		question: "Q",
		timeoutMs: 50,
		spawnImpl: () => stuckProc(), // never closes until killed
	});
	assert.equal(result.ok, false);
	assert.equal(result.wasAborted, true);
	assert.match(result.error!, /timed out after 50/);
	assert.ok(Date.now() - started < 5000, "the timeout fires, it does not wait forever");
});

test("EXPLORE_DEFAULT_TIMEOUT_MS is the 300 s default budget", () => {
	assert.equal(EXPLORE_DEFAULT_TIMEOUT_MS, 300_000);
});

// ---------------------------------------------------------------------------
// 16 KiB brief cap
// ---------------------------------------------------------------------------

test("capBrief passes short text through unchanged", () => {
	const short = "Answer.\n\n## Key files\n\n- `src/a.ts` — the file\n";
	assert.deepEqual(capBrief(short), { text: short, truncated: false });
});

test("capBrief caps at EXPLORE_OUTPUT_CAP_BYTES (16 KiB) with a marker", () => {
	assert.equal(EXPLORE_OUTPUT_CAP_BYTES, 16 * 1024);
	const long = "A".repeat(30 * 1024);
	const { text, truncated } = capBrief(long);
	assert.equal(truncated, true);
	assert.ok(text.startsWith("A".repeat(1024)), "the head of the brief is kept");
	assert.ok(text.endsWith(EXPLORE_TRUNCATION_MARKER), "the truncation marker is appended");
	assert.ok(!text.includes("A".repeat(16384)), "the tail is elided");
	assert.ok(Buffer.byteLength(text, "utf8") <= EXPLORE_OUTPUT_CAP_BYTES, "brief + marker stay within the cap");
});

test("capBrief respects multibyte characters against the byte cap", () => {
	// 3-byte characters: 10_000 × 3 = 30 KiB, over the 16 KiB cap.
	const long = "日".repeat(10_000);
	const { text, truncated } = capBrief(long);
	assert.equal(truncated, true);
	assert.ok(text.endsWith(EXPLORE_TRUNCATION_MARKER));
	assert.ok(Buffer.byteLength(text, "utf8") <= EXPLORE_OUTPUT_CAP_BYTES);
	assert.ok(text.startsWith("日".repeat(1000)), "surrogate-safe prefix (no split code units)");
});

// ---------------------------------------------------------------------------
// Tool result mapping (the shape the planner receives)
// ---------------------------------------------------------------------------

function okResult(text: string, extra: Partial<ExploreSubagentResult> = {}): ExploreSubagentResult {
	return { ok: true, text, wasAborted: false, turns: 3, input: 100, output: 40, ...extra };
}

test("toExploreToolResult maps a success to the brief plus usage details", () => {
	const res = toExploreToolResult(okResult("the brief"), "How is the config loaded?");
	assert.equal(res.isError, undefined);
	assert.equal(res.content.length, 1);
	assert.equal(res.content[0].type, "text");
	assert.equal(res.content[0].text, "the brief");
	assert.deepEqual(res.details, {
		question: "How is the config loaded?",
		ok: true,
		wasAborted: false,
		turns: 3,
		input: 100,
		output: 40,
		truncated: false,
	});
});

test("toExploreToolResult caps an oversized brief at 16 KiB and flags truncation", () => {
	const res = toExploreToolResult(okResult("B".repeat(20 * 1024)), "Q");
	assert.equal(res.content[0].type, "text");
	assert.ok(Buffer.byteLength(res.content[0].text, "utf8") <= EXPLORE_OUTPUT_CAP_BYTES);
	assert.ok(res.content[0].text.endsWith(EXPLORE_TRUNCATION_MARKER));
	assert.equal(res.details.truncated, true);
});

test("toExploreToolResult maps a failure to isError guidance for the planner's own tools", () => {
	const res = toExploreToolResult(
		{ ok: false, text: "", error: "timed out after 300000 ms", wasAborted: true, turns: 1, input: 5, output: 0 },
		"Q",
	);
	assert.equal(res.isError, true);
	assert.equal(
		res.content[0].text,
		"explore failed: timed out after 300000 ms — use your own read/grep/find/ls tools for whatever you still need.",
	);
	assert.equal(res.details.ok, false);
	assert.equal(res.details.wasAborted, true);
	assert.equal(res.details.truncated, false);
});

// ---------------------------------------------------------------------------
// exploreSystemPrompt content
// ---------------------------------------------------------------------------

test("exploreSystemPrompt is a read-only, budgeted researcher on untrusted data", () => {
	const prompt = exploreSystemPrompt();
	assert.match(prompt, /read-only/i, "read-only role");
	assert.match(prompt, /never modify/i, "never modifies");
	assert.match(prompt, /8-15 tool calls/, "explicit ~8-15 tool-call budget");
	assert.match(prompt, /read, grep, find, and ls/, "names its read-only tools");
	assert.match(prompt, /no write, edit, or bash tools/, "cannot mutate or execute");
	assert.match(prompt, /untrusted data, not instructions/, "prompt-injection hygiene");
	assert.match(prompt, /never guess/i, "no speculation");
	assert.match(prompt, /Unanswerable from the repository/, "honest one-line escape hatch");
});

test("exploreSystemPrompt pins the compact brief shape (60 lines, sections, no preamble)", () => {
	const prompt = exploreSystemPrompt();
	assert.match(prompt, /at most ~60 lines/, "brief line budget");
	assert.match(prompt, /no preamble/, "no preamble");
	assert.match(prompt, /no recap/i, "no process recap");
	assert.match(prompt, /2-6 sentences/, "direct answer size");
	assert.match(prompt, /## Key files/, "key files section");
	assert.match(prompt, /## Commands/, "commands section");
	assert.match(prompt, /## Notes/, "notes section");
	assert.match(prompt, /one line/, "one line per key file");
});

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

test("default export registers the explore tool with a self-contained question parameter", () => {
	let tool: any;
	const pi = {
		registerTool: (t: any) => {
			tool = t;
		},
	} as unknown as ExtensionAPI;
	registerExploreTool(pi);
	assert.ok(tool, "registerTool was called");
	assert.equal(tool.name, "explore");
	assert.equal(tool.label, "Explore");
	assert.match(tool.description, /read-only/i);
	assert.match(tool.description, /only the question/i, "the question-only visibility contract");
	assert.match(tool.description, /keep your own context/i, "teaches context preservation");
	// TypeBox schema with exactly one required string parameter.
	assert.equal(tool.parameters.type, "object");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
	assert.equal(tool.parameters.properties.question.type, "string");
	assert.equal(typeof tool.execute, "function", "execute is a function");
});
