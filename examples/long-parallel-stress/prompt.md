# Long parallel fan-out (OOM stress test)

A wide-parallel plan meant to keep `maxParallel` (currently 3) concurrent
subagents running for tens of minutes, to verify the scheduler and host
process hold up without out-of-memory errors.

**Expected DAG** — 16 steps:
- wave 1: `s1` scaffold (package.json, tsconfig, npm install, `src/types.ts`, smoke test)
- waves 2–5: `s2`–`s13` — 12 independent module nodes, 3 at a time
- wave 6: `s14` — `src/index.ts` (first full `tsc --noEmit`)
- wave 7: `s15` — full test suite + fix failures
- wave 8: `s16` — `README.md`

Module steps share no `touches` and depend only on the scaffold, so the
scheduler should start 3 and top up to 3 as each completes — 4 continuous
waves of concurrent long-running nodes.

## Prompt

```text
/dag-plan Build a TypeScript data-transformation library called `transforms` in the current directory, as a wide-parallel project with 12 independent modules.
The plan should be about 16 steps: 1 scaffold, 12 module steps (strictly one step per module — do not combine two modules into one step), 1 index step, 1 final test/fix step, and 1 README step.

Step 1 — scaffold (depends on nothing):
- package.json (name "transforms", type "module", script "test": "vitest run")
- tsconfig.json (strict, NodeNext)
- `npm i -D typescript vitest @types/node`
- src/types.ts: shared Transform interface (name, transform(input, options?) -> string)
- test/smoke.test.ts: one trivial transform test proving vitest + tsconfig work; `npx vitest run test/smoke.test.ts` must pass
- touches: package.json, package-lock.json, node_modules, tsconfig.json, src/types.ts, test/smoke.test.ts

Steps 2–13 — one step per module, all 12; each depends only on the scaffold step;
touches exactly its two files ("src/<name>.ts", "test/<name>.test.ts"); fully self-contained.
Modules:
  1. csv      — CSV parse + serialize (RFC-4180 quoting/escaping, embedded newlines, empty input)
  2. json     — JSON minify + pretty-print (sortKeys option, unicode pass-through)
  3. toml     — minimal TOML emit + parse (key-value, arrays, nested tables, comments)
  4. xml      — minimal XML serialize (attributes, nesting, entity escaping)
  5. tsv      — TSV roundtrip with \t escaping
  6. ini      — INI parse (sections, comments, booleans, numbers)
  7. date     — ISO-8601 parse/format, offsets, duration parsing
  8. geohash  — geohash encode/decode (precision 1-9)
  9. rle      — run-length encode/decode (custom alphabets)
  10. checksum — sha1/sha256 digests, hex + base64 output, via node:crypto
  11. base64  — base64 + URL-safe encode/decode, padding, binary<->string
  12. units   — unit conversion (length, mass, temperature, data rate; decimal/binary)

Each module step: write src/<name>.ts (typed options, exports, JSDoc) and test/<name>.test.ts
with 15+ test cases (malformed input, empty input, options, known fixed values).
Verify: `npx vitest run test/<name>.test.ts` must pass.
Constraints: do NOT run `npx tsc`, do NOT run `npm`/`pnpm`, and do NOT edit any file
outside your two declared files — tooling and shared files are the scaffold step's territory.

Step 14 — index: create src/index.ts re-exporting all 12 transforms plus a registry object;
run `npx tsc --noEmit` (first whole-project typecheck) and fix any failures. touches: ["src/index.ts"].
Step 15 — suite: run `npx vitest run` and `npx tsc --noEmit` on the whole repo; fix anything
failing by reading each file directly (do not rely on the injected dependency reports);
verify both pass; report exactly which files you edited. touches: ["src/"].
Step 16 — README: overview, a table of all 12 transforms (name, purpose, usage example),
install/run instructions. touches: ["README.md"].

Success criteria: `npx tsc --noEmit` clean and `npx vitest run` passing with 170+ tests.
Planner note: the 12 module steps are the parallel core — no shared touches, single dependency
on the scaffold, so 3 should run at a time across 4 waves. Write each module's name, file
paths, options, and verify commands into its own prompt; keep module prompts near 150 words.
```

## What to check during the run

- **Concurrency cap.** `watch -n 2 "ps -eo pid,rss,etimes,args | grep -- 'pi --mode json' | grep -v grep"`
  → exactly 3 child processes at once during waves 2–5, 0 in between. Four alive simultaneously
  means the worker pool is broken.
- **OOM kills.** `dmesg -T | grep -iE 'oom|killed process'` (or `journalctl -k`). Also scan the
  final summary for a node at exit 137 / `✗ failed (Killed)`.
- **RSS trends.** Child RSS grows with conversation history as each node turns — expect a gentle
  climb that plateaus into the hundreds of MB. Baseline is ~1–2 GB total
  (parent + 3 full `pi` subprocesses), so on low-RAM machines (<8 GB) the baseline itself can
  OOM — worth knowing before blaming the scheduler.
- **Parent stays stable.** The host only holds capped per-node state (16 KB dep injection,
  200 snippets/node, one final report per node) and should sit flat in the hundreds of MB.
  If its RSS grows in step with wave count, that's a real in-memory leak in executor/index.
- **Durable record.** `ls -lh ~/.agents/plans/` — the plan file's `## Results` table should
  list every node; final summary usage totals = planner + 16 nodes.

## Variant (longer run)

Swap in 16 module names (add e.g. `yaml`, `csv2json`, `gzip-roundtrip`, `zip-roundtrip`) →
20 steps, exactly the soft `maxSteps` (⚠ warning on the plan card, not a rejection; hard ceiling
is 32). The module waves become 4 extra waves (~1–2× wall time).
