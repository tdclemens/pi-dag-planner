import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { reportExcerpt, renderPlanSummary, RunDashboard } from "../src/ui.ts";
import type { DagEvent, DagPlan, NodeResult } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Minimal theme: strip colors, pass text through. */
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
} as unknown as Theme;

const plan: DagPlan = {
	goal: "test goal",
	steps: [
		{ id: "a", title: "Alpha", prompt: "do a", dependsOn: [] },
		{ id: "b", title: "Beta", prompt: "do b", dependsOn: ["a"] },
	],
};

function result(over: Partial<NodeResult> & { id: string; status: NodeResult["status"] }): NodeResult {
	return {
		title: plan.steps.find((s) => s.id === over.id)?.title ?? over.id,
		snippets: [],
		output: "",
		usage: emptyUsage(),
		...over,
	};
}

function makeDashboard(overrides?: { onAbort?: () => void; onRender?: () => void }) {
	let aborts = 0;
	let renders = 0;
	const onAbort = overrides?.onAbort ?? (() => aborts++);
	const onRender = overrides?.onRender ?? (() => renders++);
	const dashboard = new RunDashboard(plan, theme, onAbort, onRender);
	const emit = (e: DagEvent) => dashboard.update(e);
	return { dashboard, onAbort, onRender, emit, get aborts() { return aborts; }, get renders() { return renders; } };
}

const W = 200;

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

test("initial render shows header counts and pending rows with waiting deps", () => {
	const { dashboard } = makeDashboard();
	const lines = dashboard.render(W);
	assert.ok(lines[0].includes("0/2 done, 0 running, 2 pending"), lines[0]);
	assert.ok(lines[0].includes("(esc: cancel)"), lines[0]);
	assert.ok(lines.some((l) => l.includes("a") && l.includes("Alpha")), lines.join("\n"));
	const rowB = lines.find((l) => l.includes("Beta"))!;
	assert.ok(rowB.includes("(waiting: a)"), rowB);
});

// ---------------------------------------------------------------------------
// The core bug this file guards: every event must trigger a re-render request
// (pi-tui repaints only when explicitly asked — no periodic frames)
// ---------------------------------------------------------------------------

test("update() requests a re-render for every event type", () => {
	const h = makeDashboard();
	assert.equal(h.renders, 0); // construction alone must not request renders

	h.emit({ type: "node-start", nodeId: "a" });
	assert.equal(h.renders, 1, "node-start");

	h.emit({ type: "snippet", nodeId: "a", snippet: { toolName: "bash", args: { command: "ls src/" } } });
	assert.equal(h.renders, 2, "snippet");

	h.emit({
		type: "node-end",
		nodeId: "a",
		result: result({ id: "a", status: "done", startedAt: 0, finishedAt: 14200, output: "ok" }),
	});
	assert.equal(h.renders, 3, "node-end (done)");

	h.emit({ type: "node-end", nodeId: "b", result: result({ id: "b", status: "skipped", skipReason: "x" }) });
	assert.equal(h.renders, 4, "node-end (skipped)");
});

test("render cache is invalidated by update() so repaints show fresh state", () => {
	const { dashboard, emit } = makeDashboard();
	const first = dashboard.render(W);
	const cached = dashboard.render(W);
	assert.strictEqual(cached, first, "same-width re-render without events returns the cached array");

	emit({ type: "node-start", nodeId: "a" });
	const after = dashboard.render(W);
	assert.notStrictEqual(after, first, "event must bust the render cache");
	assert.ok(after.some((l) => l.includes("▶") && l.includes("Alpha")), after.join("\n"));
});

// ---------------------------------------------------------------------------
// Event → row state → rendered line
// ---------------------------------------------------------------------------

