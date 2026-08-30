/**
 * UI: plan message renderer, per-node transcript card renderer, the live
 * RunDashboard component, and command-snippet formatting.
 */

import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Key,
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { topologicalLevels } from "./dag.ts";
import type { DagNode, DagPlan, NodeResult, NodeStatus, ToolSnippet, UsageStats } from "./types.ts";

// ---------------------------------------------------------------------------
// Formatting helpers (shared with plans.ts / index.ts)
// ---------------------------------------------------------------------------

export function formatDuration(ms?: number): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const m = Math.floor(sec / 60);
	const s = Math.round(sec % 60);
	if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${(m % 60).toString().padStart(2, "0")}m`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…`;
}

/**
 * One-line excerpt of a node's final report: first non-empty line of its
 * output (the error for failed nodes). Shared by the plan file's Results
 * table and the post-run summary message so both stay in sync.
 */
export function reportExcerpt(result: NodeResult, maxChars = 200): string {
	const source = result.status === "failed" ? (result.error ?? result.output) : result.output;
	const firstLine = (source ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
	return firstLine ? truncate(firstLine, maxChars) : "";
}

/** Shorten absolute home paths to ~… for display. */
export function shortenHome(p: string): string {
	const home = process.env.HOME ?? "";
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

/**
 * Single-cell, non-emoji glyph per node status. All glyphs are 1 cell wide in
 * every terminal (no RGI emoji / default-emoji-presentation codepoints), so
 * the icon column stays aligned and width math in pi-tui matches reality.
 */
export function statusIcon(status: NodeStatus): string {
	switch (status) {
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "skipped":
			return "⊘";
		case "aborted":
			return "■";
		case "running":
			return "▶";
		default: // pending
			return "○";
	}
}

/** Theme color per node status — single source of truth for dashboard + cards. */
export function statusColor(status: NodeStatus): ThemeColor {
	switch (status) {
		case "done":
			return "success";
		case "failed":
			return "error";
		case "running":
		case "aborted":
			return "warning";
		default: // pending, skipped
			return "dim";
	}
}

/** Plain-text command snippet (for the markdown plan file). */
export function formatSnippetPlain(toolName: string, args: Record<string, unknown>): string {
	const path = (args.file_path ?? args.path ?? args.pattern ?? ".") as string;
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			return `$ ${truncate(command.replace(/\s+/g, " ").trim(), 60)}`;
		}
		case "read": {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = `read ${path}`;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += `:${start}${end ? `-${end}` : ""}`;
			}
			return text;
		}
		case "write": {
			const lines = ((args.content as string) || "").split("\n").length;
			return `write ${path}${lines > 1 ? ` (${lines} lines)` : ""}`;
		}
		case "edit":
			return `edit ${path}`;
		case "ls":
			return `ls ${path}`;
		case "find":
			return `find /${args.pattern ?? "*"}/ in ${path}`;
		case "grep":
			return `grep /${args.pattern ?? ""}/ in ${path}`;
		default: {
			const argsStr = JSON.stringify(args);
			return `${toolName} ${truncate(argsStr, 50)}`;
		}
	}
}

