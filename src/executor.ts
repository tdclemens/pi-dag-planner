/**
 * DAG executor: ready-set scheduler with a bounded worker pool, where each
 * node runs as an isolated `pi --mode json -p --no-session` subagent.
 * Failure of a node marks its transitive dependents `skipped`; abort (Esc /
 * session shutdown) kills children and finalizes state.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { dependentsIndex, validatePlan } from "./dag.ts";
import type { DagPlanConfig } from "./config.ts";
import type { DagEvent, DagNode, DagPlan, NodeResult, NodeStatus, UsageStats } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";

export const DEFAULT_MAX_PARALLEL = 4;
/** Default auto-retries per node for transient failures (config "nodeRetries"). */
export const DEFAULT_NODE_RETRIES = 1;
const DEP_OUTPUT_PER_CAP = 8 * 1024;
const DEP_OUTPUT_TOTAL_CAP = 16 * 1024;
const MAX_SNIPPETS = 200;
const KILL_GRACE_MS = 5000;
const STDERR_CAP = 2000;

/**
 * Per-node file-lock extension (src/lock-guard.ts), loaded into every node
 * subagent via `-e` + the DAG_NODE_ID env var. It vetoes writes to files
 * that changed since the node last read them (undeclared overlap safety net;
 * declared overlap is serialized by the touches mutex in runPlan).
 */
const LOCK_GUARD_PATH = fileURLToPath(new URL("./lock-guard.ts", import.meta.url));

/** Concurrency from config "maxParallel" (defaults to DEFAULT_MAX_PARALLEL). */
export function getMaxParallel(config?: DagPlanConfig): number {
	const n = config?.maxParallel;
	if (typeof n === "number" && Number.isInteger(n) && n >= 1) return n;
	return DEFAULT_MAX_PARALLEL;
}

/** Retry cap from config "nodeRetries" (defaults to DEFAULT_NODE_RETRIES). */
export function getMaxRetries(config?: DagPlanConfig): number {
	const n = config?.nodeRetries;
	if (typeof n === "number" && Number.isInteger(n) && n >= 0) return n;
	return DEFAULT_NODE_RETRIES;
}

/**
 * Resolve how to invoke `pi` from within pi (ported from the subagent
 * example): reuse our own entrypoint when we know it, else fall back to `pi`
 * on PATH for generic runtimes.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/**
 * Parse the node status contract out of a final report: the LAST line
 * matching `STATUS: success` or `STATUS: failure — <reason>` (case-
 * insensitive; `—`, `:`, `-` or nothing may separate the kind from the
 * reason). Returns null when the report carries no status line — omission
 * is not a failure (keeps old reports compatible).
 */
export function parseStatusLine(output: string): { kind: "success" | "failure"; reason: string } | null {
	const lines = output.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i]!.trim().match(/^STATUS:\s*(success|failure)\b\s*(?:—|:|-)?\s*(.*)$/i);
		if (m) return { kind: m[1]!.toLowerCase() as "success" | "failure", reason: m[2]!.trim() };
	}
	return null;
}

/** Build the self-contained task prompt for a node, injecting dep outputs. */
export function buildTaskPrompt(
	plan: DagPlan,
	node: DagNode,
	depOutputs: Map<string, string>,
	originalPrompt?: string,
	/** Previous-attempt failure reason for auto-retries (omitted on first attempt). */
	retryNote?: string,
): string {
	const lines: string[] = [
		"You are executing one node of a larger plan. Work autonomously and verify your own output.",
		"",
		`Overall goal: ${plan.goal}`,
	];
	if (originalPrompt && originalPrompt.trim()) {
		lines.push(`Original request (verbatim, from the user): ${originalPrompt.trim()}`);
	}
	lines.push(`Your step: ${node.title}`, "", node.prompt);
	const deps = node.dependsOn.filter((id) => depOutputs.has(id));
	if (deps.length > 0) {
		lines.push("", "Outputs from prerequisite steps (use them, don't redo their work):");
		let total = 0;
		for (const id of deps) {
			const title = plan.steps.find((s) => s.id === id)?.title ?? id;
			let out = depOutputs.get(id) ?? "";
			if (out.length > DEP_OUTPUT_PER_CAP) out = `${out.slice(0, DEP_OUTPUT_PER_CAP)}\n[truncated]`;
			if (total + out.length > DEP_OUTPUT_TOTAL_CAP) {
				const room = Math.max(0, DEP_OUTPUT_TOTAL_CAP - total);
				out = room > 0 ? `${out.slice(0, room)}\n[truncated]` : "[omitted: total dependency budget exceeded]";
			}
			total += out.length;
			lines.push("", `[${id}] ${title}`, out);
		}
	}
	if (retryNote) {
		lines.push(
			"",
			`A previous attempt at this step failed: ${retryNote}`,
			"That attempt may have left partial changes in the repository. Inspect the current state first, keep what is correct, and complete the step from where it left off.",
		);
	}
	lines.push(
		"",
		"Other steps of this plan may be running at the same time in this same repository. If a write or edit is rejected because the file changed since you last read it (DAG file lock), re-read the file and re-apply your change against the fresh content. If the same file keeps conflicting, do the rest of your task and report the conflict instead of retrying it.",
		"",
		"When finished, reply with a concise markdown report: what you did, and the artifacts (file paths, commands, values) that later steps need. End the report with a final line: `STATUS: success` if the step's goal was achieved, or `STATUS: failure — <short reason>` if it was not (for example, tests you were asked to make pass still fail).",
	);
	return lines.join("\n");
}

