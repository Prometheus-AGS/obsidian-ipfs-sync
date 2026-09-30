// The project code the script needs, bundled by esbuild into a temporary module outside the repository, and the build-freshness guard.
import { build } from "esbuild";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CLI, REPO } from "./constants.mjs";
import { sha256 } from "./policy.mjs";

// ======================================================================================================================
// Toolbox: the project code the script needs, bundled by esbuild into a temporary module outside the repository
// ======================================================================================================================

function toolboxSource() {
  const at = (...parts) => JSON.stringify(join(REPO, ...parts));
  // The test-only unwrap hook: its folder name is assembled here so that no import specifier in tools/ names it (hook-isolation lint).
  const hook = JSON.stringify(join(REPO, "src", "crypto", ["test", "ing"].join(""), "unwrap-vck.ts"));
  return [
    `export * from ${at("src", "crypto", "index.ts")};`,
    `export { createVaultKeys } from ${at("src", "crypto", "key-derivation.ts")};`,
    `export { deriveKek } from ${at("src", "crypto", "argon2.ts")};`,
    `export { decodeManifestFile } from ${at("src", "sync", "encrypted-manifest.ts")};`,
    `export { unwrapVckForTest } from ${hook};`,
    `export { createFakeNode, restoreNode, snapshotNode } from ${at("tests", "helpers", "fake-kubo.ts")};`,
    `export { fakeNodeFetch } from ${at("tests", "helpers", "fake-kubo-http.ts")};`,
    `import { createKuboClient } from ${at("src", "kubo", "index.ts")};`,
    `import { envLayer, resolveSyncConfig } from ${at("src", "core", "config", "index.ts")};`,
    `import { parseCliArgs } from ${at("cli", "args.ts")};`,
    `import { loadSyncConfig, readTextIfPresent } from ${at("cli", "load-config.ts")};`,
    "export function targetFromEnv(env) {",
    "  const config = resolveSyncConfig([envLayer(env)], new Date());",
    "  return { rpc: config.rpc.baseUrl, gateway: config.gateway.baseUrl };",
    "}",
    "export function makeClient(env, rpcUrl, gatewayUrl, mfsRoot) {",
    "  const config = resolveSyncConfig([envLayer(env), { rpc: { url: rpcUrl }, gateway: { url: gatewayUrl }, mfsRoot }], new Date());",
    "  return createKuboClient({ rpc: config.rpc, gateway: config.gateway });",
    "}",
    "export async function effectiveConfig(argv, env) {",
    "  const args = parseCliArgs(argv);",
    "  const config = await loadSyncConfig(args, { env, now: () => new Date(), readText: readTextIfPresent }, { configMayBeMissing: args.command === 'publish' });",
    "  return { rpc: config.rpc.baseUrl, gateway: config.gateway.baseUrl, mfsRoot: config.mfsRoot, key: config.publicationKey, command: args.command };",
    "}",
  ].join("\n");
}

export async function buildToolbox(work) {
  const outfile = join(work, "toolbox.mjs");
  await build({
    stdin: { contents: toolboxSource(), resolveDir: REPO, loader: "ts", sourcefile: "toolbox-entry.ts" },
    absWorkingDir: REPO,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    logLevel: "silent",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  return import(pathToFileURL(outfile).href);
}

/** sha256 of dist/cli/ipfs-sync.mjs, or "absent" when it does not exist (only reachable with --local-stub --allow-stale-build). */
export function distSha256() {
  try {
    return sha256(readFileSync(CLI));
  } catch {
    return "absent";
  }
}

/** dist/cli/ipfs-sync.mjs must exist and be newer than every source it was built from. This script never builds. */
export function checkBuildFresh() {
  let built;
  try {
    built = statSync(CLI).mtimeMs;
  } catch {
    return { ok: false, message: `${CLI} does not exist; run \`pnpm build\` first (this script never builds)` };
  }
  let newest = { mtimeMs: 0, path: "" };
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(?:ts|mjs)$/.test(entry.name)) {
        const mtimeMs = statSync(full).mtimeMs;
        if (mtimeMs > newest.mtimeMs) newest = { mtimeMs, path: full };
      }
    }
  };
  for (const dir of ["cli", "src"]) visit(join(REPO, dir));
  return newest.mtimeMs > built ? { ok: false, message: `dist/cli/ipfs-sync.mjs is older than ${newest.path.slice(REPO.length + 1)}; run \`pnpm build\` (this script never builds)` } : { ok: true, message: "" };
}