test("running row shows latest command snippet", () => {
	const { dashboard, emit } = makeDashboard();
	emit({ type: "node-start", nodeId: "a" });
	emit({ type: "snippet", nodeId: "a", snippet: { toolName: "bash", args: { command: "ls src/" } } });
	emit({ type: "snippet", nodeId: "a", snippet: { toolName: "read", args: { path: "src/foo.ts", offset: 10, limit: 30 } } });
	const lines = dashboard.render(W);
	const row = lines.find((l) => l.includes("Alpha"))!;
	assert.ok(row.includes("▶"), row);
	assert.ok(row.includes("read") && row.includes("src/foo.ts"), row);
	assert.ok(row.includes("src/foo.ts:10-39"), row);
	assert.ok(!row.includes("ls src/"), "only the latest snippet should be shown");
});

test("done row shows checkmark and duration", () => {
	const { dashboard, emit } = makeDashboard();
	emit({ type: "node-start", nodeId: "a" });
	emit({
		type: "node-end",
		nodeId: "a",
		result: result({ id: "a", status: "done", startedAt: 0, finishedAt: 14200, output: "ok" }),
	});
	const lines = dashboard.render(W);
	const row = lines.find((l) => l.includes("Alpha"))!;
	assert.ok(row.includes("✓"), row);
	assert.ok(row.includes("14.2s"), row);
	assert.ok(lines[0].includes("1/2 done, 0 running, 1 pending"), lines[0]);
});

test("failed, skipped and aborted rows render with their icons", () => {
	const h = makeDashboard();
	h.emit({
		type: "node-end",
		nodeId: "a",
		result: result({ id: "a", status: "failed", error: "boom" }),
	});
	// b still pending → run not finished → in-flight failure note is shown
	let lines = h.dashboard.render(W);
	assert.ok(lines.find((l) => l.includes("Alpha")!)?.includes("✗"), lines.join("\n"));
	assert.ok(lines.some((l) => l.includes("1 failed — dependent nodes will be skipped")), lines.join("\n"));

	h.emit({ type: "node-end", nodeId: "b", result: result({ id: "b", status: "skipped", skipReason: "dependency a failed" }) });
	lines = h.dashboard.render(W);
	assert.ok(lines.find((l) => l.includes("Beta")!)?.includes("⊘"), lines.join("\n"));
	// all nodes terminal → finished header replaces the in-flight failure note
	assert.ok(lines[0].includes("DAG runner — finished"), lines[0]);
	assert.ok(!lines.some((l) => l.includes("dependent nodes will be skipped")));

	const h2 = makeDashboard();
	h2.emit({ type: "node-end", nodeId: "a", result: result({ id: "a", status: "aborted" }) });
	h2.emit({ type: "node-end", nodeId: "b", result: result({ id: "b", status: "aborted" }) });
	const lines2 = h2.dashboard.render(W);
	assert.ok(lines2.filter((l) => l.includes("■")).length === 2, lines2.join("\n"));
});

