import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { test } from "node:test";
import { getExtensionVersion } from "../src/version.ts";

test("getExtensionVersion returns the package.json version", async () => {
	const packageJson = JSON.parse(await fsp.readFile(new URL("../package.json", import.meta.url), "utf8")) as {
		version: string;
	};
	assert.equal(await getExtensionVersion(), packageJson.version);
});
