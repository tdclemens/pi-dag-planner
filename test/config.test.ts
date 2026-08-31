import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { homedir } from "node:os";
import {
	DEFAULT_CONFIG,
	loadConfig,
	parseConfig,
	globalConfigPath,
	projectConfigPath,
	type LoadedConfig,
} from "../src/config.ts";

// ---------------------------------------------------------------------------
// parseConfig (pure)
// ---------------------------------------------------------------------------

test("parseConfig with {} yields all defaults", () => {
	const { config, warnings } = parseConfig({});
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);
});

test("parseConfig accepts valid values", () => {
	const { config, warnings } = parseConfig({
		maxSteps: 30,
		maxParallel: 8,
		plannerExplore: false,
		plannerExtensions: ["/tmp/a.ts"],
		runnerExtensions: ["/tmp/b.ts", "/tmp/c.ts"],
	});
	assert.equal(config.maxSteps, 30);
	assert.equal(config.maxParallel, 8);
	assert.equal(config.plannerExplore, false);
	assert.deepEqual(config.plannerExtensions, ["/tmp/a.ts"]);
	assert.deepEqual(config.runnerExtensions, ["/tmp/b.ts", "/tmp/c.ts"]);
	assert.deepEqual(warnings, []);
});

test("parseConfig falls back per bad key and warns", () => {
	const { config, warnings } = parseConfig({
		maxSteps: "twelve",
		maxParallel: 0,
		plannerExplore: "yes",
		plannerExtensions: "/tmp/a.ts",
		runnerExtensions: ["/tmp/ok.ts", "", 42],
		bogus: 1,
	});
	assert.equal(config.maxSteps, DEFAULT_CONFIG.maxSteps);
	assert.equal(config.maxParallel, DEFAULT_CONFIG.maxParallel);
	assert.equal(config.plannerExplore, DEFAULT_CONFIG.plannerExplore);
	assert.deepEqual(config.plannerExtensions, []);
	assert.deepEqual(config.runnerExtensions, ["/tmp/ok.ts"]);
	assert.equal(warnings.length, 7);
	assert.ok(warnings.some((w) => w.includes('"maxSteps"')));
	assert.ok(warnings.some((w) => w.includes('"maxParallel"')));
	assert.ok(warnings.some((w) => w.includes('"plannerExplore"')));
	assert.ok(warnings.some((w) => w.includes('"plannerExtensions"')));
	assert.ok(warnings.some((w) => w.includes('"runnerExtensions"')));
	assert.ok(warnings.some((w) => w.includes('"bogus"')));
});

