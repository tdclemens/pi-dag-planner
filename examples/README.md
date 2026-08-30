# Examples

Prompt examples for the `/dag-plan` command. Each subdirectory contains a `prompt.md` with a short, self-contained prompt you can paste into pi. Nothing here is pre-built — these are prompts only.

| Example | Description | DAG shape |
|---------|-------------|-----------|
| [todo-cli](./todo-cli/prompt.md) | Zero-dependency Node.js todo CLI with tests | mostly sequential |
| [url-shortener](./url-shortener/prompt.md) | Express + SQLite short-URL web service | layered (storage → API → tests) |
| [markdown-blog](./markdown-blog/prompt.md) | Rails 8 blog app rendering Markdown posts | wide fan-out (content, model, views in parallel) |
| [image-pipeline](./image-pipeline/prompt.md) | Parallel image processing pipeline with sharp | pipeline with parallel workers |
| [snake-game](./snake-game/prompt.md) | Browser snake game with unit-testable game logic | feature-parallel |

Why these prompts work well with dag-plan:

- **Self-contained** — subagents share no context, so each prompt names the tech, file layout, entry points, and exact commands to run.
- **Parallelizable** — each prompt contains steps that are independent until a late integration point, so the planner can form wide waves instead of a single chain.
- **Verifiable** — each prompt ends with a success criterion (e.g. `npm test` passes) so a final step can run it and fix failures.