export interface RunPlanOptions {
	cwd: string;
	/** "provider/model" to pin on subagents (defaults to the dispatching model). */
	model?: string;
	thinkingLevel?: string;
	maxParallel?: number;
	/**
	 * The dag-plan config for this run (defaults apply to anything omitted).
	 * Used for maxParallel, plan validation caps, and runnerExtensions.
	 */
	config?: DagPlanConfig;
	/**
	 * The user's original /dag-plan request, injected verbatim into every node
	 * prompt so subagents see the full request, not just the one-line goal.
	 */
	originalPrompt?: string;
	/**
	 * Resume support: per-node results from a prior (interrupted) run of this
	 * plan. Entries with status "done" are restored — the node is marked done
	 * up front (its dependents start immediately and see its output); every
	 * other status is re-run. Unknown ids are ignored.
	 */
	initialResults?: Record<string, NodeResult>;
	signal: AbortSignal;
	onEvent?: (event: DagEvent) => void;
	/** Test seam: replace the subprocess spawn. */
	spawnImpl?: (command: string, args: string[], cwd: string) => ChildProcess;
}

/**
 * Execute the whole plan. Resolves with one NodeResult per step (in plan
 * order) once every node has ended (done/failed/skipped/aborted).
 *
 * Fails fast — before any subagent is spawned — if the plan does not pass
 * validation (schema shape, known deps, and in particular no cycles):
 * an invalid plan can never continue.
 */
