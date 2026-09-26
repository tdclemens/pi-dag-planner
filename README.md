# pi-dag-plan

A [pi.dev](https://pi.dev) extension that adds two commands:

- **`/dag-plan`** — describe a task, get a directed acyclic graph (DAG) plan back, review it, and on approval watch it execute as parallel subagents with live progress in the pi TUI.
- **`/dag-compile`** — same pipeline, driven by the uncommitted diff of `PRODUCT.md`: change what the product should be, and the codebase compiles itself in line with it.

Plan first, parallelize everything, show your work.

```
/dag-plan Add unit tests for src/parser.ts and run them
```

```
DAG Plan — 4 steps
2 waves
├─ wave 1 (parallel)
  ● s1  Survey repo structure
  ● s2  Read src/parser.ts and its usages
└─ wave 2
  ● s3  Write tests for parser  (← s1, s2)
  ● s4  Run tests and fix failures  (← s3)

? DAG plan — what next?  › Execute plan · Refine (re-plan) · Reject
```

## Features

- **DAG plans** — the model drafts self-contained steps with explicit dependencies; plans are validated against a JSON Schema (draft 2020-12, ajv) plus DAG rules (unique ids, known deps, no cycles) before anything runs.
- **Parallel execution** — a ready-set scheduler (Kahn's algorithm) runs every node whose dependencies are complete, up to `maxParallel` at a time (default 4). Set `parallel: false` for strict sequential mode.
- **Live feedback** — a runner panel shows per-node status, durations, and command snippets; each finished node appends a result card to the transcript and to the plan file.
- **Safe concurrency** — three layers keep parallel nodes from corrupting shared files (see [How it works](#how-it-works)).
- **Durable records** — plans save to `~/.agents/plans/` as markdown with the exact JSON and post-run results, plus a run-state sidecar for resume.
- **Refine loop** — steer the plan before spending tokens on execution (up to 3 refine rounds).

## Install

```bash
pi install git:<host>/<user>/dag-planner
```

Or run from a clone — no build step, pi loads the extension via jiti:

```bash
git clone <this-repo> dag-planner && cd dag-planner
pi -e ./src/index.ts
```

## Usage

### `/dag-plan`

```
/dag-plan <prompt>
```

1. **Plan** — your active model drafts the DAG. By default it first explores the repo as a read-only subagent so the plan cites real paths and exact commands.
2. **Review** — the plan renders as a wave/dependency card (**Ctrl+O** expands the raw JSON). Choose **Execute**, **Refine** with feedback, or **Reject**.
3. **Execute** — independent branches run as parallel subagents; Esc cancels, Ctrl+O expands per-node reports while running.

```
DAG runner — 2/4 done, 1 running, 1 pending (esc: cancel)
✓ s1  Survey repo structure              14.2s
✓ s2  Read src/parser.ts and its usages  18.9s
▶ s3  Write tests for parser   → $ ls src/
○ s4  Run tests and fix failures (waiting: s3)
```

**Resume.** Every run writes a sidecar (`<plan>.run.json`) as nodes complete. Interrupted, crashed, or partially failed runs continue from where they left off — completed nodes are restored, the rest re-run:

```
/dag-plan resume ~/.agents/plans/20250101-120000-add-unit-tests.md
```

### `/dag-compile`

`PRODUCT.md` in the project root is the source of truth for what the product should be. The command reads its uncommitted git diff and drafts a DAG plan for the changes that bring the code in line — same review card, gate, execution, and plan files as `/dag-plan`.

| State | Behavior |
|-------|----------|
| No `PRODUCT.md` | Stops, points you at `/dag-compile init` |
| `PRODUCT.md` unmodified (empty diff) | Nothing to compile — edit the spec, re-run |
| Uncommitted diff present | Plans against the diff |

- **`/dag-compile init`** — generates `PRODUCT.md` (a read-only subagent explores the repo and writes a concise spec: title, overview, `## Features`, `## Goals`, `## Constraints`). Never overwrites an existing file. **Commit it** — the compile diffs against the committed baseline.
- **`/dag-compile clean`** — plans against the *entire* file, no diff, so it works even fully committed or outside git. One-way reconciliation: it adds what the spec requires and fixes what the code gets wrong, but removes nothing. A spec that already matches yields a no-op plan.

The intended loop: `init` → commit baseline → edit `PRODUCT.md` → `/dag-compile` → commit spec and code.

## How it works

**Planner.** The model must respond with one JSON document: `{ goal, steps: [{ id, title, prompt, dependsOn[], touches[] }] }`. `steps: []` is a valid no-op plan. Each step prompt is self-contained (subagents share no context) and kept to one unit of work — oversized steps get a ⚠ warning on the card. Invalid or cyclic plans are rejected and re-planned once with the error as feedback.

**Scheduler.** A worker pool runs every node whose dependencies are complete. `touches` are mutex-protected at the scheduler: a node holds its declared files/resources for its whole run, and a ready node whose touches collide stays pending (named in the runner panel) until the holder finishes.

**Nodes.** Each node is an isolated `pi --mode json -p --no-session` subprocess running the node's prompt plus truncated outputs of its prerequisites. Each report must end with `STATUS: success` or `STATUS: failure — <reason>`. Transient failures (crash, API error, truncated/empty response) auto-retry once with the failure reason fed back; an agent-reported task failure is not retried — the node is marked failed, its dependents skipped, and the rest of the graph continues.

**Conflict safety.** Parallel nodes write in the same working directory, so three defenses apply:

1. **Planner contract** — every step declares `touches` (files *and* shared resources like lockfiles, `node_modules`, ports). Overlap between unordered steps is flagged ⚠ on the plan card before you approve.
2. **Scheduler mutex** — declared `touches` are held for the node's whole run; colliding ready nodes wait.
3. **Per-node file lock** (`src/lock-guard.ts`) — the node's subagent hashes each file it reads and any `write`/`edit` whose target changed since the read is vetoed with an instruction to re-read and re-apply; after 3 stale retries on a file the node stops touching it and reports the conflict. Catches overlap the planner failed to declare.

Writes done purely through `bash` (e.g. `npm install` regenerating a lockfile) are not intercepted — declare them as `touches` so the scheduler serializes the owning steps.

**Project context files** in the root are injected into planner prompts (each optional, capped at 50 KB; compile diffs at 24 KB):

| File | Used by | Role |
|------|---------|------|
| `PLAN.md` | `/dag-plan` | Project-specific planning instructions (conventions, step size, definitions of done) — never "what" to plan |
| `PRODUCT.md` | `/dag-compile` | The spec being compiled toward |
| `AGENTS.md` / `CLAUDE.md` | `/dag-compile` | Agent conventions |
| `DESIGN.md` | `/dag-compile` | Design guidance |

## Configuration

All options are optional JSON config; project values override global per key. Invalid values fall back to defaults with a ⚠ notification.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/dag-plan.json` | Global (all projects) |
| `.pi/dag-plan.json` | Project-local (trusted projects only) |

```json
{
  "maxSteps": 20,
  "maxParallel": 4,
  "parallel": true,
  "nodeRetries": 1,
  "plannerExplore": true,
  "plannerExtensions": [],
  "runnerExtensions": []
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `maxSteps` | `20` | Soft step-count cap; plans above it get a ⚠ (hard ceiling 32, then rejected) |
| `maxParallel` | `4` | Max concurrent node subagents |
| `parallel` | `true` | `false` = one node at a time in DAG order (overrides `maxParallel`) |
| `nodeRetries` | `1` | Auto-retries per node for transient failures; agent-reported task failures are never retried |
| `plannerExplore` | `true` | Planner explores the repo first; `false` = faster blind single call |
| `plannerExtensions` | `[]` | Extra extension paths loaded into the planner subagent (e.g. web search) |
| `runnerExtensions` | `[]` | Extra extension paths loaded into every runner subagent |

Fixed limits (not configurable): 1 re-plan on invalid JSON, 3 refine rounds, plans in `~/.agents/plans/`, 8 KB per dep / 16 KB total injected into node prompts.

## Requirements

- pi (`@earendil-works/pi-coding-agent`) with a model selected (`/model`)
- Interactive TUI mode — the commands are no-ops in print/JSON/RPC modes

## Development

```bash
npm install
npm test           # unit tests: schema + DAG validation, JSON extraction, scheduler
npm run typecheck
```

```
src/
├── index.ts     # /dag-plan command, renderers, flow orchestration
├── compile.ts   # /dag-compile: PRODUCT.md diff + init/clean
├── planner.ts   # planner prompts, LLM call, JSON extraction + validation
├── schema.ts    # canonical plan JSON Schema (2020-12) + ajv
├── dag.ts       # graph validation (cycles, deps), topo levels
├── executor.ts  # ready-set scheduler + subagent subprocesses
├── config.ts    # dag-plan.json loading (global + project merge)
├── plans.ts     # ~/.agents/plans/ markdown writer + run-state sidecar
├── ui.ts        # plan card, result cards, live runner panel
├── lock-guard.ts# per-node optimistic file lock
└── types.ts     # shared types
```

## Examples

[`examples/`](./examples/README.md) contains ready-to-paste prompts that showcase different DAG shapes (wide fan-out, pipelines, feature-parallel).

## License

[MIT](./LICENSE)
