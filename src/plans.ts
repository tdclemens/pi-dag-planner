/**
 * ~/.agents/plans/ persistence: markdown plan files with embedded JSON and a
 * post-execution Results section. All writes are serialized through a promise
 * chain in this module (extension-owned, no file-mutation queue needed).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { topologicalLevels } from "./dag.ts";
import type { DagPlan, NodeResult } from "./types.ts";
import { formatDuration, reportExcerpt, shortenHome, statusIcon, truncate } from "./ui.ts";

/** Fixed user-chosen location (not pi's config dir). */
export const PLANS_DIR = path.join(os.homedir(), ".agents", "plans");

let writeChain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
	const run = writeChain.then(fn, fn);
	writeChain = run.catch(() => undefined);
	return run;
}

export function slugify(goal: string): string {
	const words = goal
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.slice(0, 4);
	return words.join("-") || "plan";
}

/** YYYYMMDD-HHMMSS in local time. */
export function planTimestamp(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Timestamped filename with a -2 suffix on collision. */
export function planFileName(goal: string, d: Date = new Date(), dir: string = PLANS_DIR): string {
	const base = `${planTimestamp(d)}-${slugify(goal)}`;
	let name = `${base}.md`;
	if (fs.existsSync(path.join(dir, name))) name = `${base}-2.md`;
	if (fs.existsSync(path.join(dir, name))) name = `${base}-3.md`;
	return name;
}

export type PlanFileStatus = "pending" | "executing" | "completed" | "completed-with-failures" | "aborted";

/** Render the full plan markdown (header, steps list, embedded JSON). */
export function renderPlanMarkdown(plan: DagPlan, rawPrompt: string, status: PlanFileStatus): string {
	let waveDesc: string;
	try {
		waveDesc = topologicalLevels(plan.steps)
			.map((w) => (w.length > 1 ? `${w.length} parallel` : "1"))
			.join(" + ");
	} catch {
		waveDesc = "?";
	}
	const lines: string[] = [];
	lines.push(`# DAG Plan: ${plan.goal}`, "");
	lines.push(`- **Created:** ${new Date().toISOString()}`);
	lines.push(`- **Status:** ${status}`);
	lines.push(`- **Prompt:** ${rawPrompt}`);
	lines.push(`- **Steps:** ${plan.steps.length} (waves: ${waveDesc})`);
	lines.push("", "## Steps", "");
	plan.steps.forEach((s, i) => {
		lines.push(`${i + 1}. **${s.id}** — ${s.title} — deps: ${s.dependsOn.length > 0 ? s.dependsOn.join(", ") : "—"}`);
	});
	lines.push("", "## Plan (JSON)", "", "```json", JSON.stringify(plan, null, 2), "```", "");
	return lines.join("\n");
}

/** Save a new plan file; returns its path. */
export async function savePlan(plan: DagPlan, rawPrompt: string): Promise<string> {
	return enqueue(async () => {
		await fs.promises.mkdir(PLANS_DIR, { recursive: true });
		const file = path.join(PLANS_DIR, planFileName(plan.goal));
		await fs.promises.writeFile(file, renderPlanMarkdown(plan, rawPrompt, "pending"), "utf8");
		return file;
	});
}

export interface RunTotals {
	status: Exclude<PlanFileStatus, "pending" | "executing">;
	succeeded: number;
	failed: number;
	cost: number;
	durationMs: number;
}

function tableEscape(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Append (or replace) the `## Results` section and flip the Status line of a
 * saved plan file. Final node outputs are stored up to ~50KB each.
 */
export async function appendResults(planPath: string, results: NodeResult[], totals: RunTotals): Promise<void> {
	await enqueue(async () => {
		let existing = "";
		try {
			existing = await fs.promises.readFile(planPath, "utf8");
		} catch {
			/* plan file missing — recreate a minimal header */
			existing = "";
		}
		existing = existing.replace(/\n?## Results[\s\S]*$/, "");
		existing = existing.replace(/^(- \*\*Status:\*\* ).*$/m, `$1${totals.status}`);

		const rows: string[] = [
			"## Results",
			"",
			"| node | status | duration | output excerpt |",
			"|------|--------|----------|----------------|",
		];
		for (const r of results) {
			const dur = r.startedAt !== undefined && r.finishedAt !== undefined ? formatDuration(r.finishedAt - r.startedAt) : "—";
			const excerpt = reportExcerpt(r);
			rows.push(`| ${r.id} | ${statusIcon(r.status)} ${r.status} | ${dur} | ${excerpt ? tableEscape(excerpt) : "—"} |`);
		}
		rows.push("");
		rows.push(
			`Totals: ${totals.succeeded}/${results.length} succeeded, ${totals.failed} failed · $${totals.cost.toFixed(4)} · ${formatDuration(totals.durationMs)}`,
		);
		rows.push("", "## Outputs", "");
		for (const r of results) {
			rows.push(`### ${r.id} — ${r.title} (${r.status})`, "");
			if (r.status === "skipped") {
				rows.push(`_skipped: ${r.skipReason ?? "dependency did not complete"}_`, "");
			} else if (r.status === "aborted") {
				rows.push("_aborted before completion_", "");
			} else {
				const out = (r.status === "failed" ? `${r.error ?? ""}\n\n` : "") + (r.output || "(no output)");
				const capped = out.length > 50 * 1024 ? `${out.slice(0, 50 * 1024)}\n\n[truncated]` : out;
				rows.push(capped, "");
			}
			if (r.snippets.length > 0) {
				rows.push("Commands run:");
				for (const s of r.snippets.slice(0, 50)) rows.push(`- ${formatSnippetLine(s.toolName, s.args)}`);
				rows.push("");
			}
		}

		const content = (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") + "\n" + rows.join("\n");
		await fs.promises.writeFile(planPath, content, "utf8");
	});
}

function formatSnippetLine(toolName: string, args: Record<string, unknown>): string {
	// Local plain formatter to avoid a ui.ts cycle if one is ever introduced.
	const p = (args.file_path ?? args.path ?? ".") as string;
	switch (toolName) {
		case "bash":
			return `$ ${truncate(((args.command as string) || "").replace(/\s+/g, " ").trim(), 60)}`;
		case "read":
			return `read ${shortenHome(p)}${typeof args.offset === "number" ? `:${args.offset}` : ""}`;
		case "write":
			return `write ${shortenHome(p)}`;
		case "edit":
			return `edit ${shortenHome(p)}`;
		case "ls":
			return `ls ${shortenHome(p)}`;
		case "grep": {
			const pat = (args.pattern as string) ?? "";
			return `grep /${pat}/ in ${shortenHome(p)}`;
		}
		case "find": {
			const pat = (args.pattern as string) ?? "*";
			return `find ${pat} in ${shortenHome(p)}`;
		}
		default: {
			const argsStr = JSON.stringify(args);
			return `${toolName} ${truncate(argsStr, 50)}`;
		}
	}
}
