/**
 * dag-plan configuration.
 *
 * Read from JSON config files in the usual pi extension locations. Project
 * values override global ones per key, and every option has a default, so a
 * missing config file (or a missing key) never changes behavior:
 *
 *   ~/.pi/agent/dag-plan.json    global (all projects)
 *   <cwd>/.pi/dag-plan.json      project-local (trusted projects only)
 *
 *   {
 *     "maxSteps": 12,            // soft step-count cap (planner guidance + plan-card warning)
 *     "maxParallel": 4,          // concurrent runner subagents
 *     "nodeRetries": 1,          // auto-retries per node for transient failures (0 disables)
 *     "plannerExplore": true,    // planner explores the repo (read-only) before planning
 *     "plannerExtensions": [],   // extra extensions loaded into the planner subagent
 *     "runnerExtensions": []     // extra extensions loaded into every runner node subagent
 *   }
 *
 * Extension paths may be absolute, start with `~/`, or be relative to the
 * directory of the config file that provides them (same convention as pi's
 * settings.json resource paths).
 *
 * Nothing here throws: invalid JSON or invalid field values fall back to
 * defaults and surface as `LoadedConfig.warnings` so the user can see them.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_STEPS } from "./dag.ts";
import { DEFAULT_MAX_PARALLEL, DEFAULT_NODE_RETRIES } from "./executor.ts";

/** Fully-resolved dag-plan configuration (defaults already applied). */
export interface DagPlanConfig {
	/** Soft step-count cap: planner size guidance + ⚠ warning on the plan card. */
	maxSteps: number;
	/** Max concurrent runner subagents. */
	maxParallel: number;
	/**
	 * Max auto-retries per node for transient failures (subprocess crash,
	 * model/API error, output truncation, empty response). Agent-reported
	 * task failures are never auto-retried. 0 disables auto-retry.
	 */
	nodeRetries: number;
	/**
	 * Planner explores the repo as a read-only subagent before planning.
	 * `false` = the faster single blind LLM call (no tools).
	 */
	plannerExplore: boolean;
	/** Extra extensions loaded into the planner subagent via `-e` (resolved absolute paths). */
	plannerExtensions: string[];
	/** Extra extensions loaded into every runner node subagent via `-e` (resolved absolute paths). */
	runnerExtensions: string[];
}

export const DEFAULT_CONFIG: DagPlanConfig = {
	maxSteps: DEFAULT_MAX_STEPS,
	maxParallel: DEFAULT_MAX_PARALLEL,
	nodeRetries: DEFAULT_NODE_RETRIES,
	plannerExplore: true,
	plannerExtensions: [],
	runnerExtensions: [],
};

/** Config file name in the usual pi extension locations. */
export const CONFIG_FILE_NAME = "dag-plan.json";

/** Global config path: `<agent dir>/dag-plan.json` (usually `~/.pi/agent/dag-plan.json`). */
export function globalConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

/** Project config path: `<cwd>/.pi/dag-plan.json`, or undefined without a cwd. */
export function projectConfigPath(cwd?: string): string | undefined {
	return cwd ? join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME) : undefined;
}

export interface LoadedConfig {
	config: DagPlanConfig;
	/** Non-fatal problems (invalid JSON, invalid values) — defaults were applied. */
	warnings: string[];
	/** Config files that existed and were read (global first, then project). */
	loadedFrom: string[];
}

/**
 * Load and merge the config for `cwd`.
 *
 * Global and project files are parsed independently; for each key, a value
 * present in the project file replaces the global one (arrays replace, they
 * do not merge — same as pi's settings files). Extension paths are resolved
 * to absolute paths against the directory of the file that provides them,
 * before merging. Missing files yield pure defaults; invalid JSON or invalid
 * field values yield defaults plus a warning — loadConfig never throws.
 */
export function loadConfig(cwd?: string): LoadedConfig {
	const warnings: string[] = [];
	const loadedFrom: string[] = [];
	let merged: Record<string, unknown> = {};

	const entries: Array<{ path: string; baseDir: string; label: string }> = [
		{ path: globalConfigPath(), baseDir: getAgentDir(), label: "global" },
	];
	const projectPath = projectConfigPath(cwd);
	if (projectPath && cwd) entries.push({ path: projectPath, baseDir: join(cwd, CONFIG_DIR_NAME), label: "project" });

	for (const { path, baseDir, label } of entries) {
		if (!existsSync(path)) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			warnings.push(`${label} config ${path}: invalid JSON (${errMsg(e)}) — file ignored`);
			continue;
		}
		if (!isPlainObject(raw)) {
			warnings.push(`${label} config ${path}: top level must be a JSON object — file ignored`);
			continue;
		}
		loadedFrom.push(path);
		merged = { ...merged, ...resolveExtensionPaths(raw, baseDir) };
	}

	const parsed = parseConfig(merged);
	warnings.push(...parsed.warnings);
	return { config: parsed.config, warnings, loadedFrom };
}