test("header switches to finished once every node is terminal", () => {
	const { dashboard, emit } = makeDashboard();
	emit({ type: "node-end", nodeId: "a", result: result({ id: "a", status: "done" }) });
	assert.ok(dashboard.render(W)[0].includes("1/2 done"), "not finished yet");
	emit({ type: "node-end", nodeId: "b", result: result({ id: "b", status: "failed", error: "x" }) });
	const header = dashboard.render(W)[0];
	assert.ok(header.includes("DAG runner — finished"), header);
	// finished header suppresses the in-flight failure note
	assert.ok(!dashboard.render(W).some((l) => l.includes("dependent nodes will be skipped")));
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

test("Escape triggers onAbort; other keys are ignored", () => {
	const h = makeDashboard();
	h.dashboard.handleInput("x");
	assert.equal(h.aborts, 0);
	h.dashboard.handleInput("\x1b");
	assert.equal(h.aborts, 1);
});

// ---------------------------------------------------------------------------
// reportExcerpt
// ---------------------------------------------------------------------------

test("reportExcerpt: first non-empty line of the node output", () => {
	assert.equal(
		reportExcerpt(result({ id: "a", status: "done", output: "\n\nDid the thing.\nMore detail." })),
		"Did the thing.",
	);
});

test("reportExcerpt: failed nodes prefer the error line; empty when nothing to show", () => {
	assert.equal(
		reportExcerpt(result({ id: "a", status: "failed", output: "partial", error: "boom: line1\nline2" })),
		"boom: line1",
	);
	assert.equal(reportExcerpt(result({ id: "a", status: "failed", error: "boom" })), "boom");
	assert.equal(reportExcerpt(result({ id: "a", status: "done" })), "");
	assert.equal(reportExcerpt(result({ id: "a", status: "skipped", skipReason: "x" })), "");
});

test("reportExcerpt: truncated to maxChars with ellipsis", () => {
	const out = reportExcerpt(result({ id: "a", status: "done", output: "x".repeat(300) }), 200);
	assert.equal(out.length, 201);
	assert.ok(out.endsWith("…"), out);
});

// ---------------------------------------------------------------------------
// renderPlanSummary
// ---------------------------------------------------------------------------

/** Build a message in the shape index.ts sends (content + details). */
function summaryMessage(results: NodeResult[], details?: unknown) {
	const lines = ["DAG run completed — all steps succeeded."];
	for (const r of results) {
		lines.push(`${r.id} — ${r.title}`);
		if (r.status === "skipped" && r.skipReason) lines.push(`    ${r.skipReason}`);
		else {
			const ex = reportExcerpt(r);
			if (ex) lines.push(`    ${ex}`);
		}
	}
	lines.push("", "Totals: 1.0s · plan: ~/.agents/plans/x.md");
	return {
		content: lines.join("\n"),
		details: details ?? {
			planPath: "/home/u/.agents/plans/x.md",
			status: "completed",
			succeeded: results.length,
			failed: 0,
			skipped: 0,
			durationMs: 1000,
			usage: emptyUsage(),
			results: results.map((r) => ({ ...r, snippets: [] })),
		},
	};
}

test("renderPlanSummary collapsed: content as sent + Ctrl+O hint, no full reports", () => {
	const msg = summaryMessage([
		result({ id: "a", status: "done", output: "Did the thing.\nMore detail here" }),
		result({ id: "b", status: "skipped", skipReason: "dependency a failed" }),
	]);
	const comp = renderPlanSummary(msg as never, { expanded: false, outputPad: 0 }, theme);
	const text = comp.render(W).join("\n");
	assert.ok(text.includes("DAG run completed"), text);
	assert.ok(text.includes("Did the thing."), "excerpt line from content");
	assert.ok(text.includes("(Ctrl+O: full reports)"), text);
	assert.ok(!text.includes("More detail here"), "collapsed must not show full reports");
});

test("renderPlanSummary expanded: full reports, plan path, totals; no hint", () => {
	const msg = summaryMessage([
		result({ id: "a", status: "done", output: "Did the thing.\nMore detail here" }),
		result({ id: "b", status: "skipped", skipReason: "dependency a failed" }),
	]);
	const comp = renderPlanSummary(msg as never, { expanded: true, outputPad: 0 }, theme);
	const text = comp.render(W).join("\n");
	assert.ok(text.includes("More detail here"), "expanded shows the full report");
	assert.ok(text.includes("~/.agents/plans/x.md"), "plan path shortened to ~");
	assert.ok(text.includes("dependency a failed"), text);
	assert.ok(text.includes("Totals:"), text);
	assert.ok(!text.includes("(Ctrl+O: full reports)"), text);
});

test("renderPlanSummary falls back to plain content without details", () => {
	const comp = renderPlanSummary(
		{ content: "DAG run completed — plain" } as never,
		{ expanded: false, outputPad: 0 },
		theme,
	);
	assert.ok(comp.render(W).join("\n").includes("DAG run completed — plain"));
});