/** Themed command snippet (for the TUI). */
export function formatSnippet(toolName: string, args: Record<string, unknown>, fg: (color: ThemeColor, text: string) => string): string {
	const path = (args.file_path ?? args.path ?? args.pattern ?? ".") as string;
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			return fg("muted", "$ ") + fg("toolOutput", truncate(command.replace(/\s+/g, " ").trim(), 60));
		}
		case "read": {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = fg("accent", shortenHome(path));
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const lines = ((args.content as string) || "").split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenHome(path));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenHome(path));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenHome(path));
		case "find":
			return fg("muted", "find ") + fg("accent", `/${args.pattern ?? "*"}/`) + fg("dim", ` in ${shortenHome(path)}`);
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${args.pattern ?? ""}/`) + fg("dim", ` in ${shortenHome(path)}`);
		default: {
			const argsStr = JSON.stringify(args);
			return fg("accent", toolName) + fg("dim", ` ${truncate(argsStr, 50)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Plan message renderer (custom message "dag-plan")
// ---------------------------------------------------------------------------

export interface DagPlanDetails {
	plan: DagPlan;
	planPath: string;
}

export function renderPlanMessage(
	message: { content: string | ReadonlyArray<unknown>; details?: unknown },
	{ expanded, outputPad }: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const box = new Box(outputPad, 1, (t: string) => theme.bg("customMessageBg", t));
	const details = message.details as DagPlanDetails | undefined;
	const contentText =
		typeof message.content === "string"
			? message.content
			: message.content.map((c) => (c as { text?: string }).text ?? "").join("");
	if (!details?.plan) {
		box.addChild(new Text(contentText, 0, 0));
		return box;
	}

	const { plan, planPath } = details;
	const lines: string[] = [];
	lines.push(theme.fg("accent", theme.bold(`DAG Plan — ${plan.steps.length} steps`)));
	lines.push(theme.fg("dim", plan.goal));

	let waves: DagNode[][];
	try {
		waves = topologicalLevels(plan.steps);
	} catch {
		waves = [plan.steps];
	}
	lines.push(theme.fg("dim", `${waves.length} wave${waves.length > 1 ? "s" : ""}`));

	const maxIdLen = Math.max(0, ...plan.steps.map((s) => s.id.length));
	waves.forEach((wave, i) => {
		const last = i === waves.length - 1;
		lines.push(theme.fg("muted", `${last ? "└" : "├"}─ wave ${i + 1}${wave.length > 1 ? " (parallel)" : ""}`));
		for (const node of wave) {
			const deps = node.dependsOn.length > 0 ? theme.fg("dim", `  (← ${node.dependsOn.join(", ")})`) : "";
			lines.push(`  ${theme.fg("muted", "●")} ${theme.fg("toolTitle", node.id.padEnd(maxIdLen))}  ${node.title}${deps}`);
		}
	});

	if (expanded) {
		lines.push("");
		lines.push(theme.fg("muted", "── Step prompts ──"));
		for (const s of plan.steps) {
			lines.push(`${theme.fg("toolTitle", s.id)} ${theme.fg("muted", "—")} ${s.title}`);
			lines.push(theme.fg("dim", `  ${truncate((s.prompt.split("\n")[0] ?? "").trim(), 160)}`));
		}
		lines.push("");
		lines.push(theme.fg("muted", "── Plan (JSON) ──"));
		lines.push(theme.fg("mdCodeBlock", JSON.stringify(plan, null, 2)));
	} else {
		lines.push("");
		lines.push(theme.fg("dim", `Plan saved: ${shortenHome(planPath)}   (Ctrl+O: JSON)`));
	}

	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
}

// ---------------------------------------------------------------------------
// Post-run summary message renderer (custom message "dag-plan-summary")
// ---------------------------------------------------------------------------

/**
 * Details payload of the dag-plan-summary message. `results` carry the full
 * per-node reports for the expanded view only — the LLM never sees details,
 * so this costs no context. Snippets are omitted (they live in the per-node
 * "dag-node" entries; avoid duplicating bulky data in the session file).
 */
export interface DagPlanSummaryDetails {
	planPath: string;
	status: string;
	succeeded: number;
	failed: number;
	skipped: number;
	durationMs: number;
	usage: UsageStats;
	results: NodeResult[];
}

/** Full-report cap for the expanded view (matches the plan file's cap). */
const SUMMARY_REPORT_CAP = 50 * 1024;

/**
 * Collapsed: the summary text as sent (header + per-node line + excerpt +
 * totals) plus a Ctrl+O hint. Expanded: each node's full report rendered as
 * markdown, with plan path and totals.
 */
export function renderPlanSummary(
	message: { content: string | ReadonlyArray<unknown>; details?: unknown },
	{ expanded, outputPad }: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const details = message.details as DagPlanSummaryDetails | undefined;
	const contentText =
		typeof message.content === "string"
			? message.content
			: message.content.map((c) => (c as { text?: string }).text ?? "").join("");
	const contentLines = contentText.split("\n");
	const header = contentLines[0] ?? "DAG run";
	const totalsLine = [...contentLines].reverse().find((l) => l.startsWith("Totals:")) ?? "";

	const box = new Box(outputPad, 1, (t: string) => theme.bg("customMessageBg", t));

	if (!details?.results?.length) {
		// No structured details (e.g. a session from before this renderer):
		// fall back to the plain content.
		box.addChild(new Text(contentText, 0, 0));
		return box;
	}

	const container = new Container();

	if (expanded) {
		container.addChild(new Text(theme.fg("accent", theme.bold(header)), 0, 0));
		container.addChild(new Text(theme.fg("dim", `plan: ${shortenHome(details.planPath)}`), 0, 0));
		for (const r of details.results) {
			container.addChild(new Text("", 0, 0));
			const dur =
				r.startedAt !== undefined && r.finishedAt !== undefined ? formatDuration(r.finishedAt - r.startedAt) : "";
			const usage = formatUsageStats(r.usage, r.model);
			const meta = [dur, usage].filter(Boolean).join("  ");
			const head =
				`${theme.fg(statusColor(r.status), statusIcon(r.status))} ${theme.fg("toolTitle", theme.bold(r.id))}  ${r.title}` +
				(meta ? theme.fg("muted", `  ${meta}`) : "");
			container.addChild(new Text(head, 0, 0));
			if (r.status === "skipped") {
				container.addChild(new Text(theme.fg("dim", r.skipReason ?? "dependency did not complete"), 0, 0));
			} else if (r.status === "aborted") {
				container.addChild(new Text(theme.fg("dim", "aborted before completion"), 0, 0));
			} else {
				if (r.error) container.addChild(new Text(theme.fg("error", truncate(r.error, SUMMARY_REPORT_CAP)), 0, 0));
				container.addChild(new Markdown(truncate(r.output || "(no output)", SUMMARY_REPORT_CAP), 0, 0, getMarkdownTheme()));
			}
		}
		if (totalsLine) {
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("dim", totalsLine), 0, 0));
		}
		box.addChild(container);
		return box;
	}

	// Collapsed: summary content as sent, header themed, Ctrl+O hint.
	container.addChild(new Text(theme.fg("accent", theme.bold(header)), 0, 0));
	for (const l of contentLines.slice(1)) {
		if (l) container.addChild(new Text(l, 0, 0));
	}
	const hasReports = details.results.some((r) => (r.output ?? "").length > 0 || r.error);
	if (hasReports) container.addChild(new Text(theme.fg("dim", "(Ctrl+O: full reports)"), 0, 0));
	box.addChild(container);
	return box;
}