export interface ParsedConfig {
	config: DagPlanConfig;
	warnings: string[];
}

/**
 * Coerce a (merged) raw config object into a fully-resolved DagPlanConfig.
 * Pure (no I/O) — unit-testable. Unknown keys and invalid values fall back
 * to DEFAULT_CONFIG and produce one warning per offending entry.
 */
export function parseConfig(raw: Record<string, unknown>): ParsedConfig {
	const warnings: string[] = [];
	const config: DagPlanConfig = {
		maxSteps: DEFAULT_CONFIG.maxSteps,
		maxParallel: DEFAULT_CONFIG.maxParallel,
		nodeRetries: DEFAULT_CONFIG.nodeRetries,
		plannerExplore: DEFAULT_CONFIG.plannerExplore,
		plannerExtensions: [],
		runnerExtensions: [],
	};
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "maxSteps": {
				const n = positiveInt(value, key, warnings);
				if (n !== undefined) config.maxSteps = n;
				break;
			}
			case "maxParallel": {
				const n = positiveInt(value, key, warnings);
				if (n !== undefined) config.maxParallel = n;
				break;
			}
			case "nodeRetries": {
				const n = nonNegativeInt(value, key, warnings);
				if (n !== undefined) config.nodeRetries = n;
				break;
			}
			case "plannerExplore":
				if (typeof value === "boolean") config.plannerExplore = value;
				else
					warnings.push(
						`"plannerExplore" must be true or false (got ${describe(value)}) — using default ${DEFAULT_CONFIG.plannerExplore}`,
					);
				break;
			case "plannerExtensions":
				config.plannerExtensions = stringList(value, key, warnings);
				break;
			case "runnerExtensions":
				config.runnerExtensions = stringList(value, key, warnings);
				break;
			default:
				warnings.push(
					`unknown key "${key}" — ignored (known keys: ${Object.keys(DEFAULT_CONFIG).join(", ")})`,
				);
		}
	}
	return { config, warnings };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Resolve relative extension paths in one config file against its directory. */
function resolveExtensionPaths(raw: Record<string, unknown>, baseDir: string): Record<string, unknown> {
	const out: Record<string, unknown> = { ...raw };
	for (const key of ["plannerExtensions", "runnerExtensions"] as const) {
		const value = raw[key];
		if (Array.isArray(value)) {
			out[key] = value.map((e) =>
				typeof e === "string" && e.trim() ? resolveExtensionPath(e.trim(), baseDir) : e,
			);
		}
	}
	return out;
}

function resolveExtensionPath(p: string, baseDir: string): string {
	if (p.startsWith("~/")) return resolve(join(homedir(), p.slice(2)));
	return isAbsolute(p) ? resolve(p) : resolve(baseDir, p);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function positiveInt(value: unknown, key: string, warnings: string[]): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	warnings.push(`"${key}" must be an integer >= 1 (got ${describe(value)}) — using default`);
	return undefined;
}

function nonNegativeInt(value: unknown, key: string, warnings: string[]): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	warnings.push(`"${key}" must be an integer >= 0 (got ${describe(value)}) — using default`);
	return undefined;
}

function stringList(value: unknown, key: string, warnings: string[]): string[] {
	if (!Array.isArray(value)) {
		warnings.push(`"${key}" must be an array of extension paths (got ${describe(value)}) — using default []`);
		return [];
	}
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.trim()) {
			const p = entry.trim();
			if (!out.includes(p)) out.push(p);
		} else {
			warnings.push(`"${key}" entries must be non-empty strings (got ${describe(entry)}) — entry ignored`);
		}
	}
	return out;
}

function describe(v: unknown): string {
	try {
		const s = JSON.stringify(v);
		if (s === undefined) return String(v);
		return s.length > 40 ? s.slice(0, 40) + "…" : s;
	} catch {
		return String(v);
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