export async function runPlan(plan: DagPlan, opts: RunPlanOptions): Promise<NodeResult[]> {
	const validation = validatePlan(plan, opts.config);
	if (!validation.ok) throw new Error(`refusing to execute plan: ${validation.error}`);

	const steps = plan.steps;
	const maxParallel = Math.max(1, opts.maxParallel ?? getMaxParallel(opts.config));
	const onEvent = opts.onEvent ?? (() => {});
	const dependents = dependentsIndex(steps);

	const status = new Map<string, NodeStatus>(steps.map((s) => [s.id, "pending" as NodeStatus]));
	const results = new Map<string, NodeResult>();
	const doneIds = new Set<string>();
	const running = new Set<Promise<void>>();
	// Declared-resource mutex: resource -> id of the running node holding it.
	// A node holds its declared `touches` for the whole run, so two nodes
	// whose touches overlap never run simultaneously (coarse on purpose — a
	// node holds a file for the entire session, which is predictable and
	// needs no LLM retry loops). Undeclared overlap is caught at write time
	// by the lock-guard extension instead.
	const heldResources = new Map<string, string>();
	// nodeId -> last node-blocked info emitted, so the UI event fires only
	// when the blocking resource/holder changes, not every scheduler tick.
	const blockedInfo = new Map<string, { resource: string; heldBy: string }>();

	// Resume: restore nodes that already completed in a prior run. Only
	// "done" results are honored (failed/aborted/skipped nodes are re-run);
	// ids that no longer exist in the plan are ignored. Restored nodes emit
	// node-restored (not node-end) so the host does not append duplicate
	// transcript entries for them.
	for (const step of steps) {
		const prior = opts.initialResults?.[step.id];
		if (!prior || prior.status !== "done" || typeof prior.output !== "string") continue;
		results.set(step.id, prior);
		status.set(step.id, "done");
		doneIds.add(step.id);
		onEvent({ type: "node-restored", nodeId: step.id, result: prior });
	}

	function emitEnd(nodeId: string, result: NodeResult): void {
		results.set(nodeId, result);
		status.set(nodeId, result.status);
		onEvent({ type: "node-end", nodeId, result });
	}

	/** Mark still-pending transitive dependents of `id` as skipped (BFS). */
	function markSkipped(id: string, reason: string): void {
		const queue = [id];
		while (queue.length > 0) {
			const cur = queue.pop()!;
			for (const depId of dependents.get(cur) ?? []) {
				if (status.get(depId) !== "pending") continue;
				const node = steps.find((s) => s.id === depId)!;
				emitEnd(depId, {
					id: depId,
					title: node.title,
					status: "skipped",
					snippets: [],
					output: "",
					skipReason: reason,
					usage: emptyUsage(),
				});
				queue.push(depId);
			}
		}
	}

	async function executeNode(node: DagNode): Promise<void> {
		status.set(node.id, "running");
		onEvent({ type: "node-start", nodeId: node.id });
		const maxRetries = getMaxRetries(opts.config);
		let result = await runAttempt(node, undefined);
		let retries = 0;
		// Auto-retry transient failures (subprocess crash, model/API error,
		// truncation, empty response) — the previous attempt's error is fed
		// back into the retry prompt. Task failures (the agent reported the
		// goal unmet) and aborts are left for the user; resume re-runs them.
		while (
			result.status === "failed" &&
			result.failureKind === "transient" &&
			retries < maxRetries &&
			!opts.signal.aborted
		) {
			retries++;
			onEvent({
				type: "node-retry",
				nodeId: node.id,
				attempt: retries,
				maxAttempts: maxRetries,
				reason: result.error ?? "unknown error",
			});
			const prev = result;
			result = await runAttempt(node, result.error ?? "unknown error");
			// Usage accumulates across attempts; the wall-clock span covers the
			// whole node, not just the final attempt.
			result.usage = addUsage(prev.usage, result.usage);
			result.startedAt = prev.startedAt;
		}
		if (retries > 0) result.retries = retries;
		emitEnd(node.id, result);
		if (result.status === "done") doneIds.add(node.id);
		else markSkipped(node.id, `dependency ${node.id} ${result.status}`);
	}

	/** One node attempt (crash-safe); `retryNote` is the previous failure reason. */
	async function runAttempt(node: DagNode, retryNote?: string): Promise<NodeResult> {
		try {
			return await runNodeSubagent(plan, node, opts, results, retryNote);
		} catch (e) {
			return {
				id: node.id,
				title: node.title,
				status: "failed",
				failureKind: "transient",
				startedAt: Date.now(),
				finishedAt: Date.now(),
				snippets: [],
				output: "",
				error: `internal executor error: ${e instanceof Error ? e.message : String(e)}`,
				usage: emptyUsage(),
			};
		}
	}

	while (true) {
		if (opts.signal.aborted) break;
		const ready = steps.filter(
			(s) => status.get(s.id) === "pending" && s.dependsOn.every((d) => doneIds.has(d)),
		);
		let slots = Math.max(0, maxParallel - running.size);
		for (const node of ready) {
			if (slots <= 0) break;
			const conflict = (node.touches ?? []).find((t) => heldResources.has(t));
			if (conflict !== undefined) {
				// A running node holds one of this node's declared resources:
				// stay pending until it finishes (ready nodes are re-scanned
				// after every node end, so this always makes progress — a
				// blocked node never holds anything itself, so no deadlock).
				const heldBy = heldResources.get(conflict)!;
				const prev = blockedInfo.get(node.id);
				if (!prev || prev.resource !== conflict || prev.heldBy !== heldBy) {
					blockedInfo.set(node.id, { resource: conflict, heldBy });
					onEvent({ type: "node-blocked", nodeId: node.id, resource: conflict, heldBy });
				}
				continue;
			}
			blockedInfo.delete(node.id);
			// Atomic claim: the loop is synchronous, so check-then-set cannot
			// interleave with another start. All-or-nothing is implicit —
			// `conflict` above already verified every touch is free.
			for (const t of node.touches ?? []) heldResources.set(t, node.id);
			slots--;
			const p = executeNode(node).catch(() => {
				// Defensive: executeNode should not reject.
				if (!results.has(node.id)) {
					emitEnd(node.id, {
						id: node.id,
						title: node.title,
						status: "failed",
						snippets: [],
						output: "",
						error: "internal executor error",
						usage: emptyUsage(),
					});
					markSkipped(node.id, `dependency ${node.id} failed`);
				}
			});
			running.add(p);
			void p.finally(() => {
				running.delete(p);
				for (const t of node.touches ?? []) {
					if (heldResources.get(t) === node.id) heldResources.delete(t);
				}
			});
		}
		if (running.size === 0) break;
		await Promise.race([...running]);
	}

	// Abort: wait for in-flight children (killed via the abort listener) to
	// finalize, then mark anything still pending as aborted.
	if (running.size > 0) await Promise.all([...running]);
	for (const s of steps) {
		if (status.get(s.id) === "pending") {
			emitEnd(s.id, {
				id: s.id,
				title: s.title,
				status: opts.signal.aborted ? "aborted" : "skipped",
				snippets: [],
				output: "",
				skipReason: opts.signal.aborted ? "run aborted" : "unreachable (dependency did not complete)",
				usage: emptyUsage(),
			});
		}
	}

	return steps.map((s) => results.get(s.id)!);
}

