/**
 * /dag-plan — plan a DAG of subagent steps and execute it in parallel.
 *
 *   1. Plan:  LLM call (BorderedLoader, cancellable); on invalid JSON retry
 *             once with the error as feedback. Plan saved to ~/.agents/plans/.
 *   2. Gate:  select Execute / Refine (≤3, with feedback) / Reject.
 *   3. Run:   live RunDashboard (custom UI, esc cancels); nodes run as
 *             parallel pi subprocesses; each finished node appends a
 *             "dag-node" transcript entry.
 *   4. Persist: results appended to the plan file + summary message.
 */

import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { runPlan } from "./executor.ts";
import { plan, PLANNER_MAX_ATTEMPTS } from "./planner.ts";
import * as plans from "./plans.ts";
import type { DagEvent, NodeResult, PlannerResult } from "./types.ts";
import { addUsage } from "./types.ts";
import {
	formatDuration,
	formatUsageStats,
	renderNodeCard,
	renderPlanMessage,
	RunDashboard,
	shortenHome,
	statusIcon,
} from "./ui.ts";

const PLAN_MESSAGE_TYPE = "dag-plan";
const NODE_ENTRY_TYPE = "dag-node";
const MAX_REFINE_ATTEMPTS = 3;
const STATUS_KEY = "dag-runner";

type PlanPhaseOutcome = { ok: true; result: PlannerResult } | { ok: false; error: string };

