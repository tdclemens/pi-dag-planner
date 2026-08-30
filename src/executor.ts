/**
 * DAG executor: ready-set scheduler with a bounded worker pool, where each
 * node runs as an isolated `pi --mode json -p --no-session` subagent.
 * Failure of a node marks its transitive dependents `skipped`; abort (Esc /
 * session shutdown) kills children and finalizes state.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { dependentsIndex } from "./dag.ts";
import type { DagEvent, DagNode, DagPlan, NodeResult, NodeStatus, UsageStats } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";

export const DEFAULT_MAX_PARALLEL = 4;
const DEP_OUTPUT_PER_CAP = 8 * 1024;
const DEP_OUTPUT_TOTAL_CAP = 16 * 1024;
const MAX_SNIPPETS = 200;
const KILL_GRACE_MS = 5000;
const STDERR_CAP = 2000;

/** Concurrency from DAG_PLAN_MAX_PARALLEL (registerFlag is bool/string only). */
export function getMaxParallel(): number {
	const raw = process.env.DAG_PLAN_MAX_PARALLEL;
	if (raw) {
		const n = Number.parseInt(raw, 10);
		if (Number.isFinite(n) && n >= 1) return n;
	}
	return DEFAULT_MAX_PARALLEL;
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

/** Build the self-contained task prompt for a node, injecting dep outputs. */
export function buildTaskPrompt(
	plan: DagPlan,
	node: DagNode,
	depOutputs: Map<string, string>,
	originalPrompt?: string,
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
	lines.push(
		"",
		"When finished, reply with a concise markdown report: what you did, and the artifacts (file paths, commands, values) that later steps need.",
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
	 * The user's original /dag-plan request, injected verbatim into every node
	 * prompt so subagents see the full request, not just the one-line goal.
	 */
	originalPrompt?: string;
	signal: AbortSignal;
	onEvent?: (event: DagEvent) => void;
	/** Test seam: replace the subprocess spawn. */
	spawnImpl?: (command: string, args: string[], cwd: string) => ChildProcess;
}

/**
 * Execute the whole plan. Resolves with one NodeResult per step (in plan
 * order) once every node has ended (done/failed/skipped/aborted).
 */
export async function runPlan(plan: DagPlan, opts: RunPlanOptions): Promise<NodeResult[]> {
	const steps = plan.steps;
	const maxParallel = Math.max(1, opts.maxParallel ?? getMaxParallel());
	const onEvent = opts.onEvent ?? (() => {});
	const dependents = dependentsIndex(steps);

	const status = new Map<string, NodeStatus>(steps.map((s) => [s.id, "pending" as NodeStatus]));
	const results = new Map<string, NodeResult>();
	const doneIds = new Set<string>();
	const running = new Set<Promise<void>>();

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
		let result: NodeResult;
		try {
			result = await runNodeSubagent(plan, node, opts, results);
		} catch (e) {
			result = {
				id: node.id,
				title: node.title,
				status: "failed",
				startedAt: Date.now(),
				finishedAt: Date.now(),
				snippets: [],
				output: "",
				error: `internal executor error: ${e instanceof Error ? e.message : String(e)}`,
				usage: emptyUsage(),
			};
		}
		emitEnd(node.id, result);
		if (result.status === "done") doneIds.add(node.id);
		else markSkipped(node.id, `dependency ${node.id} ${result.status}`);
	}

	while (true) {
		if (opts.signal.aborted) break;
		const ready = steps.filter(
			(s) => status.get(s.id) === "pending" && s.dependsOn.every((d) => doneIds.has(d)),
		);
		const slots = maxParallel - running.size;
		for (const node of ready.slice(0, Math.max(0, slots))) {
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
			void p.finally(() => running.delete(p));
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
	/** Test seam: replace the subprocess spawn. */
	spawnImpl?: (command: string, args: string[], cwd: string) => ChildProcess;
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
			const spawnImpl =
				opts.spawnImpl ??
				((command: string, a: string[], cwd: string) =>
					spawn(command, a, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] }));
			proc = spawnImpl(invocation.command, invocation.args, opts.cwd);
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
): Promise<NodeResult> {
	const startedAt = Date.now();
	const depOutputs = new Map<string, string>();
	for (const d of node.dependsOn) {
		const r = results.get(d);
		if (r && r.status === "done") depOutputs.set(d, r.output);
	}
	const task = buildTaskPrompt(plan, node, depOutputs, opts.originalPrompt);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
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

	if (run.wasAborted) {
		result.status = "aborted";
	} else if (run.exitCode !== 0 || run.stopReason === "error") {
		result.status = "failed";
		if (!result.error) {
			const tail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(-500);
			result.error = tail || `subagent exited with code ${run.exitCode}`;
		}
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
