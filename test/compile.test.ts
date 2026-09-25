import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildCleanPrompt,
	buildCompilePrompt,
	buildProductMdArgs,
	generateProductMd,
	getProductMdDiff,
	loadCompileContext,
	loadProductMd,
	productMdSystemPrompt,
	projectIsEmpty,
	PRODUCT_MD,
	stripMarkdownFences,
	MAX_CLEAN_PRODUCT_CHARS,
	MAX_COMPILE_DIFF_CHARS,
} from "../src/compile.ts";

// ---------------------------------------------------------------------------
// stripMarkdownFences
// ---------------------------------------------------------------------------

test("stripMarkdownFences removes a wrapping fence pair", () => {
	assert.equal(stripMarkdownFences("```\n# P\nbody\n```"), "# P\nbody");
	assert.equal(stripMarkdownFences("```markdown\n# P\nbody\n```\n"), "# P\nbody");
	assert.equal(stripMarkdownFences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
});

test("stripMarkdownFences trims and leaves unfenced text alone", () => {
	assert.equal(stripMarkdownFences("  # P\nbody  "), "# P\nbody");
	assert.equal(stripMarkdownFences("# P\nbody\nmore"), "# P\nbody\nmore");
	// A fence that is not the whole message (text after the closing fence) is not stripped.
	assert.equal(stripMarkdownFences("```\n# P\n```\ntail"), "```\n# P\n```\ntail");
});

test("stripMarkdownFences preserves inner code fences", () => {
	const wrapped = "```markdown\n# P\n\n```js\nconst x = 1;\n```\n```";
	assert.equal(stripMarkdownFences(wrapped), "# P\n\n```js\nconst x = 1;\n```");
});

// ---------------------------------------------------------------------------
// projectIsEmpty
// ---------------------------------------------------------------------------

test("projectIsEmpty is true for empty, dotfile-only, and PRODUCT.md-only dirs", () => {
	const { dir, cleanup } = tempCwd();
	try {
		assert.equal(projectIsEmpty(dir), true, "empty dir");
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
		assert.equal(projectIsEmpty(dir), true, "dotfiles only");
		writeFileSync(join(dir, PRODUCT_MD), "# P\n");
		assert.equal(projectIsEmpty(dir), true, "dotfiles + PRODUCT.md");
	} finally {
		cleanup();
	}
});

test("projectIsEmpty is false for any visible entry", () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, "src.ts"), "x\n");
		assert.equal(projectIsEmpty(dir), false, "visible file");
		rmSync(join(dir, "src.ts"));
		mkdirSync(join(dir, "docs"), { recursive: true });
		assert.equal(projectIsEmpty(dir), false, "visible dir counts, even when empty");
		rmSync(join(dir, "docs"), { recursive: true });
		mkdirSync(join(dir, "only-hidden"));
		writeFileSync(join(dir, "only-hidden", ".keep"), "");
		assert.equal(projectIsEmpty(dir), false, "visible dir counts even if it holds only hidden entries");
	} finally {
		cleanup();
	}
});

test("projectIsEmpty is true for a missing directory", () => {
	const { dir, cleanup } = tempCwd();
	try {
		assert.equal(projectIsEmpty(join(dir, "does-not-exist")), true);
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// getProductMdDiff
// ---------------------------------------------------------------------------

test("getProductMdDiff returns null when PRODUCT.md is absent", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		newRepo(dir);
		assert.equal(await getProductMdDiff(dir), null);
	} finally {
		cleanup();
	}
});

test("getProductMdDiff includes the full content of an untracked PRODUCT.md", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		newRepo(dir);
		writeFileSync(join(dir, PRODUCT_MD), "# Product\n\nline two\nline three\n");
		const diff = await getProductMdDiff(dir);
		assert.ok(diff, "untracked file has a diff");
		assert.match(diff!, /diff --git/);
		assert.match(diff!, /--- \/dev\/null/);
		assert.match(diff!, /\+\+\+ b\/PRODUCT\.md/);
		// Every line of the new file appears as an added line.
		assert.match(diff!, /^\+# Product$/m);
		assert.match(diff!, /^\+line two$/m);
		assert.match(diff!, /^\+line three$/m);
	} finally {
		cleanup();
	}
});