export default function dagPlanExtension(pi: ExtensionAPI): void {
	let activeRun: { abort: () => void } | undefined;

	pi.registerCommand("dag-plan", {
		description: "Plan a DAG of subagent steps, then execute them in parallel",
		handler: async (args, ctx) => {
			try {
				await runDagPlanFlow(args, ctx);
			} catch (e) {
				ctx.ui.notify(`dag-plan error: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	pi.registerMessageRenderer(PLAN_MESSAGE_TYPE, renderPlanMessage);
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

		let prompt = args.trim();
		if (!prompt) {
			const edited = await ctx.ui.editor("DAG plan — describe the task", "");
			if (edited === undefined) return; // editor closed
			prompt = edited.trim();
			if (!prompt) return;
		}

		// ------------------------------------------------------------------
		// Phase 1: plan (initial call + retries on bad JSON / invalid plan)
		// ------------------------------------------------------------------
		let planResult: PlannerResult | undefined;
		let planFeedback: string | undefined;
		let planPriorJson: string | undefined;

		for (let attempt = 1; ; attempt++) {
			if (signal.aborted) return;
			const outcome = await planOnce(ctx, prompt, modelLabel, planFeedback, planPriorJson);
			if (outcome === null) return; // Esc during planning
			if (outcome.ok) {
				planResult = outcome.result;
				break;
			}
			if (attempt >= PLANNER_MAX_ATTEMPTS) {
				ctx.ui.notify(`Could not get a valid plan: ${outcome.error}`, "error");
				return;
			}
			planFeedback = outcome.error;
		}

		const current = await presentPlan(ctx, planResult!, prompt);
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

			const reOutcome = await planOnce(ctx, prompt, modelLabel, fb.trim() || undefined, gate.rawJson);
			if (reOutcome === null) return;
			if (!reOutcome.ok) {
				ctx.ui.notify(`Re-planning failed: ${reOutcome.error}`, "error");
				return;
			}
			const revised = await presentPlan(ctx, reOutcome.result, prompt);
			if (!revised) return;
			gate = revised;
		}

		// ------------------------------------------------------------------
		// Phase 3: execute with the live dashboard
		// ------------------------------------------------------------------
		const { plan: dag, planPath, plannerUsage } = gate;
		const controller = new AbortController();
		activeRun = { abort: () => controller.abort() };
		const runStartedAt = Date.now();
		const totalSteps = dag.steps.length;
		let finishedCount = 0;
		let failedCount = 0;

		ctx.ui.setStatus(STATUS_KEY, `0/${totalSteps} running…`);

		const results: NodeResult[] | undefined = await ctx.ui.custom<NodeResult[] | undefined>((tui, theme, _kb, done) => {
			const dashboard = new RunDashboard(dag, theme, () => controller.abort(), () => tui.requestRender());
			const promise = runPlan(dag, {
				cwd: ctx.cwd,
				model: modelLabel,
				thinkingLevel: ctx.thinkingLevel,
				signal: controller.signal,
				onEvent: (e: DagEvent) => {
					if (e.type === "node-end") {
						finishedCount++;
						if (e.result.status === "failed" || e.result.status === "aborted") failedCount++;
					}
					dashboard.update(e);
					if (e.type === "node-end") {
						pi.appendEntry(NODE_ENTRY_TYPE, { ...e.result });
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
		if (signal.aborted) return;

		// ------------------------------------------------------------------
		// Phase 4: persist results + summary
		// ------------------------------------------------------------------
		const durationMs = Date.now() - runStartedAt;
		const succeeded = results.filter((r) => r.status === "done").length;
		const failed = results.filter((r) => r.status === "failed").length;
		const skipped = results.filter((r) => r.status === "skipped").length;
		const wasAborted = controller.signal.aborted;
		const status = wasAborted ? "aborted" : failed > 0 ? "completed-with-failures" : "completed";

		let totalUsage = plannerUsage;
		for (const r of results) totalUsage = addUsage(totalUsage, r.usage);

		try {
			await plans.appendResults(planPath, results, { status, succeeded, failed, cost: totalUsage.cost, durationMs });
		} catch (e) {
			ctx.ui.notify(`Warning: could not persist results: ${e instanceof Error ? e.message : String(e)}`, "warning");
		}

		const lines: string[] = [];
		lines.push(
			wasAborted
				? `DAG run aborted — ${succeeded}/${totalSteps} steps completed.`
				: failed > 0
					? `DAG run finished with ${failed} failure${failed > 1 ? "s" : ""} — ${succeeded}/${totalSteps} completed, ${skipped} skipped.`
					: `DAG run completed — all ${totalSteps} steps succeeded.`,
		);
		for (const r of results) {
			const dur =
				r.startedAt !== undefined && r.finishedAt !== undefined ? ` ${formatDuration(r.finishedAt - r.startedAt)}` : "";
			const usage = formatUsageStats(r.usage);
			lines.push(`${statusIcon(r.status)} ${r.id} — ${r.title}${dur}${usage ? ` (${usage})` : ""}`);
			if (r.status === "skipped" && r.skipReason) lines.push(`    ${r.skipReason}`);
			if (r.status === "failed" && r.error) lines.push(`    ${r.error.split("\n")[0]}`);
		}
		lines.push("");
		lines.push(`Totals: ${formatDuration(durationMs)} · ${formatUsageStats(totalUsage)} · plan: ${shortenHome(planPath)}`);

		pi.sendMessage({
			customType: "dag-plan-summary",
			content: lines.join("\n"),
			display: true,
			details: {
				planPath,
				status,
				succeeded,
				failed,
				skipped,
				durationMs,
				usage: totalUsage,
			},
		});
	}

	/**
	 * One planner LLM call behind a cancellable loader.
	 * Returns null when aborted (Esc / session), otherwise a tagged outcome.
	 */
	function planOnce(
		ctx: ExtensionCommandContext,
		prompt: string,
		modelLabel: string,
		feedback: string | undefined,
		priorJson: string | undefined,
	): Promise<PlanPhaseOutcome | null> {
		return ctx.ui.custom<PlanPhaseOutcome | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Planning with ${modelLabel}…`, { cancellable: true });
			loader.onAbort = () => done(null);
			plan(ctx, prompt, { feedback, priorPlanJson: priorJson }, loader.signal)
				.then((r) => done(r ? { ok: true, result: r } : null))
				.catch((e) => done({ ok: false, error: e instanceof Error ? e.message : String(e) }));
			return loader;
		});
	}

	/** Save the plan file and send the friendly plan message. */
	function presentPlan(
		ctx: ExtensionCommandContext,
		result: PlannerResult,
		prompt: string,
	): Promise<{
		plan: PlannerResult["plan"];
		planPath: string;
		rawJson: string;
		plannerUsage: PlannerResult["usage"];
	} | null> {
		return (async () => {
			let planPath: string;
			try {
				planPath = await plans.savePlan(result.plan, prompt);
			} catch (e) {
				ctx.ui.notify(`Failed to save plan file: ${e instanceof Error ? e.message : String(e)}`, "error");
				return null;
			}
			if (ctx.signal?.aborted) return null;
			pi.sendMessage({
				customType: PLAN_MESSAGE_TYPE,
				content: `DAG Plan — ${result.plan.goal} (${result.plan.steps.length} steps)`,
				display: true,
				details: { plan: result.plan, planPath },
			});
			return { plan: result.plan, planPath, rawJson: result.rawJson, plannerUsage: result.usage };
		})();
	}
}
