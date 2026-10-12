import { createProcessIo } from "./io";
import { readTextIfPresent } from "./load-config";
import { runCli } from "./run";
import { embeddedPgliteOptions } from "./store/pglite-embedded-assets";
import { provideEmbeddedPgliteAssets } from "./store/pglite-store";

// This bundle is shipped as one file with no sidecar assets, so the PGlite runtime (pglite.data, pglite.wasm,
// initdb.wasm) is embedded by esbuild and registered here, before any command can open the history store.
provideEmbeddedPgliteAssets(embeddedPgliteOptions);

runCli(
  process.argv.slice(2),
  {
    env: process.env,
    now: () => new Date(),
    readText: readTextIfPresent,
    // The prompt needs standard input to be a terminal; `init` also checks that standard error is one before it shows a passphrase.
    ...(process.stdin.isTTY ? { terminal: { input: process.stdin, output: process.stderr } } : {}),
  },
  createProcessIo(),
).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`ipfs-sync: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
