/**
 * /dag-plan — plan a DAG of subagent steps and execute it in parallel.
 *
 *   1. Plan:  LLM call (BorderedLoader, cancellable); on invalid JSON retry
 *             once with the error + the failed raw output as feedback. Plan
 *             saved to ~/.agents/plans/.
 *   2. Gate:  select Execute / Refine (≤3, with feedback) / Reject.
 *   3. Run:   live RunDashboard (custom UI, esc cancels); nodes run as
 *             parallel pi subprocesses; each finished node appends a
 *             "dag-node" transcript entry.
 *   4. Persist: results appended to the plan file + summary message.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runPlan } from "./executor.ts";
import { loadConfig, type DagPlanConfig } from "./config.ts";
import { normalizePlan, plan, plannerExplores, PlanError, planWithRetries, type PlanRetryFailure } from "./planner.ts";
import * as plans from "./plans.ts";
import { validatePlan } from "./dag.ts";
import type { DagEvent, DagPlan, NodeResult, PlannerResult, UsageStats } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";
import {
	formatDuration,
	formatUsageStats,
	renderNodeCard,
	renderPlanMessage,
	renderPlanSummary,
	reportExcerpt,
	RunDashboard,
	shortenHome,
	statusIcon,
} from "./ui.ts";

const PLAN_MESSAGE_TYPE = "dag-plan";
const SUMMARY_MESSAGE_TYPE = "dag-plan-summary";
const NODE_ENTRY_TYPE = "dag-node";
const MAX_REFINE_ATTEMPTS = 3;
const STATUS_KEY = "dag-runner";

export default function dagPlanExtension(pi: ExtensionAPI): void {
	let activeRun: { abort: () => void } | undefined;

	pi.registerCommand("dag-plan", {
		description:
			"Plan a DAG of subagent steps, then execute them in parallel (resume <plan-file>: continue an interrupted run)",
		handler: async (args, ctx) => {
			try {
				const resumeMatch = args.trim().match(/^resume\s+(\S+)/);
				if (resumeMatch) {
					await runResumeFlow(resumeMatch[1], ctx);
					return;
				}
				await runDagPlanFlow(args, ctx);
			} catch (e) {
				ctx.ui.notify(`dag-plan error: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	pi.registerMessageRenderer(PLAN_MESSAGE_TYPE, renderPlanMessage);
	pi.registerMessageRenderer(SUMMARY_MESSAGE_TYPE, renderPlanSummary);
	pi.registerEntryRenderer(NODE_ENTRY_TYPE, renderNodeCard);

	pi.on("session_shutdown", () => {
		activeRun?.abort();
		activeRun = undefined;
	});

	async function runDagPlanFlow(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("/dag-plan requires the interactive TUI.", "error");
			return;
		}
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No model selected (use /model).", "error");
			return;
		}
		const modelLabel = `${model.provider}/${model.id}`;
		// ctx.signal is undefined when the agent is not streaming; use a
		// stand-in so the checks below are uniform (session_shutdown aborts
		// the run via activeRun in that case).
		const signal = ctx.signal ?? new AbortController().signal;

		// Config: ~/.pi/agent/dag-plan.json plus .pi/dag-plan.json for trusted
		// projects (project wins per key). Every option has a default, so a
		// missing file is a no-op; bad values warn and fall back per field.
		const { config, warnings: configWarnings } = loadConfig(ctx.isProjectTrusted() ? ctx.cwd : undefined);
		for (const w of configWarnings) ctx.ui.notify(`dag-plan config: ${w}`, "warning");

		let prompt = args.trim();
		if (!prompt) {
			const edited = await ctx.ui.editor("DAG plan — describe the task", "");
			if (edited === undefined) return; // editor closed
			prompt = edited.trim();
			if (!prompt) return;
		}

		// ------------------------------------------------------------------
		// Phase 1: plan (bounded retries on bad JSON / invalid plan; the
		// failed attempt's raw output is fed back so the retry can see it)
		// ------------------------------------------------------------------
		const planStartedAt = Date.now();
		const planOutcome = await planWithRetries((fb, prior) => planOnce(ctx, prompt, modelLabel, config, fb, prior), {
			isAborted: () => signal.aborted,
		});
		if (!planOutcome.ok) {
			if (!planOutcome.aborted) ctx.ui.notify(`Could not get a valid plan: ${planOutcome.error}`, "error");
			return; // aborted (Esc / session) or retries exhausted
		}
		const planDurationMs = Date.now() - planStartedAt;

		const current = await presentPlan(ctx, planOutcome.result, prompt, planDurationMs);
		if (!current) return;

		// ------------------------------------------------------------------
		// Phase 2: accept gate (Execute / Refine ≤3 / Reject)
		// ------------------------------------------------------------------
		let refineAttempts = 0;
		let gate = current;
		while (true) {
			if (signal.aborted) return;
			const options = ["Execute plan"];
			if (refineAttempts < MAX_REFINE_ATTEMPTS) {
				options.push(`Refine (${refineAttempts}/${MAX_REFINE_ATTEMPTS}) — re-plan with feedback`);
			}
			options.push("Reject plan");
			const choice = await ctx.ui.select("DAG plan — what next?", options);
			if (choice === undefined || choice === "Reject plan" || signal.aborted) {
				ctx.ui.notify(`Plan rejected. Saved at ${shortenHome(gate.planPath)}`, "info");
				return;
			}
			if (!choice.startsWith("Refine")) break; // Execute

			const fb = await ctx.ui.input("Feedback for the planner", "e.g. split the refactor into smaller steps");
			if (fb === undefined || signal.aborted) return;
			refineAttempts++;

			const rePlanStartedAt = Date.now();
			const reOutcome = await planWithRetries((f, prior) => planOnce(ctx, prompt, modelLabel, config, f, prior), {
				initialFeedback: fb.trim() || undefined,
				initialPriorJson: gate.rawJson,
				isAborted: () => signal.aborted,
			});
			if (!reOutcome.ok) {
				if (!reOutcome.aborted) ctx.ui.notify(`Re-planning failed: ${reOutcome.error}`, "error");
				return;
			}
			const revised = await presentPlan(ctx, reOutcome.result, prompt, Date.now() - rePlanStartedAt);
			if (!revised) return;
			gate = revised;
		}

		// ------------------------------------------------------------------
		// Phases 3+4: execute with the live dashboard, persist, summarize
		// ------------------------------------------------------------------
		await executePlan(ctx, modelLabel, config, prompt, gate.plan, gate.planPath, gate.plannerUsage, gate.planDurationMs, {}, false);
	}

	/**
	 * Phases 3+4 (shared by the fresh-run flow and /dag-plan resume):
	 * execute the plan with the live dashboard, persist results (plan file +
	 * run-state sidecar), and send the summary message.
	 */
	async function executePlan(
		ctx: ExtensionCommandContext,
		modelLabel: string,
		config: DagPlanConfig,
		originalPrompt: string,
		dag: DagPlan,
		planPath: string,
		plannerUsage: UsageStats,
		planDurationMs: number | undefined,
		initialResults: Record<string, NodeResult>,
		isResume: boolean,
	): Promise<void> {
		const controller = new AbortController();
		activeRun = { abort: () => controller.abort() };
		const runStartedAt = Date.now();
		const totalSteps = dag.steps.length;
		let finishedCount = 0;
		let failedCount = 0;

		// Run-state sidecar (<plan>.run.json): written at start, on every
		// node-end, and at the end, so an interrupted run can be resumed from
		// the last completed node. Mid-run writes are fire-and-forget (a lost
		// write only costs a re-run of that node); the final write is awaited
		// because resume relies on it.
		const runState: plans.RunStateFile = {
			version: 1,
			planPath,
			plan: dag,
			prompt: originalPrompt,
			status: "executing",
			startedAt: runStartedAt,
			updatedAt: runStartedAt,
			results: Object.fromEntries(Object.entries(initialResults).filter(([, r]) => r.status === "done")),
		};
		const persistState = (result?: NodeResult, finalStatus?: plans.PlanFileStatus): Promise<void> => {
			if (result) runState.results[result.id] = result;
			if (finalStatus) runState.status = finalStatus;
			runState.updatedAt = Date.now();
			return plans.saveRunState(runState);
		};
		void persistState().catch(() => {
			ctx.ui.notify("dag-plan: could not write run state — resume will restart from the last saved node", "warning");
		});
		void plans.setPlanFileStatus(planPath, "executing").catch(() => {});

		ctx.ui.setStatus(STATUS_KEY, `0/${totalSteps} running…`);

		const results: NodeResult[] | undefined = await ctx.ui.custom<NodeResult[] | undefined>((tui, theme, keybindings, done) => {
			// While the dashboard is on screen it holds keyboard focus, so the
			// app's Ctrl+O (the app.tools.expand binding, owned by the default
			// editor) never fires. The dashboard matches the key itself; we flip
			// the transcript's expansion so the per-node cards reveal each
			// finished step's full output mid-run.
			const dashboard = new RunDashboard(
				dag,
				theme,
				() => controller.abort(),
				() => tui.requestRender(),
				keybindings,
				() => ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded()),
				() => ctx.ui.getToolsExpanded(),
			);
			const promise = runPlan(dag, {
				cwd: ctx.cwd,
				model: modelLabel,
				thinkingLevel: ctx.thinkingLevel,
				config,
				originalPrompt,
				signal: controller.signal,
				initialResults,
				onEvent: (e: DagEvent) => {
					if (e.type === "node-end" || e.type === "node-restored") {
						finishedCount++;
						if (e.result.status === "failed" || e.result.status === "aborted") failedCount++;
					}
					dashboard.update(e);
					if (e.type === "node-end") {
						pi.appendEntry(NODE_ENTRY_TYPE, { ...e.result });
						void persistState(e.result).catch(() => {});
						ctx.ui.setStatus(STATUS_KEY, `${finishedCount}/${totalSteps}${failedCount > 0 ? " (failures)" : ""}`);
					}
				},
			});
			void promise
				.then((res) => done(res))
				.catch((e) => {
					ctx.ui.notify(`Executor error: ${e instanceof Error ? e.message : String(e)}`, "error");
					done(undefined);
				});
			return dashboard;
		});

		activeRun = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);

		if (!results) {
			ctx.ui.notify("dag-plan run aborted before completion.", "info");
			return;
		}
		if (ctx.signal?.aborted) return;

		// ------------------------------------------------------------------
		// Persist results + summary
		// ------------------------------------------------------------------
		const durationMs = Date.now() - runStartedAt;
		const succeeded = results.filter((r) => r.status === "done").length;
		const failed = results.filter((r) => r.status === "failed").length;
		const skipped = results.filter((r) => r.status === "skipped").length;
		const wasAborted = controller.signal.aborted;
		const status: plans.PlanFileStatus = wasAborted ? "aborted" : failed > 0 ? "completed-with-failures" : "completed";

		try {
			await persistState(undefined, status);
		} catch (e) {
			ctx.ui.notify(`Warning: could not persist run state: ${e instanceof Error ? e.message : String(e)}`, "warning");
		}

		let totalUsage = plannerUsage;
		for (const r of results) totalUsage = addUsage(totalUsage, r.usage);

		try {
			await plans.appendResults(planPath, results, { status, succeeded, failed, cost: totalUsage.cost, durationMs });
		} catch (e) {
			ctx.ui.notify(`Warning: could not persist results: ${e instanceof Error ? e.message : String(e)}`, "warning");
		}

		const resumeTag = isResume ? " (resume)" : "";
		const lines: string[] = [];
		lines.push(
			wasAborted
				? `DAG run${resumeTag} aborted — ${succeeded}/${totalSteps} steps completed.`
				: failed > 0
					? `DAG run${resumeTag} finished with ${failed} failure${failed > 1 ? "s" : ""} — ${succeeded}/${totalSteps} completed, ${skipped} skipped.`
					: `DAG run${resumeTag} completed — all ${totalSteps} steps succeeded.`,
		);
		for (const r of results) {
			const dur =
				r.startedAt !== undefined && r.finishedAt !== undefined ? ` ${formatDuration(r.finishedAt - r.startedAt)}` : "";
			const usage = formatUsageStats(r.usage);
			const retryNote = r.retries ? ` (${r.retries} retry${r.retries > 1 ? "ies" : ""})` : "";
			lines.push(`${statusIcon(r.status)} ${r.id} — ${r.title}${retryNote}${dur}${usage ? ` (${usage})` : ""}`);
			if (r.status === "skipped" && r.skipReason) {
				lines.push(`    ${r.skipReason}`);
			} else {
				const excerpt = reportExcerpt(r);
				if (excerpt) lines.push(`    ${excerpt}`);
			}
		}
		lines.push("");
		const plannedIn = planDurationMs !== undefined ? ` (planned in ${formatDuration(planDurationMs)})` : "";
		lines.push(
			`Totals: ${formatDuration(durationMs)} · ${formatUsageStats(totalUsage)} · plan: ${shortenHome(planPath)}${plannedIn}`,
		);
		if (wasAborted || failed > 0) {
			lines.push(`Resume: /dag-plan resume ${shortenHome(planPath)}`);
		}

		pi.sendMessage({
			customType: SUMMARY_MESSAGE_TYPE,
			content: lines.join("\n"),
			display: true,
			details: {
				planPath,
				status,
				succeeded,
				failed,
				skipped,
				durationMs,
				planDurationMs,
				usage: totalUsage,
				// Full per-node reports for the renderer's expanded view (Ctrl+O).
				// details never reach the LLM; snippets stay in the per-node
				// "dag-node" entries to avoid duplicating bulky data.
				results: results.map((r) => ({ ...r, snippets: [] })),
			},
		});
	}

	/**
	 * /dag-plan resume <plan-file> — continue an interrupted (or failed)
	 * run: load the plan + prior results from the run-state sidecar (falling
	 * back to the plan file's embedded JSON), restore completed nodes, and
	 * execute the rest.
	 */
	async function runResumeFlow(planPathArg: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("/dag-plan requires the interactive TUI.", "error");
			return;
		}
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No model selected (use /model).", "error");
			return;
		}
		const modelLabel = `${model.provider}/${model.id}`;
		const { config, warnings: configWarnings } = loadConfig(ctx.isProjectTrusted() ? ctx.cwd : undefined);
		for (const w of configWarnings) ctx.ui.notify(`dag-plan config: ${w}`, "warning");

		const planPath = resolvePlanPath(planPathArg, ctx.cwd);
		if (!planPath) {
			ctx.ui.notify(`Could not resolve plan file path: ${planPathArg}`, "error");
			return;
		}
		let markdown = "";
		try {
			markdown = await fsp.readFile(planPath, "utf8");
		} catch {
			/* plan file missing — the sidecar alone can still support a resume */
		}

		// Prefer the run-state sidecar (plan + per-node results); fall back
		// to the plan file's embedded JSON (fresh start, no prior results).
		const state = await plans.loadRunState(planPath);
		let plan: DagPlan | null = state ? normalizePlan(state.plan) : null;
		const priorResults: Record<string, NodeResult> = state?.results ?? {};
		if (!plan) plan = plans.extractPlanFromMarkdown(markdown);
		if (!plan) {
			ctx.ui.notify("No valid plan JSON found (expected a saved /dag-plan plan file or its .run.json sidecar).", "error");
			return;
		}
		const originalPrompt =
			typeof state?.prompt === "string" && state.prompt ? state.prompt : plans.extractPromptFromMarkdown(markdown);

		const v = validatePlan(plan, config);
		if (!v.ok) {
			ctx.ui.notify(`Plan in ${shortenHome(planPath)} is invalid: ${v.error}`, "error");
			return;
		}

		// Restore only completed nodes; failed/skipped/aborted are re-run.
		const initialResults: Record<string, NodeResult> = {};
		for (const s of plan.steps) {
			const r = priorResults[s.id];
			if (r && r.status === "done" && typeof r.output === "string") initialResults[s.id] = r;
		}
		const doneCount = Object.keys(initialResults).length;
		const remaining = plan.steps.length - doneCount;
		if (remaining === 0) {
			ctx.ui.notify("All steps are already done — nothing to resume.", "info");
			return;
		}

		pi.sendMessage({
			customType: PLAN_MESSAGE_TYPE,
			content: `DAG Plan (resume) — ${plan.goal} (${plan.steps.length} steps, ${doneCount} done)`,
			display: true,
			details: { plan, planPath, warnings: v.warnings, resume: { done: Object.keys(initialResults) } },
		});

		const choice = await ctx.ui.select(
			`Resume plan — ${remaining} step${remaining > 1 ? "s" : ""} to run (${doneCount} already done)?`,
			["Execute resume", "Cancel"],
		);
		if (choice !== "Execute resume") {
			if (choice !== undefined) ctx.ui.notify("Resume cancelled.", "info");
			return;
		}

		await executePlan(ctx, modelLabel, config, originalPrompt, plan, planPath, emptyUsage(), undefined, initialResults, true);
	}

	/** Resolve a user-supplied plan file path (~ or cwd-relative) to absolute. */
	function resolvePlanPath(arg: string, cwd: string): string | null {
		const p = arg.trim().replace(/^["']|["']$/g, "");
		if (!p) return null;
		if (p.startsWith("~/")) return path.resolve(os.homedir(), p.slice(2));
		return path.resolve(cwd, p);
	}

	/**
	 * One planner LLM call behind a cancellable loader.
	 * Returns null when aborted (Esc / session), the plan on success, or a
	 * failure (with the raw output attached when the planner produced one).
	 */
	function planOnce(
		ctx: ExtensionCommandContext,
		prompt: string,
		modelLabel: string,
		config: DagPlanConfig,
		feedback: string | undefined,
		priorJson: string | undefined,
	): Promise<PlannerResult | PlanRetryFailure | null> {
		return ctx.ui.custom<PlannerResult | PlanRetryFailure | null>((tui, theme, _kb, done) => {
			const label = plannerExplores(config)
				? `Planning with ${modelLabel} (exploring repo)…`
				: `Planning with ${modelLabel}…`;
			const loader = new BorderedLoader(tui, theme, label, { cancellable: true });
			// Planner tool activity renders inside the loader box (not the
			// status bar): a line inserted right after the label, updated in
			// place as the subagent calls read/grep/find/ls. An empty Text
			// renders zero rows, so the box is unchanged until the first
			// snippet arrives.
			const snippetLine = new Text("", 3, 0);
			loader.children.splice(2, 0, snippetLine);
			// Guard: Esc calls done(null) while the (killed) planner subagent may
			// still settle the promise afterwards — done() must run exactly once.
			let settled = false;
			const finish = (outcome: PlannerResult | PlanRetryFailure | null) => {
				if (settled) return;
				settled = true;
				done(outcome);
			};
			loader.onAbort = () => finish(null);
			plan(
				ctx,
				prompt,
				{
					config,
					feedback,
					priorPlanJson: priorJson,
					onExplore: (snippet) => {
						snippetLine.setText(theme.fg("muted", snippet));
						tui.requestRender();
					},
				},
				loader.signal,
			)
				.then((r) => finish(r))
				.catch((e) =>
					finish({
						error: e instanceof Error ? e.message : String(e),
						rawOutput: e instanceof PlanError ? e.rawOutput : undefined,
					}),
				);
			return loader;
		});
	}

	/** Save the plan file and send the friendly plan message. */
	function presentPlan(
		ctx: ExtensionCommandContext,
		result: PlannerResult,
		prompt: string,
		planDurationMs: number,
	): Promise<{
		plan: PlannerResult["plan"];
		planPath: string;
		rawJson: string;
		plannerUsage: PlannerResult["usage"];
		planDurationMs: number;
	} | null> {
		return (async () => {
			let planPath: string;
			try {
				planPath = await plans.savePlan(result.plan, prompt, planDurationMs);
			} catch (e) {
				ctx.ui.notify(`Failed to save plan file: ${e instanceof Error ? e.message : String(e)}`, "error");
				return null;
			}
			if (ctx.signal?.aborted) return null;
			// Non-fatal validation warnings (e.g. unordered touches overlap →
			// implied serialization) are shown with the plan for review.
			const v = validatePlan(result.plan);
			const warnings = v.ok ? v.warnings : undefined;
			pi.sendMessage({
				customType: PLAN_MESSAGE_TYPE,
				content: `DAG Plan — ${result.plan.goal} (${result.plan.steps.length} steps)`,
				display: true,
				details: { plan: result.plan, planPath, planDurationMs, warnings },
			});
			return { plan: result.plan, planPath, rawJson: result.rawJson, plannerUsage: result.usage, planDurationMs };
		})();
	}
}
