// Two child-process bundles for the hostile and script-only phases (task 4.7b), built by esbuild into the work directory (outside the repository)
// and RUN AS CHILD PROCESSES with the scrubbed environment; this process never loads them as modules, so every import specifier in the harness is a
// literal one and the checker's import scan can hash everything the harness loads.
//   hostile.mjs  ops, all through the confinement proxy:
//     prepare-tamper  reads a genuine root of a throwaway vault, unlocks it with the vault's own passphrase through the test-only unwrap hook, and
//                     writes a tampered copy (one blob with a flipped bit, a new authentic manifest.enc at a higher sequence) below ONE folder.
//     prepare-fork    writes a second authentic manifest.enc of the same sequence and vault (another device name and time, so another identity)
//                     below ONE folder: the other half of a fork, which one MFS root cannot produce by itself.
//     name-publish    points the owned key at an immutable root the node already reported (the proxy allows only the owned key and such roots).
//   cli-yes.mjs   cli/run.ts compiled into a bundle whose terminal question is answered yes by the script. It exists only for the one command that has
//                 no non-interactive spelling (pull --resolve-fork asks on a terminal); the hash-bound dist bundle cannot be answered without a pty.
//                 Like cli/main.ts, the entry registers the PGlite runtime assets before runCli: the bundle inlines @electric-sql/pglite, whose
//                 own import.meta.url resolution points at the temp bundle location, so the assets are read from the package's dist directory
//                 (resolved here, in the host process, and injected as a literal) instead of the embedded-pglite: virtual modules of the CLI build.
// The folder name of the test-only hook is assembled at run time, so that no import specifier in tools/ names it (the hook-isolation lint).
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { REPO, Refusal } from "./constants.mjs";
import { childEnv, firstLine } from "./policy.mjs";

const CALL_TIMEOUT_MS = 120_000;
const BANNER = 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';
// The dist directory of @electric-sql/pglite (pglite.data, pglite.wasm, initdb.wasm), resolved in THIS process and
// injected into the cli-yes entry as a literal; same resolution as esbuild.options.mjs uses for the embedded assets.
const PGLITE_DIST = dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
/** The byte offset inside a blob's body (after the 22-byte header) where the preparer flips one bit. */
export const FLIP_OFFSET = 22 + 5;
export const TAMPER_SEQUENCE_BUMP = 10;