/** Collected outcome of one ephemeral pi subprocess. */
export interface PiSubagentResult {
	exitCode: number;
	/** Final assistant text; "" when no text message was received. */
	output: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	/** Model-level error (from the assistant message), if any. */
	modelError?: string;
	/** Captured stderr (tail, capped). */
	stderr: string;
	wasAborted: boolean;
}

export interface PiSubagentOptions {
	cwd: string;
	signal: AbortSignal;
	/** pi CLI flags, everything before the trailing positional prompt. */
	args: string[];
	/** The task prompt; appended as the last positional argument. */
	prompt: string;
	/** Live tool-call observation (UI snippets / status line). */
	onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
	/** Extra env for the child, merged over process.env (e.g. DAG_NODE_ID). */
	env?: Record<string, string>;
	/** Test seam: replace the subprocess spawn. The env arg is optional for fakes. */
	spawnImpl?: (command: string, args: string[], cwd: string, env?: Record<string, string>) => ChildProcess;
}

/**
 * Run one ephemeral pi subagent (`--mode json -p --no-session` + `args` +
 * `prompt`) and collect its final assistant output, usage, and live tool
 * calls. Shared by the DAG executor (one subagent per node) and the
 * exploring planner. SIGTERM→SIGKILL on abort, same as node runs.
 */
export async function runPiSubagent(opts: PiSubagentOptions): Promise<PiSubagentResult> {
	const result: PiSubagentResult = {
		exitCode: 0,
		output: "",
		usage: emptyUsage(),
		stderr: "",
		wasAborted: false,
	};

	let stderr = "";
	let buffer = "";

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			opts.onToolCall?.(String(event.toolName), event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {});
		} else if (event.type === "message_end" && event.message && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			result.usage = addUsage(result.usage, usageFromMessage(msg));
			result.usage.turns += 1;
			if (msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.modelError = msg.errorMessage;
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (text) result.output = text;
		}
	};

	const exitCode = await new Promise<number>((resolve) => {
		let settled = false;

		let proc: ChildProcess;
		try {
			const invocation = getPiInvocation([...opts.args, opts.prompt]);
			const childEnv = opts.env ? { ...process.env, ...opts.env } : process.env;
			const spawnImpl =
				opts.spawnImpl ??
				((command: string, a: string[], cwd: string) =>
					spawn(command, a, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: childEnv }));
			proc = spawnImpl(invocation.command, invocation.args, opts.cwd, opts.env);
		} catch (e) {
			result.stderr = `failed to spawn subagent: ${e instanceof Error ? e.message : String(e)}`;
			resolve(1);
			return;
		}

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (abortListener) opts.signal.removeEventListener("abort", abortListener);
			resolve(code);
		};

		proc.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-STDERR_CAP);
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});
		proc.on("error", (e) => {
			result.stderr = result.stderr || (e as Error).message;
			finish(1);
		});

		const abortListener = () => {
			result.wasAborted = true;
			try {
				proc.kill("SIGTERM");
			} catch {
				/* already dead */
			}
			const timer = setTimeout(() => {
				try {
					if (!proc.killed) proc.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}, KILL_GRACE_MS);
			timer.unref?.();
		};
		if (opts.signal.aborted) abortListener();
		else opts.signal.addEventListener("abort", abortListener, { once: true });
	});

	result.exitCode = exitCode;
	// A spawn-level error (e.g. ENOENT) is recorded on result.stderr directly;
	// otherwise the captured stderr tail wins.
	result.stderr = result.stderr || stderr;
	return result;
}

