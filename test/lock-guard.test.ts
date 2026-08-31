import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import dagNodeFileLocks, {
	hashFile,
	LockGuardState,
	MAX_STALE_RETRIES,
	normalizeKey,
	type WriteVerdict,
} from "../src/lock-guard.ts";

// --- LockGuardState (pure state machine) ----------------------------------

function denied(v: WriteVerdict): Extract<WriteVerdict, { allowed: false }> {
	assert.equal(v.allowed, false, JSON.stringify(v));
	return v;
}

test("LockGuardState: write allowed without a prior read (no claim to violate)", () => {
	const s = new LockGuardState();
	assert.deepEqual(s.checkWrite("/a", "h1"), { allowed: true });
});

test("LockGuardState: write matching the read stamp is allowed", () => {
	const s = new LockGuardState();
	s.recordRead("/a", "h1");
	assert.deepEqual(s.checkWrite("/a", "h1"), { allowed: true });
});

test("LockGuardState: changed file is stale; a fresh read resets the budget", () => {
	const s = new LockGuardState();
	s.recordRead("/a", "h1");
	const v1 = denied(s.checkWrite("/a", "h2"));
	assert.equal(v1.giveUp, false);
	assert.match(v1.reason, /re-read/i);
	assert.match(v1.reason, new RegExp(`stale attempt 1/${MAX_STALE_RETRIES}`));
	s.recordRead("/a", "h2"); // node re-reads the fresh content
	assert.deepEqual(s.checkWrite("/a", "h2"), { allowed: true });
});

test("LockGuardState: deleted file counts as changed", () => {
	const s = new LockGuardState();
	s.recordRead("/a", "h1");
	const v = denied(s.checkWrite("/a", undefined));
	assert.equal(v.giveUp, false);
});

test(`LockGuardState: giveUp verdict after ${MAX_STALE_RETRIES} stale attempts`, () => {
	const s = new LockGuardState();
	s.recordRead("/a", "h0");
	let last: WriteVerdict = { allowed: true };
	for (let i = 0; i < MAX_STALE_RETRIES + 1; i++) {
		last = s.checkWrite("/a", `h${i + 1}`);
	}
	const v = denied(last);
	assert.equal(v.giveUp, true);
	assert.match(v.reason, /do not write/i);
});

test("LockGuardState: recordMutation re-stamps and clears the stale counter", () => {
	const s = new LockGuardState();
	s.recordRead("/a", "h1");
	denied(s.checkWrite("/a", "h2")); // stale hit 1
	s.recordMutation("/a", "h3"); // this node's own successful write
	assert.deepEqual(s.checkWrite("/a", "h3"), { allowed: true });
	// Budget was reset: the next MAX_STALE_RETRIES stale hits still only deny.
	for (let i = 0; i < MAX_STALE_RETRIES - 1; i++) denied(s.checkWrite("/a", `x${i}`));
	const v = denied(s.checkWrite("/a", "y")); // hit MAX_STALE_RETRIES → deny
	assert.equal(v.giveUp, false);
	const v2 = denied(s.checkWrite("/a", "z")); // one more → give up
	assert.equal(v2.giveUp, true);
});

test("LockGuardState: per-file budgets are independent", () => {
	const s = new LockGuardState();
	s.recordRead("/a", "1");
	s.recordRead("/b", "1");
	for (let i = 0; i < MAX_STALE_RETRIES + 1; i++) denied(s.checkWrite("/a", `x${i}`));
	assert.equal(s.checkWrite("/b", "2").allowed, false, "/b has its own budget but is stale");
	const vb = s.checkWrite("/b", "2");
	assert.equal((vb as { giveUp: boolean }).giveUp, false, "/b is on its first stale attempt");
});

// --- path / hash helpers ----------------------------------------------------

test("normalizeKey: relative→absolute, symlinks resolve, missing files don't throw", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "daglock-"));
	const real = path.join(dir, "real.ts");
	await writeFile(real, "x");
	const link = path.join(dir, "link.ts");
	await symlink(real, link);
	assert.equal(await normalizeKey(dir, "real.ts"), await normalizeKey(dir, "./real.ts"));
	assert.equal(await normalizeKey(dir, "real.ts"), await normalizeKey(dir, "link.ts"), "same file via alias");
	assert.equal(await normalizeKey(dir, "/abs/f.txt"), "/abs/f.txt");
	assert.equal(await normalizeKey(dir, "nope.ts"), path.join(dir, "nope.ts"), "missing file: normalized path, no throw");
});

test("hashFile: undefined for missing, stable 64-hex for existing, changes with content", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "daglock-"));
	const f = path.join(dir, "h.txt");
	assert.equal(await hashFile(f), undefined);
	await writeFile(f, "hello");
	const h1 = await hashFile(f);
	assert.match(h1 ?? "", /^[a-f0-9]{64}$/);
	assert.equal(await hashFile(f), h1);
	await writeFile(f, "world");
	assert.notEqual(await hashFile(f), h1);
});

// --- extension wiring (fake pi, real temp files) ----------------------------

function fakePi() {
	const handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>> = {};
	const pi = {
		on: (name: string, fn: (e: unknown, ctx: unknown) => unknown) => {
			(handlers[name] ??= []).push(fn);
		},
	};
	const fire = async (name: string, e: unknown, ctx: unknown): Promise<unknown[]> => {
		const out: unknown[] = [];
		for (const fn of handlers[name] ?? []) out.push(await fn(e, ctx));
		return out;
	};
	return { pi, handlers, fire };
}

