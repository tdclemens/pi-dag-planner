/**
 * Extension version, read from the package.json at the package root (one level
 * up from src/). Works from both the git checkout and a pi-installed copy,
 * since src/ keeps its layout. Falls back to "0.0.0" when the file is
 * missing or malformed.
 *
 * Reads synchronously: the file is small and this runs only when the user
 * invokes `--version`, while the sync return keeps the value directly
 * composable in one-liners (e.g. `import(...).then(m => ... + m.getExtensionVersion())`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

/** The package root's package.json, relative to this file (src/version.ts). */
const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

/** The extension's semantic version (MAJOR.MINOR.PATCH) from package.json. */
export function getExtensionVersion(): string {
	try {
		const raw = readFileSync(PACKAGE_JSON_PATH, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const version = (parsed as { version?: unknown })?.version;
		return typeof version === "string" && version !== "" ? version : FALLBACK_VERSION;
	} catch {
		return FALLBACK_VERSION;
	}
}