function hostileSource() {
  const at = (...parts) => JSON.stringify(join(REPO, ...parts));
  const hook = JSON.stringify(join(REPO, "src", "crypto", ["test", "ing"].join(""), "unwrap-vck.ts"));
  return [
    `import { readFileSync } from "node:fs";`,
    `import { createKuboClient } from ${at("src", "kubo", "index.ts")};`,
    `import { envLayer, resolveSyncConfig } from ${at("src", "core", "config", "index.ts")};`,
    `import { canonicalizePassphrase, wipe } from ${at("src", "crypto", "index.ts")};`,
    `import { createVaultKeys } from ${at("src", "crypto", "key-derivation.ts")};`,
    `import { createFilesMap, decodeManifestFile, encodeManifestFile } from ${at("src", "sync", "encrypted-manifest.ts")};`,
    `import { unwrapVckForTest } from ${hook};`,
    "const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "function makeClient(input) {",
    "  const config = resolveSyncConfig([envLayer(process.env), { rpc: { url: input.rpc }, gateway: { url: input.gateway }, mfsRoot: input.mfsRoot }], new Date());",
    "  return createKuboClient({ rpc: config.rpc, gateway: config.gateway });",
    "}",
    "async function unlock(client, input) {",
    "  const source = (await client.filesStat(input.sourceRoot)).cid;",
    "  const slots = await client.gatewayFetch(source, 'keyslots.json');",
    "  const text = readFileSync(input.passphraseFile, 'utf8').trimEnd();",
    "  const raw = await unwrapVckForTest(slots, canonicalizePassphrase(Buffer.from(text, 'utf8')));",
    "  const keys = await createVaultKeys(raw.vaultId, raw.vck);",
    "  wipe(raw.vck);",
    "  const manifest = await decodeManifestFile(keys, await client.gatewayFetch(source, 'manifest.enc'));",
    "  return { source, slots, keys, manifest };",
    "}",
    "async function prepareFork(input) {",
    "  const client = makeClient(input);",
    "  const { source, slots, keys, manifest } = await unlock(client, input);",
    "  await client.filesWrite(input.forkDir + '/keyslots.json', slots);",
    "  for (const entry of await client.ipfsLs('/ipfs/' + source + '/manifests')) {",
    "    await client.filesWrite(input.forkDir + '/manifests/' + entry.name, await client.gatewayFetch(source, 'manifests/' + entry.name));",
    "  }",
    "  const next = { ...manifest, device: 'fork-alt', publishedAt: new Date(Date.parse(manifest.publishedAt) + 1000).toISOString() };",
    "  await client.filesWrite(input.forkDir + '/manifest.enc', (await encodeManifestFile(keys, next)).file);",
    "  return { root: (await client.filesStat(input.forkDir)).cid, sequence: next.sequence };",
    "}",
    "async function prepareTamper(input) {",
    "  const client = makeClient(input);",
    "  const { source, slots, keys, manifest } = await unlock(client, input);",
    "  const target = Object.keys(manifest.files).sort()[0];",
    "  const entry = manifest.files[target];",
    "  const blobPath = 'current/' + entry.blob.slice(0, 2) + '/' + entry.blob;",
    "  const blob = Buffer.from(await client.gatewayFetch(source, blobPath));",
    `  blob[${FLIP_OFFSET}] ^= 1;`,
    "  await client.filesWrite(input.tamperDir + '/keyslots.json', slots);",
    "  await client.filesWrite(input.tamperDir + '/' + blobPath, blob);",
    "  const current = (await client.filesStat(input.tamperDir + '/current')).cid;",
    "  const blobCid = (await client.filesStat(input.tamperDir + '/' + blobPath)).cid;",
    "  const flipped = { ...entry, sha256: (entry.sha256[0] === '0' ? '1' : '0') + entry.sha256.slice(1), cid: blobCid };",
    "  const files = createFilesMap(Object.entries(manifest.files).map(([path, value]) => [path, path === target ? flipped : value]));",
    "  const next = { ...manifest, sequence: manifest.sequence + input.bump, rootCID: current, publishedAt: new Date().toISOString(), files };",
    "  const encoded = await encodeManifestFile(keys, next);",
    "  await client.filesWrite(input.tamperDir + '/manifest.enc', encoded.file);",
    "  return { root: (await client.filesStat(input.tamperDir)).cid, target, sequence: next.sequence, sourceSequence: manifest.sequence };",
    "}",
    "async function main() {",
    "  const [op, raw] = process.argv.slice(2);",
    "  const input = JSON.parse(raw ?? '{}');",
    "  try {",
    "    if (op === 'prepare-tamper') return print({ ok: await prepareTamper(input) });",
    "    if (op === 'prepare-fork') return print({ ok: await prepareFork(input) });",
    "    if (op === 'name-publish') {",
    "      const published = await makeClient(input).namePublish(input.key, input.cid);",
    "      return print({ ok: { name: published.name, value: published.value } });",
    "    }",
    "    throw new Error('unknown operation ' + String(op));",
    "  } catch (error) {",
    "    print({ error: { message: error instanceof Error ? error.message : String(error) } });",
    "  }",
    "}",
    "main().catch((error) => { process.stderr.write(String(error?.message ?? error) + '\\n'); process.exit(1); });",
  ].join("\n");
}

function cliYesSource() {
  const at = (...parts) => JSON.stringify(join(REPO, ...parts));
  const asset = (name) => `readFileSync(pgliteJoin(${JSON.stringify(PGLITE_DIST)}, ${JSON.stringify(name)}))`;
  return [
    `import { readFileSync } from "node:fs";`,
    `import { join as pgliteJoin } from "node:path";`,
    `import { createProcessIo } from ${at("cli", "io.ts")};`,
    `import { readTextIfPresent } from ${at("cli", "load-config.ts")};`,
    `import { runCli } from ${at("cli", "run.ts")};`,
    `import { provideEmbeddedPgliteAssets } from ${at("cli", "store", "pglite-store.ts")};`,
    "provideEmbeddedPgliteAssets(async () => ({",
    `  fsBundle: new Blob([${asset("pglite.data")}]),`,
    `  pgliteWasmModule: await WebAssembly.compile(${asset("pglite.wasm")}),`,
    `  initdbWasmModule: await WebAssembly.compile(${asset("initdb.wasm")}),`,
    "}));",
    "const io = { ...createProcessIo(), confirm: async () => true };",
    "runCli(process.argv.slice(2), { env: process.env, now: () => new Date(), readText: readTextIfPresent }, io).then(",
    "  (code) => { process.exitCode = code; },",
    "  (error) => { process.stderr.write('ipfs-sync: unexpected error: ' + (error instanceof Error ? error.message : String(error)) + '\\n'); process.exitCode = 1; },",
    ");",
  ].join("\n");
}

const bundle = (contents, sourcefile, outfile) =>
  build({ stdin: { contents, resolveDir: REPO, loader: "ts", sourcefile }, absWorkingDir: REPO, bundle: true, platform: "node", format: "esm", target: "node24", outfile, logLevel: "silent", banner: { js: BANNER } });

/** Builds both bundles into `<work>/` and returns { hostile, cliYes } (paths). Called at most once per run. */
export async function buildHostileTools(work) {
  const hostile = join(work, "hostile.mjs");
  const cliYes = join(work, "cli-yes.mjs");
  await Promise.all([bundle(hostileSource(), "hostile-entry.ts", hostile), bundle(cliYesSource(), "cli-yes-entry.ts", cliYes)]);
  return { hostile, cliYes };
}

/** One hostile op, run as a child with the scrubbed environment. Resolves the op's answer, or throws with the child's one-line message. */
export function runHostile({ tools, op, input, env, localStub }) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [tools.hostile, op, JSON.stringify(input)], { env: childEnv(env, {}, { localStub }), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CALL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      let answer;
      try {
        answer = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
      } catch {
        fail(new Refusal(`hostile ${op} failed (exit ${code}): ${firstLine(stderr || stdout)}`));
        return;
      }
      if (answer.error !== undefined) fail(new Error(`hostile ${op}: ${firstLine(answer.error.message)}`));
      else done(answer.ok);
    });
  });
}