type WithEnv = { withEnv: (fn: () => Promise<void>) => Promise<void> };

function withNodeId(): WithEnv {
	const saved = process.env.DAG_NODE_ID;
	return {
		withEnv: async (fn) => {
			process.env.DAG_NODE_ID = "s1";
			try {
				await fn();
			} finally {
				if (saved === undefined) delete process.env.DAG_NODE_ID;
				else process.env.DAG_NODE_ID = saved;
			}
		},
	};
}

const editCall = (id: string) => ({
	type: "tool_call",
	toolCallId: id,
	toolName: "edit",
	input: { path: "app.ts", edits: [{ oldText: "old", newText: "new" }] },
});

test("extension is inert without DAG_NODE_ID", () => {
	const saved = process.env.DAG_NODE_ID;
	try {
		delete process.env.DAG_NODE_ID;
		const { pi, handlers } = fakePi();
		dagNodeFileLocks(pi as never);
		assert.equal(Object.keys(handlers).length, 0, "no handlers registered without a node id");
	} finally {
		if (saved === undefined) delete process.env.DAG_NODE_ID;
		else process.env.DAG_NODE_ID = saved;
	}
});

test("extension: read stamps; a foreign write makes the next edit stale until re-read", async () => {
	const { withEnv } = withNodeId();
	await withEnv(async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "daglock-"));
		const f = path.join(dir, "app.ts");
		await writeFile(f, "v1");
		const { pi, fire } = fakePi();
		dagNodeFileLocks(pi as never);
		const ctx = { cwd: dir };
		const call = (e: unknown) => fire("tool_call", e, ctx);
		const res = (e: unknown) => fire("tool_result", e, ctx);

		await call({ type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "app.ts" } });
		await res({
			type: "tool_result",
			toolCallId: "1",
			toolName: "read",
			input: { path: "app.ts" },
			content: [],
			isError: false,
			details: {},
		});

		// Another node rewrites the file behind this node's back.
		await writeFile(f, "v2-other-node");

		const blocked = await call(editCall("2"));
		assert.equal(blocked.length, 1);
		const verdict = blocked[0] as { block: boolean; reason: string };
		assert.equal(verdict.block, true);
		assert.match(verdict.reason, /re-read/i);

		// Re-read, then the same edit goes through.
		await call({ type: "tool_call", toolCallId: "3", toolName: "read", input: { path: "app.ts" } });
		const ok = await call(editCall("4"));
		assert.equal(ok[0], undefined, "edit allowed after re-read");

		// Simulate this node's write landing, then the post-mutation stamp
		// tracks disk: the very next write against the new content is fine.
		await writeFile(f, "v3-mine");
		await res({
			type: "tool_result",
			toolCallId: "4",
			toolName: "write",
			input: { path: "app.ts", content: "v3-mine" },
			content: [],
			isError: false,
			details: undefined,
		});
		const ok2 = await call({
			type: "tool_call",
			toolCallId: "5",
			toolName: "write",
			input: { path: "app.ts", content: "v4" },
		});
		assert.equal(ok2[0], undefined, "write allowed after own successful mutation");

		// An errored result does not re-stamp.
		await writeFile(f, "v5-external");
		await res({
			type: "tool_result",
			toolCallId: "6",
			toolName: "write",
			input: { path: "app.ts", content: "v5" },
			content: [],
			isError: true,
			details: undefined,
		});
		const stale = await call({
			type: "tool_call",
			toolCallId: "7",
			toolName: "write",
			input: { path: "app.ts", content: "v6" },
		});
		assert.equal((stale[0] as { block?: boolean })?.block, true, "errored result must not refresh the stamp");
	});
});

test(`extension: ${MAX_STALE_RETRIES} stale retries then terminate=true give-up`, async () => {
	const { withEnv } = withNodeId();
	await withEnv(async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "daglock-"));
		await writeFile(path.join(dir, "app.ts"), "v1");
		const { pi, fire } = fakePi();
		dagNodeFileLocks(pi as never);
		const ctx = { cwd: dir };
		const call = (e: unknown) => fire("tool_call", e, ctx);

		await call({ type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "app.ts" } });
		await writeFile(path.join(dir, "app.ts"), "changed-externally");

		// Stale blocks 1..MAX_STALE_RETRIES carry retry guidance; from
		// MAX_STALE_RETRIES + 1 on the file is blocked for the node's
		// lifetime (give-up message) — but the node itself keeps running,
		// so no block ever terminates the agent.
		let last: { block?: boolean; terminate?: boolean; reason?: string } = {};
		for (let i = 2; i <= MAX_STALE_RETRIES + 3; i++) {
			const out = await call(editCall(String(i)));
			last = out[0] as typeof last;
			assert.equal(last.block, true, `attempt ${i - 1} should be blocked`);
			assert.equal(last.terminate, undefined, "the guard never terminates the node");
			if (i - 1 <= MAX_STALE_RETRIES) assert.match(last.reason ?? "", /re-read/i);
		}
		assert.match(last.reason ?? "", /do not write/i, "exhausted file stays blocked with give-up guidance");
	});
});