/** Run one DAG node as a pi subprocess (shared runner + node bookkeeping). */
async function runNodeSubagent(
	plan: DagPlan,
	node: DagNode,
	opts: RunPlanOptions,
	results: Map<string, NodeResult>,
	retryNote?: string,
): Promise<NodeResult> {
	const startedAt = Date.now();
	const depOutputs = new Map<string, string>();
	for (const d of node.dependsOn) {
		const r = results.get(d);
		if (r && r.status === "done") depOutputs.set(d, r.output);
	}
	const task = buildTaskPrompt(plan, node, depOutputs, opts.originalPrompt, retryNote);

	const args: string[] = ["--mode", "json", "-p", "--no-session", "-e", LOCK_GUARD_PATH];
	// Configured extra extensions (resolved absolute paths from the config
	// file) — additional tools for node subagents when the user opts in via
	// runnerExtensions. The lock guard stays first (safety-net ordering).
	for (const ext of opts.config?.runnerExtensions ?? []) args.push("-e", ext);
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
	if (node.tools && node.tools.length > 0) args.push("--tools", node.tools.join(","));

	const result: NodeResult = {
		id: node.id,
		title: node.title,
		status: "running",
		startedAt,
		snippets: [],
		output: "",
		usage: emptyUsage(),
	};

	const run = await runPiSubagent({
		cwd: opts.cwd,
		signal: opts.signal,
		args,
		prompt: task,
		spawnImpl: opts.spawnImpl,
		env: { DAG_NODE_ID: node.id },
		onToolCall: (toolName, argsObj) => {
			if (result.snippets.length < MAX_SNIPPETS) {
				result.snippets.push({ toolName, args: argsObj });
				opts.onEvent?.({ type: "snippet", nodeId: node.id, snippet: { toolName, args: argsObj } });
			}
		},
	});

	result.exitCode = run.exitCode;
	result.finishedAt = Date.now();
	result.output = run.output;
	result.usage = run.usage;
	result.model = run.model;
	result.stopReason = run.stopReason;
	result.error = run.modelError;

	// Trailing status line from the report contract (see buildTaskPrompt);
	// null = the agent did not report a status (not a failure).
	const reported = parseStatusLine(run.output);

	if (run.wasAborted) {
		result.status = "aborted";
	} else if (run.exitCode !== 0 || run.stopReason === "error") {
		result.status = "failed";
		result.failureKind = "transient";
		if (!result.error) {
			const tail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(-500);
			result.error = tail || `subagent exited with code ${run.exitCode}`;
		}
	} else if (run.stopReason === "length") {
		// The final message was cut off at the model's output-token limit:
		// the model never finished its turn, so the step cannot be trusted as
		// complete (its "report" is a fragment, and any tool calls in that
		// message were discarded by pi).
		result.status = "failed";
		result.failureKind = "transient";
		result.error ??= "subagent response was truncated (stopReason: length) — the model hit its output-token limit before finishing the step";
	} else if (result.snippets.length === 0) {
		// No tool calls at all: the subagent ended without doing any work
		// (e.g. a single text-only message). Marking it "done" would feed
		// dependents a report about work that never happened. An explicit
		// STATUS: failure line makes it a task failure; otherwise treat it
		// as a glitch worth one retry.
		result.status = "failed";
		if (reported && reported.kind === "failure") {
			result.failureKind = "task";
			result.error = `step reported failure: ${reported.reason || "no reason given"}`;
		} else {
			result.failureKind = "transient";
			result.error ??= "subagent made no tool calls — it ended without doing any work (empty or truncated response)";
		}
	} else if (reported && reported.kind === "failure") {
		// The agent did work and finished its turn, but explicitly reported
		// that the step's goal was not achieved — a task failure. Auto-retry
		// is unlikely to help; the user can re-run the node via resume.
		result.status = "failed";
		result.failureKind = "task";
		result.error = `step reported failure: ${reported.reason || "no reason given"}`;
	} else {
		result.status = "done";
	}
	if (result.status === "failed" && !result.error) {
		result.error = `subagent exited with code ${run.exitCode}`;
	}
	return result;
}

/** Map an AssistantMessage usage onto flat token/cost stats (turns excluded). */
function usageFromMessage(msg: AssistantMessage): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
} {
	const u = msg.usage;
	if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	return {
		input: u.input ?? 0,
		output: u.output ?? 0,
		cacheRead: u.cacheRead ?? 0,
		cacheWrite: u.cacheWrite ?? 0,
		cost: u.cost?.total ?? 0,
		contextTokens: u.totalTokens ?? 0,
		turns: 0,
	};
}
