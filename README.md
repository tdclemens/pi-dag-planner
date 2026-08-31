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

1. **Plan** — your prompt is sent to your active model with a DAG-planner system prompt. By default the planner runs as a **read-only subagent** that first explores the repository (manifest, test/build commands, the files the request touches — ~10-15 tool calls, nothing is modified) so the plan cites real paths and exact commands; set `DAG_PLAN_PLANNER_EXPLORE=0` for the faster single-call blind planner. The model must respond with a single JSON document: `{ goal, steps: [{ id, title, prompt, dependsOn[], touches[] }] }` — `touches` declares the files and shared resources each step writes (see [Concurrent file conflicts](#concurrent-file-conflicts)). Each step prompt is self-contained because subagents have no shared context. **The JSON is validated automatically against the canonical JSON Schema** (`src/schema.ts`, draft 2020-12, via ajv) **and against the DAG rules — unique ids, known deps, and no cycles** — before anything continues; an invalid or cyclic plan is rejected and re-planned once with the error as feedback. Unordered `touches` overlap (implied serialization) is not rejected — it is shown as a ⚠ warning on the plan card.
2. **Review** — the plan is rendered as a friendly wave/dependency view in the chat (the raw JSON is the source of truth and appears when you expand the card with **Ctrl+O**). You choose:
   - **Execute plan**
   - **Refine** — give the planner feedback and re-plan (up to 3 rounds)
   - **Reject** — the plan file is kept for reference
3. **Save** — before execution, the plan is written to `~/.agents/plans/<timestamp>-<slug>.md` with the human-readable step list and the exact JSON embedded.
4. **Execute** — the executor re-validates the plan (schema + acyclicity) and refuses to start a cyclic or malformed plan. The DAG is then scheduled with Kahn's algorithm: a worker pool (default 4, bounded by `DAG_PLAN_MAX_PARALLEL`) runs every node whose dependencies are complete, so independent branches execute concurrently. **Declared `touches` are mutex-protected at the scheduler**: a node holds its declared files/resources for the whole run, and a ready node whose touches collide with a running one stays pending (shown in the runner panel) until the holder finishes — no two nodes ever write the same declared file at the same time. Each node is a **subagent**: an isolated `pi --mode json -p --no-session` subprocess running the node's prompt plus (truncated) outputs of its prerequisite nodes, with the per-node file-lock extension (`src/lock-guard.ts`) injected via `-e` + `DAG_NODE_ID` to catch *undeclared* overlap at write time (see below).
5. **Watch** — a live runner panel replaces the editor while the graph executes, showing per-node status and snippets of the commands the subagents run:

   ```
   DAG runner — 2/4 done, 1 running, 1 pending (esc: cancel)
   ✓ s1  Survey repo structure              14.2s
   ✓ s2  Read src/parser.ts and its usages  18.9s
   ▶ s3  Write tests for parser   → $ ls src/
   ○ s4  Run tests and fix failures (waiting: s3)
   ```

   When a node finishes, a subagent-style card is appended to the transcript (command snippets, final output, usage), and the markdown plan file gets a **Results** section. **Esc** cancels the run (children are terminated, state is finalized).

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

## Configuration

| Setting | Mechanism | Default |
|---------|-----------|---------|
| Max parallel nodes | env `DAG_PLAN_MAX_PARALLEL` | `4` |
| Planner repo exploration (read-only subagent) | env `DAG_PLAN_PLANNER_EXPLORE` | on (`0`/`false`/`off` = single blind call) |
| Planning retries on invalid JSON | — | 1 retry |
| Refine attempts | — | 3 |
| Plan directory | — | `~/.agents/plans/` (fixed) |
| Dependency output injected into a node prompt | — | 8 KB per dep / 16 KB total |

## Requirements

- pi (`@earendil-works/pi-coding-agent`) with a model selected (`/model`)
- Interactive TUI mode (the command is a no-op in print/JSON/RPC modes)
- A `pi` invocation reachable from within pi (the extension reuses its own entrypoint, so standard installs work out of the box)

## Project layout

```
src/
├── index.ts     # /dag-plan command, message/entry renderers, flow orchestration
├── planner.ts   # planner prompt, LLM call, robust JSON extraction + validation
├── schema.ts    # canonical JSON Schema for the plan (2020-12) + ajv validation
├── dag.ts       # pure DAG utils: schema + graph validation (cycles, deps), topo levels
├── executor.ts  # ready-set scheduler + pi subprocess subagents + JSONL parsing
├── ui.ts        # plan renderer, node result cards, live runner dashboard, snippets
├── plans.ts     # ~/.agents/plans/ markdown writer (plan + results append)
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
- A failed node skips its dependents; the rest of the graph continues. (Interactive retry of a failed node is planned.)
- Subagent sessions are ephemeral (`--no-session`); the transcript cards, results table, and plan file are the durable record, with large outputs truncated.
- No resume of an interrupted run — re-plan with `/dag-plan` if you need to continue.
- The file lock covers the `read`/`write`/`edit` tools only; `bash`-mediated file mutations are not intercepted (see [Concurrent file conflicts](#concurrent-file-conflicts)).
