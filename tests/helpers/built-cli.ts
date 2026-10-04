import { build } from "esbuild";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(__dirname, "..", "..");

/**
 * A temporary build directory for the operator-run harness tests: dist-shaped (`plugin/`, `cli/`) with the REAL CLI bundle built from the
 * current sources by the project's own esbuild options (bytes in a temp directory; nothing is written under the repository). The plugin
 * files are small stand-ins: the harness hashes and installs them but never runs them.
 */
export async function buildTestDist(prefix = "fop07-dist-"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "plugin"));
  mkdirSync(join(dir, "cli"));
  writeFileSync(join(dir, "plugin", "main.js"), "main bytes");
  writeFileSync(join(dir, "plugin", "manifest.json"), JSON.stringify({ id: "obsidian-ipfs-sync", version: "0.3.0" }));
  const options = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "esbuild.options.mjs")).href)) as { cliOptions(prod: boolean): Record<string, unknown> };
  await build({ ...options.cliOptions(true), absWorkingDir: ROOT, outfile: join(dir, "cli", "ipfs-sync.mjs"), logLevel: "silent" });
  return dir;
}
