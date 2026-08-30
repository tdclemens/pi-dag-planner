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

1. **Plan** — your prompt is sent to your active model with a DAG-planner system prompt. The model must respond with a single JSON document: `{ goal, steps: [{ id, title, prompt, dependsOn[] }] }`. Each step prompt is self-contained because subagents have no shared context.
2. **Review** — the plan is rendered as a friendly wave/dependency view in the chat (the raw JSON is the source of truth and appears when you expand the card with **Ctrl+O**). You choose:
   - **Execute plan**
   - **Refine** — give the planner feedback and re-plan (up to 3 rounds)
   - **Reject** — the plan file is kept for reference
3. **Save** — before execution, the plan is written to `~/.agents/plans/<timestamp>-<slug>.md` with the human-readable step list and the exact JSON embedded.
4. **Execute** — the DAG is scheduled with Kahn's algorithm: a worker pool (default 4, bounded by `DAG_PLAN_MAX_PARALLEL`) runs every node whose dependencies are complete, so independent branches execute concurrently. Each node is a **subagent**: an isolated `pi --mode json -p --no-session` subprocess running the node's prompt plus (truncated) outputs of its prerequisite nodes.
5. **Watch** — a live runner panel replaces the editor while the graph executes, showing per-node status and snippets of the commands the subagents run:

   ```
   DAG runner — 2/4 done, 1 running, 1 pending (esc: cancel)
   ✓ s1  Survey repo structure              14.2s
   ✓ s2  Read src/parser.ts and its usages  18.9s
   ▶ s3  Write tests for parser   → $ ls src/
   ○ s4  Run tests and fix failures (waiting: s3)
   ```

   When a node finishes, a subagent-style card is appended to the transcript (command snippets, final output, usage), and the markdown plan file gets a **Results** section. **Esc** cancels the run (children are terminated, state is finalized).

   Node status icons (single-cell, non-emoji, so the column aligns in any terminal): `○` pending · `▶` running · `✓` done · `✗` failed · `⊘` skipped · `■` aborted. Usage lines show `↑` input tokens, `↓` output tokens, `R`/`W` cache read/write, then cost and model.

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
├── dag.ts       # pure DAG utils: validation (cycles, deps), topological levels
├── executor.ts  # ready-set scheduler + pi subprocess subagents + JSONL parsing
├── ui.ts        # plan renderer, node result cards, live runner dashboard, snippets
├── plans.ts     # ~/.agents/plans/ markdown writer (plan + results append)
└── types.ts     # shared types
```

## Development

```bash
npm install        # dev dependencies only (typescript, test runner)
npm test           # unit tests: DAG validation, JSON extraction, scheduler
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