test("getProductMdDiff returns null when a tracked PRODUCT.md is unchanged", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		newRepo(dir);
		writeFileSync(join(dir, PRODUCT_MD), "# A\n");
		git(dir, "add", PRODUCT_MD);
		git(dir, "commit", "-qm", "init");
		assert.equal(await getProductMdDiff(dir), null);
	} finally {
		cleanup();
	}
});

test("getProductMdDiff uses git diff HEAD for a tracked, modified PRODUCT.md", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		newRepo(dir);
		writeFileSync(join(dir, PRODUCT_MD), "# A\n");
		git(dir, "add", PRODUCT_MD);
		git(dir, "commit", "-qm", "init");
		writeFileSync(join(dir, PRODUCT_MD), "# A\n# B\n");
		const diff = await getProductMdDiff(dir);
		assert.ok(diff, "tracked modified has a diff");
		assert.match(diff!, /^\+# B$/m);
		assert.ok(!diff!.includes("/dev/null"), "tracked path must not use the --no-index diff");
	} finally {
		cleanup();
	}
});

test("getProductMdDiff works in a repo with no HEAD", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		newRepo(dir);
		git(dir, "update-ref", "-d", "HEAD"); // no commits yet
		writeFileSync(join(dir, PRODUCT_MD), "# Fresh\n");
		const diff = await getProductMdDiff(dir);
		assert.ok(diff, "no-HEAD repo diff works");
		assert.match(diff!, /^\+# Fresh$/m);
		assert.match(diff!, /--- \/dev\/null/);
	} finally {
		cleanup();
	}
});

test("getProductMdDiff caps the diff at MAX_COMPILE_DIFF_CHARS", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		newRepo(dir);
		const big = Array.from({ length: 100 }, (_, i) => `line-${i} ` + "x".repeat(300)).join("\n");
		writeFileSync(join(dir, PRODUCT_MD), big);
		const diff = await getProductMdDiff(dir);
		assert.ok(diff, "big diff present");
		assert.equal(diff!.length, MAX_COMPILE_DIFF_CHARS + "…(diff truncated)".length, "capped + marker");
		assert.ok(diff!.endsWith("…(diff truncated)"));
		assert.ok(diff!.startsWith("diff --git a/PRODUCT.md b/PRODUCT.md"));
	} finally {
		cleanup();
	}
});

test("getProductMdDiff returns null outside a git repo", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, PRODUCT_MD), "# P\n");
		// --no-index works outside a repo, so an untracked file still diffs.
		const diff = await getProductMdDiff(dir);
		assert.ok(diff);
		assert.match(diff!, /^\+# P$/m);
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// loadCompileContext
// ---------------------------------------------------------------------------

test("loadCompileContext returns [] when no context files exist", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		assert.deepEqual(await loadCompileContext(dir), []);
	} finally {
		cleanup();
	}
});

test("loadCompileContext returns labeled sections in AGENTS/CLAUDE/DESIGN order", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, "AGENTS.md"), "agents rules\n");
		writeFileSync(join(dir, "DESIGN.md"), "design notes\n");
		const sections = await loadCompileContext(dir);
		assert.equal(sections.length, 2, "missing CLAUDE.md is skipped");
		assert.equal(sections[0], "## AGENTS.md\nagents rules");
		assert.equal(sections[1], "## DESIGN.md\ndesign notes");
	} finally {
		cleanup();
	}
});

test("loadCompileContext caps sections at 50KB with a truncation marker", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, "CLAUDE.md"), "z".repeat(60 * 1024));
		const sections = await loadCompileContext(dir);
		assert.equal(sections.length, 1);
		const claude = sections[0]!;
		assert.ok(claude.startsWith("## CLAUDE.md\n"));
		assert.ok(claude.endsWith("…(CLAUDE.md truncated)"));
		assert.equal(claude.length, "## CLAUDE.md\n".length + 50 * 1024 + "…(CLAUDE.md truncated)".length);
	} finally {
		cleanup();
	}
});

test("loadCompileContext skips whitespace-only files", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, "AGENTS.md"), "   \n\t ");
		assert.deepEqual(await loadCompileContext(dir), []);
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// loadProductMd
// ---------------------------------------------------------------------------

