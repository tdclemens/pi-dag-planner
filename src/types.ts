/**
 * Shared types for the /dag-plan extension.
 */

/** One node (step) of the DAG plan. */
export interface DagNode {
	/** Unique kebab/snake id, e.g. "s1" or "analyze-repo". */
	id: string;
	/** Short human label for UI. */
	title: string;
	/** Self-contained task instructions for the subagent executing this node. */
	prompt: string;
	/** ids of prerequisite nodes; [] = can run first. */
	dependsOn: string[];
	/** Optional per-node tool allowlist, passed to the subagent as --tools. */
	tools?: string[];
	/**
	 * Files (relative to the repo root) and named shared resources this step
	 * creates or modifies, e.g. "src/app.ts", "package-lock.json",
	 * "ports:3000". The executor serializes steps whose touches overlap; the
	 * planner keeps them disjoint for parallel steps (validatePlan warns
	 * otherwise). Read-only steps omit it (or use []).
	 */
	touches?: string[];
}

/** The plan produced by the planner (and embedded in the saved markdown). */
export interface DagPlan {
	goal: string;
	steps: DagNode[];
}

/**
 * Result of validating a plan (schema + graph rules). `ok: true` may carry
 * non-fatal warnings (e.g. unordered `touches` overlap that the executor
 * will serialize at run time).
 */
export type PlanValidation = { ok: true; warnings?: string[] } | { ok: false; error: string };

export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped" | "aborted";

/** Per-node (and aggregate) token/cost accounting. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function addUsage(a: UsageStats, b: UsageStats): UsageStats {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		contextTokens: Math.max(a.contextTokens, b.contextTokens),
		turns: a.turns + b.turns,
	};
}

/** A single tool invocation observed in a subagent run (for live snippets). */
export interface ToolSnippet {
	toolName: string;
	args: Record<string, unknown>;
}

/**
 * Why a node failed.
 * - `"transient"` — infrastructure hiccup (subprocess crash, model/API error,
 *   output truncation, empty response). The executor auto-retries these.
 * - `"task"` — the agent finished its turn and reported that the step's goal
 *   was not achieved (trailing `STATUS: failure` line). Auto-retrying the
 *   same prompt is unlikely to help; the user can re-run via resume.
 */
export type FailureKind = "transient" | "task";

/** The outcome of executing (or not) one DAG node. */
export interface NodeResult {
	id: string;
	title: string;
	status: NodeStatus;
	startedAt?: number;
	finishedAt?: number;
	/** Tool invocations observed during the run (capped). */
	snippets: ToolSnippet[];
	/** Final assistant output; "" for nodes that never ran. */
	output: string;
	/** Error message (model error, stderr excerpt) for failed nodes. */
	error?: string;
	/** How a failed node failed; drives auto-retry (transient) vs give-up (task). */
	failureKind?: FailureKind;
	/** Number of auto-retries performed after failed attempts (0/undefined = none). */
	retries?: number;
	exitCode?: number;
	stopReason?: string;
	/** Why a node was skipped, e.g. "dependency s1 failed". */
	skipReason?: string;
	usage: UsageStats;
	model?: string;
}

/** Result of the planning LLM call. */
export interface PlannerResult {
	plan: DagPlan;
	/** The exact JSON the plan was extracted from (normalized). */
	rawJson: string;
	usage: UsageStats;
}

/** Events emitted by the executor while a plan runs. */
export type DagEvent =
	| { type: "node-start"; nodeId: string }
	| { type: "snippet"; nodeId: string; snippet: ToolSnippet }
	/**
	 * A ready node is held back because a running node holds one of its
	 * declared `touches`. Emitted only when the blocking resource/holder
	 * changes (not every scheduler tick).
	 */
	| { type: "node-blocked"; nodeId: string; resource: string; heldBy: string }
	/**
	 * A failed attempt of a node is being auto-retried (transient failure
	 * only). `attempt` is 1-based (the retry about to start), `maxAttempts` is
	 * the configured retry cap, and `reason` is the previous attempt's error.
	 */
	| { type: "node-retry"; nodeId: string; attempt: number; maxAttempts: number; reason: string }
	| { type: "node-end"; nodeId: string; result: NodeResult }
	/**
	 * A node that already completed in a prior (interrupted) run and was
	 * restored from the run-state sidecar at resume time. The dashboard shows
	 * it as done; unlike node-end the host does not append a transcript entry
	 * for it.
	 */
	| { type: "node-restored"; nodeId: string; result: NodeResult };