test("parseConfig trims and de-duplicates extension entries", () => {
	const { config, warnings } = parseConfig({ runnerExtensions: [" /tmp/a.ts ", "/tmp/a.ts", "\t/tmp/b.ts"] });
	assert.deepEqual(config.runnerExtensions, ["/tmp/a.ts", "/tmp/b.ts"]);
	assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// loadConfig (I/O) — PI_CODING_AGENT_DIR pins the "global" agent dir
// ---------------------------------------------------------------------------

function withTempAgentDir(fn: (agentDir: string, projectDir: string) => void) {
	const agentDir = mkdtempSync(join(tmpdir(), "dagplan-agent-"));
	const projectDir = mkdtempSync(join(tmpdir(), "dagplan-project-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		fn(agentDir, projectDir);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}

test("loadConfig with no files yields defaults", () => {
	withTempAgentDir((_, projectDir) => {
		const out = loadConfig(projectDir);
		assert.deepEqual(out.config, DEFAULT_CONFIG);
		assert.deepEqual(out.warnings, []);
		assert.deepEqual(out.loadedFrom, []);
	});
});

test("loadConfig reads the global file", () => {
	withTempAgentDir((agentDir) => {
		writeFileSync(join(agentDir, "dag-plan.json"), JSON.stringify({ maxSteps: 25 }));
		const out = loadConfig("/tmp/definitely-no-project-config");
		assert.equal(out.config.maxSteps, 25);
		assert.equal(out.config.maxParallel, DEFAULT_CONFIG.maxParallel);
		assert.deepEqual(out.loadedFrom, [join(agentDir, "dag-plan.json")]);
	});
});

test("loadConfig reads the project file and overrides global per key", () => {
	withTempAgentDir((agentDir, projectDir) => {
		writeFileSync(join(agentDir, "dag-plan.json"), JSON.stringify({ maxSteps: 25, maxParallel: 2 }));
		mkdirSync(join(projectDir, ".pi"));
		writeFileSync(join(projectDir, ".pi/dag-plan.json"), JSON.stringify({ maxSteps: 9 }));
		const out = loadConfig(projectDir);
		assert.equal(out.config.maxSteps, 9, "project maxSteps wins");
		assert.equal(out.config.maxParallel, 2, "global maxParallel fills the gap");
		assert.equal(out.loadedFrom.length, 2);
	});
});

test("loadConfig resolves relative extension paths against the providing file", () => {
	withTempAgentDir((agentDir, projectDir) => {
		writeFileSync(join(agentDir, "dag-plan.json"), JSON.stringify({ plannerExtensions: ["my-planner-ext.ts"] }));
		mkdirSync(join(projectDir, ".pi"));
		writeFileSync(
			join(projectDir, ".pi/dag-plan.json"),
			JSON.stringify({ runnerExtensions: ["exts/runner-tools.ts"] }),
		);
		const out = loadConfig(projectDir);
		assert.deepEqual(out.config.plannerExtensions, [join(agentDir, "my-planner-ext.ts")]);
		assert.deepEqual(out.config.runnerExtensions, [join(projectDir, ".pi", "exts", "runner-tools.ts")]);
	});
});

test("loadConfig expands ~ and passes absolute paths through", () => {
	withTempAgentDir((_, projectDir) => {
		mkdirSync(join(projectDir, ".pi"));
		writeFileSync(
			join(projectDir, ".pi/dag-plan.json"),
			JSON.stringify({ runnerExtensions: ["~/my-ext/index.ts", "/abs/ext.ts"] }),
		);
		const out = loadConfig(projectDir);
		assert.deepEqual(out.config.runnerExtensions, [
			resolve(join(homedir(), "my-ext/index.ts")),
			"/abs/ext.ts",
		]);
	});
});

test("loadConfig warns on invalid JSON and keeps defaults for that file", () => {
	withTempAgentDir((agentDir, projectDir) => {
		writeFileSync(join(agentDir, "dag-plan.json"), "{ not json");
		mkdirSync(join(projectDir, ".pi"));
		writeFileSync(join(projectDir, ".pi/dag-plan.json"), JSON.stringify({ maxSteps: 7 }));
		const out = loadConfig(projectDir);
		assert.equal(out.config.maxSteps, 7, "project file still applies");
		assert.equal(out.warnings.length, 1);
		assert.match(out.warnings[0]!, /invalid JSON/);
		assert.equal(out.loadedFrom.length, 1);
	});
});

test("loadConfig warns on a non-object top level", () => {
	withTempAgentDir((agentDir) => {
		writeFileSync(join(agentDir, "dag-plan.json"), "[1, 2, 3]");
		const out: LoadedConfig = loadConfig("/tmp/definitely-no-project-config");
		assert.deepEqual(out.config, DEFAULT_CONFIG);
		assert.equal(out.warnings.length, 1);
		assert.match(out.warnings[0]!, /JSON object/);
	});
});

test("globalConfigPath and projectConfigPath point at the usual locations", () => {
	withTempAgentDir((agentDir, projectDir) => {
		assert.equal(globalConfigPath(), join(agentDir, "dag-plan.json"));
		assert.equal(projectConfigPath(projectDir), join(projectDir, ".pi/dag-plan.json"));
		assert.equal(projectConfigPath(undefined), undefined);
		// sanity: the agent dir is really honoring PI_CODING_AGENT_DIR
		assert.ok(existsSync(agentDir));
	});
});