test("loadProductMd returns the trimmed full content", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, PRODUCT_MD), "# Product\n\nbody\n");
		assert.equal(await loadProductMd(dir), "# Product\n\nbody");
	} finally {
		cleanup();
	}
});

test("loadProductMd returns null when absent or whitespace-only", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		assert.equal(await loadProductMd(dir), null, "absent");
		writeFileSync(join(dir, PRODUCT_MD), "   \n\t ");
		assert.equal(await loadProductMd(dir), null, "whitespace-only");
	} finally {
		cleanup();
	}
});

test("loadProductMd caps the content at MAX_CLEAN_PRODUCT_CHARS with a marker", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, PRODUCT_MD), "x".repeat(MAX_CLEAN_PRODUCT_CHARS + 10));
		const md = await loadProductMd(dir);
		assert.ok(md, "big spec present");
		assert.equal(md!.length, MAX_CLEAN_PRODUCT_CHARS + "…(PRODUCT.md truncated)".length, "capped + marker");
		assert.ok(md!.endsWith("…(PRODUCT.md truncated)"));
	} finally {
		cleanup();
	}
});

test("loadProductMd reads no git state — works outside a repo", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		writeFileSync(join(dir, PRODUCT_MD), "# P\n");
		assert.equal(await loadProductMd(dir), "# P");
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// buildCompilePrompt
// ---------------------------------------------------------------------------

test("buildCompilePrompt embeds the goal, diff, and each context label", () => {
	const p = buildCompilePrompt("diff hunk", ["## AGENTS.md\nrules", "## DESIGN.md\nnotes"]);
	assert.match(p, /source of truth for product intent/, "goal present");
	assert.ok(p.includes("```diff\n"), "diff is fenced");
	assert.ok(p.includes("diff hunk"), "diff text present");
	assert.ok(p.includes("## AGENTS.md\nrules"), "AGENTS.md label present");
	assert.ok(p.includes("## DESIGN.md\nnotes"), "DESIGN.md label present");
	assert.match(p, /end green/);
	assert.match(p, /verification command/);
	assert.match(p, /\"steps\": \[\]/, "no-op plan offered when the diff needs no changes");
});

test("buildCompilePrompt omits the context part when none exist", () => {
	const p = buildCompilePrompt("d", []);
	assert.ok(!p.includes("Project context"), "no context section when empty");
	assert.ok(p.includes("```diff\nd\n```"));
});

// ---------------------------------------------------------------------------
// buildCleanPrompt
// ---------------------------------------------------------------------------

test("buildCleanPrompt embeds the whole-spec goal, full spec, and each context label", () => {
	const p = buildCleanPrompt("# P\nfull spec body", ["## AGENTS.md\nrules", "## DESIGN.md\nnotes"]);
	assert.match(p, /ENTIRE PRODUCT\.md/, "whole-spec (not diff) goal");
	assert.match(p, /REMOVES NOTHING/, "explicit no-removal guarantee");
	assert.ok(p.includes("```markdown\n# P\nfull spec body\n```"), "full spec fenced as markdown");
	assert.ok(!p.includes("```diff"), "no diff section");
	assert.ok(p.includes("## AGENTS.md\nrules"), "AGENTS.md label present");
	assert.ok(p.includes("## DESIGN.md\nnotes"), "DESIGN.md label present");
	assert.match(p, /end green/);
	assert.match(p, /verification command/);
	assert.match(p, /Features section is the contract/i, "Features = what the code must implement");
	assert.match(p, /Goals is product direction, not a work order/i, "Goals never planned as work");
	assert.match(p, /backlog/i, "proposals/backlog items are out of scope");
	assert.match(p, /\"steps\": \[\]/, "no-op plan offered when the code already matches");
});

test("buildCleanPrompt omits the context part when none exist", () => {
	const p = buildCleanPrompt("spec", []);
	assert.ok(!p.includes("Project context"), "no context section when empty");
	assert.ok(p.includes("```markdown\nspec\n```"));
});

// ---------------------------------------------------------------------------
// productMdSystemPrompt / buildProductMdArgs / generateProductMd
// ---------------------------------------------------------------------------

test("productMdSystemPrompt describes the read-only PRODUCT.md writer contract", () => {
	const sp = productMdSystemPrompt();
	assert.ok(sp.includes("read-only"), "read-only framing");
	assert.ok(sp.includes("ONLY the raw markdown"), "raw markdown only");
	for (const section of ["## Features", "## Goals", "## Constraints"]) assert.ok(sp.includes(section), section);
	assert.ok(sp.includes("PRODUCT.md"));
	// Style contract: concise, human-readable, no asides, to the point.
	assert.ok(sp.includes("No asides"), "bans asides (parentheses, callouts, meta commentary)");
	assert.ok(sp.includes("One fact per bullet"), "one fact per bullet");
	assert.ok(sp.includes("short plain sentences"), "human-readable plain language");
	assert.ok(sp.includes("never invent"), "repo evidence only");
	assert.ok(sp.includes("at most 3 sentences"), "concise overview bound");
	assert.ok(sp.includes("No front matter, no code fences"), "plain markdown only");
});

test("buildProductMdArgs emits the exact pi flag list", () => {
	assert.deepEqual(buildProductMdArgs("prov/model-x"), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"prov/model-x",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--tools",
		"read,grep,find,ls",
		"--system-prompt",
		productMdSystemPrompt(),
	]);
});

test("generateProductMd strips fences and returns content + usage", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		let capturedArgs: string[] | undefined;
		const result = await generateProductMd(dir, "test/model-x", new AbortController().signal, () => {}, (_command, args) => {
			capturedArgs = args;
			return fakeProc([
				{ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { file_path: "package.json" } },
				{ type: "message_end", message: assistantMessage("```markdown\n# Product\n\nbody text\n```") },
			]);
		});
		assert.ok(result, "result present");
		assert.equal(result!.content, "# Product\n\nbody text", "fences stripped");
		assert.equal(result!.usage.input, 10);
		assert.equal(result!.usage.output, 5);
		assert.equal(result!.usage.turns, 1);
		// getPiInvocation may prepend the pi entrypoint script; the flags after it must match.
		assert.deepEqual(capturedArgs!.slice(1), [
			...buildProductMdArgs("test/model-x"),
			"Write the PRODUCT.md file for this repository. Reply with ONLY the markdown content.",
		]);
	} finally {
		cleanup();
	}
});