// ---------------------------------------------------------------------------
// Per-node transcript card (custom entry "dag-node")
// ---------------------------------------------------------------------------

export function renderNodeCard(
	entry: { data?: unknown },
	{ expanded }: { expanded: boolean },
	theme: Theme,
): Component {
	const data = entry.data as NodeResult | undefined;
	if (!data) return new Text(theme.fg("muted", "(no node data)"), 0, 0);

	const container = new Container();
	const icon = theme.fg(statusColor(data.status), statusIcon(data.status));
	const dur = data.startedAt !== undefined && data.finishedAt !== undefined ? formatDuration(data.finishedAt - data.startedAt) : "";
	let head = `${icon} ${theme.fg("toolTitle", theme.bold(data.id))}  ${data.title}`;
	if (dur) head += theme.fg("muted", `  ${dur}`);
	container.addChild(new Text(head, 0, 0));

	const snippets = expanded ? data.snippets : data.snippets.slice(-4);
	for (const s of snippets) {
		container.addChild(new Text(theme.fg("muted", "→ ") + formatSnippet(s.toolName, s.args, theme.fg.bind(theme)), 0, 0));
	}
	if (!expanded && data.snippets.length > 4) {
		container.addChild(new Text(theme.fg("dim", `… ${data.snippets.length - 4} earlier`), 0, 0));
	}

	if (data.status === "skipped" && data.skipReason) {
		container.addChild(new Text(theme.fg("dim", data.skipReason), 0, 0));
	}
	if ((data.status === "failed" || data.status === "aborted") && data.error) {
		container.addChild(new Text(theme.fg("error", truncate(data.error.split("\n")[0] ?? "", 300)), 0, 0));
	}

	if (data.output) {
		if (expanded) {
			container.addChild(new Markdown(truncate(data.output, 50 * 1024), 0, 0, getMarkdownTheme()));
		} else {
			const brief = data.output.split("\n").slice(0, 3).join("\n");
			container.addChild(new Text(theme.fg("toolOutput", truncate(brief, 400)), 0, 0));
		}
	}

	const usageLine = formatUsageStats(data.usage, data.model);
	if (usageLine) container.addChild(new Text(theme.fg("dim", usageLine), 0, 0));
	if (!expanded && (data.output.length > 300 || data.snippets.length > 4)) {
		container.addChild(new Text(theme.fg("dim", "(Ctrl+O: full output)"), 0, 0));
	}
	return container;
}

// ---------------------------------------------------------------------------
// RunDashboard — live view shown (in place of the editor) during execution
// ---------------------------------------------------------------------------

interface DashboardRow {
	status: NodeStatus;
	snippet?: ToolSnippet;
	startedAt?: number;
	finishedAt?: number;
}

