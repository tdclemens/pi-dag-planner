# pi-dag-plan

A [pi.dev](https://pi.dev) TypeScript extension that adds a **`/dag-plan`** command: describe what you want, get a **directed acyclic graph (DAG) plan** back, review it, and — on approval — watch it **execute as parallel subagents** with live progress in the pi TUI.

> Plan first, parallelize everything, show your work.

```
/dag-plan Add unit tests for src/parser.ts and run them
```

```
DAG Plan — 4 steps
Add unit tests for src/parser.ts and run them
2 waves
├─ wave 1 (parallel)
  ● s1  Survey repo structure
  ● s2  Read src/parser.ts and its usages
└─ wave 2
  ● s3  Write tests for parser  (← s1, s2)
  ● s4  Run tests and fix failures  (← s3)

Plan saved: ~/.agents/plans/20250101-120000-add-unit-tests.md   (Ctrl+O: JSON)

? DAG plan — what next?  › Execute plan · Refine (re-plan) · Reject
```

## How it works

1. **Plan** — your prompt is sent to your active model with a DAG-planner system prompt. By default the planner runs as a **read-only subagent** that first explores the repository (manifest, test/build commands, the files the request touches — ~10-15 tool calls, nothing is modified) so the plan cites real paths and exact commands; set `plannerExplore: false` in the config (see [Configuration](#configuration)) for the faster single-call blind planner. The model must respond with a single JSON document: `{ goal, steps: [{ id, title, prompt, dependsOn[], touches[] }] }` — `touches` declares the files and shared resources each step writes (see [Concurrent file conflicts](#concurrent-file-conflicts)). Each step prompt is self-contained because subagents have no shared context. **The JSON is validated automatically against the canonical JSON Schema** (`src/schema.ts`, draft 2020-12, via ajv) **and against the DAG rules — unique ids, known deps, and no cycles** — before anything continues; an invalid or cyclic plan is rejected and re-planned once with the error as feedback. Unordered `touches` overlap (implied serialization) is not rejected — it is shown as a ⚠ warning on the plan card.
2. **Review** — the plan is rendered as a friendly wave/dependency view in the chat (the raw JSON is the source of truth and appears when you expand the card with **Ctrl+O**). You choose:
   - **Execute plan**
   - **Refine** — give the planner feedback and re-plan (up to 3 rounds)
   - **Reject** — the plan file is kept for reference
3. **Save** — before execution, the plan is written to `~/.agents/plans/<timestamp>-<slug>.md` with the human-readable step list and the exact JSON embedded.
4. **Execute** — the executor re-validates the plan (schema + acyclicity) and refuses to start a cyclic or malformed plan. The DAG is then scheduled with Kahn's algorithm: a worker pool (default 4, set via `maxParallel` in the config) runs every node whose dependencies are complete, so independent branches execute concurrently. **Declared `touches` are mutex-protected at the scheduler**: a node holds its declared files/resources for the whole run, and a ready node whose touches collide with a running one stays pending (shown in the runner panel) until the holder finishes — no two nodes ever write the same declared file at the same time. Each node is a **subagent**: an isolated `pi --mode json -p --no-session` subprocess running the node's prompt plus (truncated) outputs of its prerequisite nodes, with the per-node file-lock extension (`src/lock-guard.ts`) injected via `-e` + `DAG_NODE_ID` to catch *undeclared* overlap at write time (see below). **Transient failures are auto-retried** (default 1, `nodeRetries` in the config): a crashed subprocess, model/API error, truncated final message, or empty response is re-run once with the failure reason fed back into the prompt (the retry is told to inspect the repo state first, since the failed attempt may have left partial changes). Each node's report must end with a status line (`STATUS: success` or `STATUS: failure — <reason>`); an explicit task failure is *not* auto-retried — the node is marked failed and its dependents skipped, and you can re-run it later with [resume](#resume).
5. **Watch** — a live runner panel replaces the editor while the graph executes, showing per-node status and snippets of the commands the subagents run:

   ```
   DAG runner — 2/4 done, 1 running, 1 pending (esc: cancel)
   ✓ s1  Survey repo structure              14.2s
   ✓ s2  Read src/parser.ts and its usages  18.9s
   ▶ s3  Write tests for parser   → $ ls src/
   ○ s4  Run tests and fix failures (waiting: s3)
   ```

   When a node finishes, a subagent-style card is appended to the transcript (command snippets, final output, usage), and the markdown plan file gets a **Results** section. Each node's result is also checkpointed to the run-state sidecar (`<plan>.run.json`) as it completes, so an interrupted run can be resumed (see [Resume](#resume)). **Esc** cancels the run (children are terminated, state is finalized).

   Node status icons (single-cell, non-emoji, so the column aligns in any terminal): `○` pending · `▶` running · `✓` done · `✗` failed · `⊘` skipped · `■` aborted. Usage lines show `↑` input tokens, `↓` output tokens, `R`/`W` cache read/write, then cost and model. A pending node waiting on the file lock shows why: `○ s4  Run tests (file lock: package-lock.json held by s1)`.

## Concurrent file conflicts

Nodes run as parallel subagents **in the same working directory**, so two nodes writing the same file is the classic corruption risk (last writer silently wins). `pi-dag-plan` layers three defenses:

1. **Planner contract** — every step declares `touches`: the exact files it creates/modifies *plus* the shared resources its commands mutate (lockfiles, `node_modules`, build dirs, ports, test DBs). The planner is instructed to keep `touches` disjoint across parallel steps and to add a `dependsOn` edge when two steps must share a file. `validatePlan` warns (⚠ on the plan card, before you approve) when unordered steps share a `touches` entry, so implied serialization is visible, not silent.
2. **Executor resource mutex** — `touches` are scheduler-level locks: a node acquires all of its declared resources when it starts and releases them when it ends; a ready node whose touches collide stays pending (and the runner panel names the resource and the holder). Undeclared nodes never block, so this only ever *reduces* overlap, never deadlocks (a blocked node holds nothing).
3. **Per-node file lock (optimistic concurrency)** — every node subagent loads `src/lock-guard.ts`, which hashes each file the node reads and vetoes `write`/`edit` calls whose target changed since that read: the tool call is blocked with an instruction to **re-read and re-apply**. After 3 stale retries on one file the node is told to stop touching it and report the conflict, so a hot file cannot burn the run in a retry loop. This is detect-and-retry, not a held lock — an agent thinks for minutes between read and write, so pessimistic locking would serialize everything. It catches overlap the planner failed to declare (including files rewritten by another node's *bash* commands).

Known gap: writes done purely through `bash` (e.g. `npm install` regenerating a lockfile) are not intercepted — declare them as `touches` so the executor serializes the owning steps, and the file lock will at least make any such collision *visible* to the affected node (one extra re-read).

## Install

### Development

No build step — pi loads the extension via jiti:

```bash
git clone <this-repo> dag-planner
cd dag-planner
pi -e ./src/index.ts
```

Or place/link it in your global extensions dir:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/src" ~/.pi/agent/extensions/dag-plan   # or copy src/index.ts etc.
```

### As a pi package

```bash
pi install git:<host>/<user>/dag-planner
```

## Usage

```
/dag-plan <prompt>
```

Examples:

```
/dag-plan Refactor the auth module to use JWT and update all call sites
/dag-plan Migrate the project from CommonJS to ESM without breaking the test suite
/dag-plan Audit the repo for TODOs, group them by module, and draft an issue per group
```

- **Ctrl+O** on the plan card expands the raw JSON.
- **Refine** lets you steer the plan before spending tokens on execution ("make it at most 4 steps", "don't touch the database layer").
- The plan file in `~/.agents/plans/` is the durable record: goal, steps, JSON, and post-execution results.

### Plan file

`~/.agents/plans/20250101-120000-add-unit-tests.md`:

````markdown
# DAG Plan: Add unit tests for the parser

- **Created:** 2025-01-01T12:00:00Z
- **Status:** completed
- **Prompt:** Add unit tests for src/parser.ts and run them
- **Steps:** 4 (waves: 2 parallel + 1 + 1)

## Steps

1. **s1** — Survey repo structure — deps: —
2. **s2** — Read src/parser.ts and its usages — deps: —
3. **s3** — Write tests for parser — deps: s1, s2
4. **s4** — Run tests and fix failures — deps: s3

## Plan (JSON)

```json
{ "goal": "…", "steps": [ … ] }
```

## Results

| node | status   | duration | output excerpt |
|------|----------|----------|----------------|
| s1   | ✓ done   | 14.2s    | Found vitest config, src/parser.ts, 3 call sites… |
| …    | …        | …        | … |

Totals: 4/4 succeeded · $0.0712 · 2m03s
````

### Resume

Every run also writes a run-state sidecar next to the plan file (`<plan>.run.json`) — the plan, the original prompt, and each node's result as it completes (atomic writes, so a crash never leaves a torn file). If a run is interrupted (Esc, crash, closed laptop) or finishes with failures, continue it from where it left off:

```
/dag-plan resume ~/.agents/plans/20250101-120000-add-unit-tests.md
```

- **Completed (✓ done) nodes are restored** — they are not re-run, and their outputs are still injected into their dependents' prompts.
- **Failed, skipped, and aborted nodes are re-run**, along with anything that was still pending.
- Works on plan files that were never executed (the embedded JSON is used as a fresh start) and on plan files saved before the sidecar existed.
- The post-run summary shows the exact resume command whenever there is anything left to do.

## Configuration

All options live in a JSON config file in the usual pi extension locations —
no environment variables. Project values override global values per key,
and every option is optional with a default, so you can omit the file (or
any key) entirely and behavior is unchanged.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/dag-plan.json` | Global (all projects) |
| `.pi/dag-plan.json` | Project-local (trusted projects only; overrides global per key) |

Example with all options and their defaults:

```json
{
  "maxSteps": 12,
  "maxParallel": 4,
  "nodeRetries": 1,
  "plannerExplore": true,
  "plannerExtensions": [],
  "runnerExtensions": []
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxSteps` | integer ≥ 1 | `12` | Soft step-count cap: the planner sizes plans to it, and plans above it get a ⚠ on the plan card. |
| `maxParallel` | integer ≥ 1 | `4` | Max concurrent runner subagents. |
| `nodeRetries` | integer ≥ 0 | `1` | Auto-retries per node for transient failures (subprocess crash, model/API error, truncated or empty response). Agent-reported task failures are never auto-retried; `0` disables. |
| `plannerExplore` | boolean | `true` | Planner explores the repo as a read-only subagent before planning. `false` = the faster single blind LLM call (no tools). |
| `plannerExtensions` | string[] | `[]` | Extra extensions loaded into the planner subagent (see below). |
| `runnerExtensions` | string[] | `[]` | Extra extensions loaded into every runner node subagent (see below). |

Fixed limits (not configurable): hard step ceiling `32` (raised to
`maxSteps` when that is higher — plans above the ceiling are rejected and
re-planned), 1 planning retry on invalid JSON, 3 refine attempts, plan
directory `~/.agents/plans/`, 8 KB per dep / 16 KB total injected into node
prompts.

### Extra extensions for planner / runner

By default the planner subagent is locked down (read-only tools, no
auto-discovered extensions/skills/context files) and each runner node is a
plain subagent with the standard tools plus the built-in file lock. To give
them **extra tools**, list extension paths in the matching key:

```json
{
  "plannerExtensions": ["~/pi-extensions/brave-search.ts"],
  "runnerExtensions": ["~/pi-extensions/web-tools/index.ts"]
}
```

- Paths may be absolute, start with `~/`, or be relative to the directory of
  the config file that provides them (same convention as pi's `settings.json`
  resource paths).
- **Planner:** extensions load into the locked-down planner on top of
  `--no-extensions` (your normal extensions/skills still do not load). When
  `plannerExtensions` is non-empty the read-only `--tools` allow-list is
  dropped so the extensions' tools are actually available — the planner then
  also gets pi's default tools (including `bash`/`write`). The planner prompt
  still instructs it to never modify anything; this option is for tools that
  help it *plan*, e.g. web search or MCP servers.
- **Runner:** extensions load into every node subagent alongside the
  built-in file lock. A node step that pins its own `tools` allow-list in the
  plan is unaffected — that allow-list still applies.
- Project arrays **replace** global arrays (they do not merge); put the full
  list in the project file to override.

Invalid values (bad JSON, wrong types, unknown keys) never break a run —
the affected option falls back to its default and you get a ⚠ notification
naming the file and field.

## Requirements

- pi (`@earendil-works/pi-coding-agent`) with a model selected (`/model`)
- Interactive TUI mode (the command is a no-op in print/JSON/RPC modes)
- A `pi` invocation reachable from within pi (the extension reuses its own entrypoint, so standard installs work out of the box)

## Project layout

```
src/
├── index.ts     # /dag-plan command, message/entry renderers, flow orchestration
├── config.ts    # dag-plan.json config loading (global + project merge, validation)
├── planner.ts   # planner prompt, LLM call, robust JSON extraction + validation
├── schema.ts    # canonical JSON Schema for the plan (2020-12) + ajv validation
├── dag.ts       # pure DAG utils: schema + graph validation (cycles, deps), topo levels
├── executor.ts  # ready-set scheduler + pi subprocess subagents + JSONL parsing
├── ui.ts        # plan renderer, node result cards, live runner dashboard, snippets
├── plans.ts     # ~/.agents/plans/ markdown writer (plan + results append + run-state sidecar)
└── types.ts     # shared types
```

## Development

```bash
npm install        # dependencies (typescript, ajv, test runner)
npm test           # unit tests: schema + DAG validation, JSON extraction, scheduler
```

Manual smoke test:

```bash
pi -e ./src/index.ts
# then, inside pi:
/dag-plan List the files in this repo, summarize each, then write a combined report
```

## Limitations (v1)

- Execution is interactive only; non-TUI modes refuse the command.
- A failed node skips its dependents; the rest of the graph continues. Transient failures are auto-retried (`nodeRetries`); agent-reported task failures are left for you — resume re-runs failed nodes from scratch.
- Subagent sessions are ephemeral (`--no-session`); the transcript cards, results table, and plan file are the durable record, with large outputs truncated.
- Resume re-runs failed/skipped/aborted nodes from scratch; a node that was still running when the run was interrupted is re-run in full (its partial work is not rolled back).
- The file lock covers the `read`/`write`/`edit` tools only; `bash`-mediated file mutations are not intercepted (see [Concurrent file conflicts](#concurrent-file-conflicts)).