test("generateProductMd reports explore snippets", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		const snippets: string[] = [];
		const result = await generateProductMd(dir, "m", new AbortController().signal, (s) => snippets.push(s), () =>
			fakeProc([
				{ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { file_path: "package.json" } },
				{ type: "message_end", message: assistantMessage("# P") },
			]),
		);
		assert.ok(result);
		assert.deepEqual(snippets, ["read package.json"]);
	} finally {
		cleanup();
	}
});

test("generateProductMd returns null when aborted", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		const ctrl = new AbortController();
		ctrl.abort();
		const result = await generateProductMd(dir, "m", ctrl.signal, undefined, () => fakeProc([], 130));
		assert.equal(result, null);
	} finally {
		cleanup();
	}
});

test("generateProductMd throws when the subagent produced no usable content", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		await assert.rejects(
			generateProductMd(dir, "m", new AbortController().signal, undefined, () =>
				fakeProc([{ type: "message_end", message: assistantMessage("```markdown\n\n```") }]),
			),
			/no content/,
		);
		await assert.rejects(
			generateProductMd(dir, "m", new AbortController().signal, undefined, () =>
				fakeProc([{ type: "message_end", message: assistantMessage("   \n") }]),
			),
			/no content/,
		);
	} finally {
		cleanup();
	}
});

test("generateProductMd throws a diagnostic when the subagent fails", async () => {
	const { dir, cleanup } = tempCwd();
	try {
		await assert.rejects(
			generateProductMd(dir, "m", new AbortController().signal, undefined, () =>
				fakeProc([], 1, "npm: command not found"),
			),
			/command not found/,
		);
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A temp project root (mkdtemp). */
function tempCwd(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dag-compile-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** git(...) in dir, throwing on non-zero exit. */
function git(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/**
 * Init a throwaway git repo: `main` branch, a configured identity, and one
 * empty commit so HEAD exists.
 */
function newRepo(dir: string): void {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t");
	git(dir, "config", "user.name", "t");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
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

function assistantMessage(text: string) {
	return {
		role: "assistant",
		stopReason: "stop",
		model: "test/model",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
	};
}
