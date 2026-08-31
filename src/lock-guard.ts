/**
 * DAG node file lock (optimistic concurrency control inside each node).
 *
 * Every node subagent is spawned with `-e <this file>` and
 * `DAG_NODE_ID=<node id>`. While that env var is set, this extension:
 *
 *   - records a content-hash "stamp" of each file the node reads, and
 *   - vetoes `write`/`edit` calls whose target changed since the last read:
 *     the tool call is blocked with a reason telling the model to re-read
 *     and re-apply. After `MAX_STALE_RETRIES` stale attempts on one file the
 *     file is blocked for the rest of the node's lifetime — with an
 *     instruction to stop touching it and report the conflict — so a hot
 *     file cannot burn the whole run in a retry loop without killing the
 *     node (its remaining work, and the rest of the plan, still completes).
 *
 * This is the run-time safety net for file overlap the planner failed to
 * declare: the executor's `touches` mutex (src/executor.ts) serializes
 * *declared* overlap deterministically; this guard detects *undeclared*
 * overlap at write time. Pure OCC — no cross-process lock files — because
 * the LLM thinks for minutes between read and write, so held (pessimistic)
 * locks would serialize everything.
 *
 * Known gap: bash-mediated writes (npm install → lockfile, formatters,
 * codegen) are not intercepted. A command that rewrites a stamped file
 * simply makes the next write to it look stale, which the model resolves
 * by re-reading (one extra turn in the worst case).
 *
 * The state machine (LockGuardState) is pure and unit-tested without pi;
 * the default export wires it to the tool_call / tool_result events.
 */

import {
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Stale write/edit attempts allowed per file before the node must give up. */
export const MAX_STALE_RETRIES = 3;

/** Verdict for a pending write/edit against the node's read stamp. */
export type WriteVerdict = { allowed: true } | { allowed: false; reason: string; giveUp: boolean };

/**
 * Per-node optimistic-lock state. All keys are canonical file paths
 * (see normalizeKey). In-memory only: each node subagent is its own
 * process, so no cross-process coordination is needed — a stamp is "what
 * this node last saw", and any other writer's effect shows up as a hash
 * mismatch at write time.
 */
export class LockGuardState {
	private stamps = new Map<string, string>();
	private staleHits = new Map<string, number>();
	private readonly maxRetries: number;

	constructor(maxRetries: number = MAX_STALE_RETRIES) {
		this.maxRetries = maxRetries;
	}

	/** Stamp the file with what the node just read. A fresh read resets the retry budget. */
	recordRead(key: string, hash: string | undefined): void {
		if (hash === undefined) return; // unreadable/missing: nothing to claim
		this.stamps.set(key, hash);
		this.staleHits.delete(key);
	}

	/** Validate a pending write/edit. Increments the stale counter on rejection. */
	checkWrite(key: string, currentHash: string | undefined): WriteVerdict {
		const stamp = this.stamps.get(key);
		if (stamp === undefined) return { allowed: true }; // never read: no claim to violate
		if (currentHash === stamp) return { allowed: true };
		const hits = (this.staleHits.get(key) ?? 0) + 1;
		this.staleHits.set(key, hits);
		if (hits <= this.maxRetries) {
			return {
				allowed: false,
				giveUp: false,
				reason:
					`DAG file lock: ${key} changed after you last read it (another step of this plan, or a command, wrote to it since). ` +
					`Re-read the file and re-apply your change against the fresh content. ` +
					`(stale attempt ${hits}/${this.maxRetries} for this file)`,
			};
		}
		return {
			allowed: false,
			giveUp: true,
			reason:
				`DAG file lock: ${key} is still conflicting after ${this.maxRetries} retries — another step is actively rewriting it. ` +
				`Do NOT write to this file again. Finish the rest of your task and mention the conflict in your final report.`,
		};
	}

	/** Stamp the on-disk content after this node's own successful write/edit. */
	recordMutation(key: string, hash: string | undefined): void {
		if (hash === undefined) return;
		this.stamps.set(key, hash);
		this.staleHits.delete(key);
	}
}

/**
 * Canonical key for lock state: absolute, normalized, symlink-resolved when
 * possible (two alias paths for the same file must share one stamp).
 */
export async function normalizeKey(cwd: string, p: string): Promise<string> {
	const raw = (p ?? "").trim();
	const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
	const norm = path.normalize(abs);
	try {
		return await fs.realpath(norm);
	} catch {
		return norm; // missing/unresolvable: use the normalized path
	}
}

/** sha256 of a file's current content, or undefined when unreadable/missing. */
export async function hashFile(p: string): Promise<string | undefined> {
	try {
		const buf = await fs.readFile(p);
		return createHash("sha256").update(buf).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * The extension entry point (loaded into node subagents via `-e`). Inert
 * unless DAG_NODE_ID is set, so it is harmless to load elsewhere.
 */
export default function dagNodeFileLocks(pi: ExtensionAPI): void {
	const nodeId = process.env.DAG_NODE_ID;
	if (!nodeId) return;

	const state = new LockGuardState();

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("read", event)) {
			const key = await normalizeKey(ctx.cwd, event.input.path);
			state.recordRead(key, await hashFile(key));
			return;
		}
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const key = await normalizeKey(ctx.cwd, event.input.path);
			const verdict = state.checkWrite(key, await hashFile(key));
			if (!verdict.allowed) {
				// No `terminate`: even after the budget is exhausted the node
				// keeps running (the file just stays blocked for its lifetime),
				// so it can finish the rest of its task and report the
				// conflict instead of failing the whole node + dependents.
				return { block: true, reason: verdict.reason };
			}
		}
	});

	// After a successful write/edit by this node, re-stamp from disk so the
	// next check reflects reality (including any last-moment race winner).
	pi.on("tool_result", async (event, ctx: ExtensionContext) => {
		if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
		if (event.isError) return;
		const raw = event.input.path;
		if (typeof raw !== "string") return;
		const key = await normalizeKey(ctx.cwd, raw);
		state.recordMutation(key, await hashFile(key));
	});
}