export class RunDashboard implements Component {
	private rows = new Map<string, DashboardRow>();
	private finished = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	/**
	 * @param plan      the plan being executed (row order = plan order)
	 * @param theme     pi theme for rendering
	 * @param onAbort   called when the user hits Escape
	 * @param onRender  called after every state change; the host must forward
	 *                  this to `tui.requestRender()` because pi-tui only
	 *                  repaints when explicitly asked (no periodic frames)
	 */
	constructor(
		private plan: DagPlan,
		private theme: Theme,
		private onAbort: () => void,
		private onRender: () => void,
	) {
		for (const node of plan.steps) this.rows.set(node.id, { status: "pending" });
	}

	/** Update state from an executor event; safe to call from any thread context. */
	update(event: { type: string; nodeId?: string; snippet?: ToolSnippet; result?: NodeResult }): void {
		const row = event.nodeId ? this.rows.get(event.nodeId) : undefined;
		if (!row) return;
		if (event.type === "node-start") {
			row.status = "running";
			row.startedAt = Date.now();
		} else if (event.type === "snippet" && event.snippet) {
			row.snippet = event.snippet;
		} else if (event.type === "node-end" && event.result) {
			row.status = event.result.status;
			row.startedAt = event.result.startedAt ?? row.startedAt;
			row.finishedAt = event.result.finishedAt ?? Date.now();
			if (event.result.snippets.length > 0) row.snippet = event.result.snippets[event.result.snippets.length - 1];
		}
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		const allTerminal = [...this.rows.values()].every((r) =>
			["done", "failed", "skipped", "aborted"].includes(r.status),
		);
		if (allTerminal) this.finished = true;
		this.onRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) this.onAbort();
		// All other keys are ignored; the dashboard is not editable.
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = this.renderLines(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderLines(width: number): string[] {
		const t = this.theme;
		const total = this.plan.steps.length;
		let done = 0,
			running = 0,
			pending = 0,
			failed = 0;
		for (const row of this.rows.values()) {
			if (row.status === "done") done++;
			else if (row.status === "running") running++;
			else if (row.status === "failed") failed++;
			else if (row.status === "pending") pending++;
		}

		const lines: string[] = [];
		const header = this.finished
			? t.fg("accent", t.bold("DAG runner — finished"))
			: `${t.fg("accent", t.bold("DAG runner"))} ${t.fg("muted", `— ${done}/${total} done, ${running} running, ${pending} pending`)} ${t.fg("dim", "(esc: cancel)")}`;
		lines.push(truncateToWidth(header, width, ""));

		const maxIdLen = Math.max(0, ...this.plan.steps.map((s) => s.id.length));
		for (const node of this.plan.steps) {
			const row = this.rows.get(node.id)!;
			const glyph = t.fg(statusColor(row.status), statusIcon(row.status));
			const id = t.fg("toolTitle", t.bold(node.id.padEnd(maxIdLen)));
			let line: string;
			switch (row.status) {
				case "running": {
					const snippet = row.snippet ? t.fg("muted", "→ ") + formatSnippet(row.snippet.toolName, row.snippet.args, t.fg.bind(t)) : t.fg("dim", "…");
					line = `${glyph} ${id}  ${node.title}  ${snippet}`;
					break;
				}
				case "done": {
					const dur = row.startedAt !== undefined && row.finishedAt !== undefined ? formatDuration(row.finishedAt - row.startedAt) : "";
					line = `${glyph} ${id}  ${node.title}${dur ? t.fg("muted", `  ${dur}`) : ""}`;
					break;
				}
				case "failed":
					line = `${glyph} ${id}  ${node.title}`;
					break;
				case "skipped":
					line = `${glyph} ${id}  ${t.fg("dim", `${node.title} (skipped)`)}`;
					break;
				case "aborted":
					line = `${glyph} ${id}  ${t.fg("dim", `${node.title} (aborted)`)}`;
					break;
				default: {
					const waiting = node.dependsOn.filter((d) => {
						const dep = this.rows.get(d);
						return dep && (dep.status === "pending" || dep.status === "running");
					});
					const wait = waiting.length > 0 ? t.fg("dim", `  (waiting: ${waiting.join(", ")})`) : "";
					line = `${glyph} ${id}  ${t.fg("dim", node.title)}${wait}`;
				}
			}
			lines.push(truncateToWidth(line, width, "…"));
		}
		if (failed > 0 && !this.finished) {
			lines.push(truncateToWidth(t.fg("warning", `${failed} failed — dependent nodes will be skipped`), width, ""));
		}
		return lines;
	}
}
