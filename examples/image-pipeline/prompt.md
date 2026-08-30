# Image Pipeline

A pipeline with parallel workers: each stage is independent code, the runner parallelizes across files.

## Prompt

```text
/dag-plan Build an image processing pipeline in Node.js using sharp (only dep).
- Input: a directory of images; three stages, each reading the previous stage's output dir:
  1. resize to max width 1600px
  2. convert to webp, quality 80
  3. watermark "sample" text in the bottom-right corner
- Pipeline runner (src/pipeline.js) processes files with a worker pool (concurrency from CLI flag, default 4) and records per-file status and duration
- Entry point bin/pipeline.js: `node bin/pipeline.js <inputDir> [concurrency]` writes to out/ and prints a summary
- Also write out/summary.json: { total, ok, failed, perFile: [{ file, status, ms }] }
- `npm run demo` generates five small gradient test images (no external assets) then runs the pipeline on them
- Tests: node:test on each stage using tiny generated images; `npm test` must pass
```
