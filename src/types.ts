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
}

/** The plan produced by the planner (and embedded in the saved markdown). */
export interface DagPlan {
	goal: string;
	steps: DagNode[];
}

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
	| { type: "node-end"; nodeId: string; result: NodeResult };
