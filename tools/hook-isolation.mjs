// Test-hook isolation checks (mvp-06 tasks 2.4 and 2.6a).
// The modules under src/crypto/testing/ (a raw-VCK hook and an Argon2id entry that bypasses the parameter floors) and
// the injectable ("Internal", "With", "Unchecked") variants of the crypto entry points must never reach the plugin or
// the CLI. Checks:
//   1. sentinel: every test-only module (recursively) carries a unique sentinel string; no bundle may contain one;
//   2. dependency metadata: the esbuild metafile of each graph lists no input under src/crypto/testing/;
//   3. import lint: no shipped file (src/, cli/, tools/) imports that folder, by any specifier form;
//   4. injection lint: the names of the injectable entry points, and the property names `deps:` / `random:`, appear
//      only in an allow-list of files (their definitions), src/crypto/testing/ and tests/;
//   5. emitted artifacts: after a production build, dist/plugin/main.js and dist/cli/ipfs-sync.mjs hold no sentinel.
// The graphs are built in memory from the SAME option objects as the real build (esbuild.options.mjs).
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import esbuild from "esbuild";
import builtins from "builtin-modules";
import { CLI_OUT, cliOptions, pluginOptions, pluginOutDir } from "../esbuild.options.mjs";

export const TESTING_DIR = "src/crypto/testing";
const SENTINEL_PREFIX = "IPFS_SYNC_TEST_ONLY_SENTINEL_";
const SENTINEL_LITERAL = new RegExp(`["'\`](${SENTINEL_PREFIX}[A-Za-z0-9_]+)["'\`]`, "g");

async function listFiles(dir, pattern) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listFiles(full, pattern);
      return pattern.test(entry.name) ? [full] : [];
    }),
  );
  return nested.flat().sort();
}

/** Every test-only module (recursively) and the sentinel it declares; throws when a module has none, several, or a shared one. */
export async function loadSentinels(root = process.cwd()) {
  const modules = await listFiles(join(root, TESTING_DIR), /\.(?:ts|tsx|mts|cts)$/);
  const found = [];
  for (const path of modules) {
    const text = await readFile(path, "utf8");
    const unique = [...new Set([...text.matchAll(SENTINEL_LITERAL)].map((match) => match[1]))];
    const file = relative(root, path).replaceAll("\\", "/");
    if (unique.length !== 1) throw new Error(`${file} must declare exactly one sentinel string, found ${unique.length}`);
    found.push({ file, sentinel: unique[0] });
  }
  if (new Set(found.map((entry) => entry.sentinel)).size !== found.length) throw new Error("test-only modules must not share a sentinel string");
  if (found.length === 0) throw new Error(`${TESTING_DIR} has no modules`);
  return found;
}

const external = ["obsidian", "electron", "node:*", ...builtins];

/** The graphs to check, from the real build option objects. */
function graphDefinitions() {
  return [
    { label: "plugin bundle (src/main.ts)", options: pluginOptions(true) },
    { label: "CLI bundle (cli/main.ts)", options: cliOptions(true) },
    { label: "crypto public surface", options: { ...pluginOptions(true), entryPoints: ["tools/webview-probe-crypto-entry.ts"] } },
  ];
}

async function buildGraph(root, label, options) {
  const result = await esbuild.build({
    ...options,
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    logLevel: "silent",
    sourcemap: false,
    outfile: "out.js",
  });
  return { label, inputs: Object.keys(result.metafile.inputs), text: result.outputFiles.map((file) => file.text).join("\n") };
}

/** Violations for one built graph: any test-only input, and any sentinel in the emitted code. */
export function findViolations(graph, sentinels) {
  const violations = [];
  for (const input of graph.inputs) {
    if (input.replaceAll("\\", "/").startsWith(`${TESTING_DIR}/`)) violations.push(`${graph.label}: dependency metadata lists ${input}`);
  }
  for (const { file, sentinel } of sentinels) {
    if (graph.text.includes(sentinel)) violations.push(`${graph.label}: emitted code contains the sentinel of ${file}`);
  }
  return violations;
}

/**
 * Build the plugin, CLI and crypto-surface graphs from the real option objects (plus any extra entries, used by the
 * negative tests that plant an import) and report violations. `extraEntries` items are `{ label, contents }`.
 */
export async function checkHookIsolation({ root = process.cwd(), extraEntries = [] } = {}) {
  const sentinels = await loadSentinels(root);
  const graphs = await Promise.all([
    ...graphDefinitions().map(({ label, options }) => buildGraph(root, label, options)),
    ...extraEntries.map(({ label, contents }) =>
      buildGraph(root, label, { format: "cjs", target: "es2022", external, stdin: { contents, resolveDir: root, loader: "ts" } }),
    ),
  ]);
  const violations = graphs.flatMap((graph) => findViolations(graph, sentinels));
  return {
    ok: violations.length === 0,
    violations,
    sentinels,
    graphs: graphs.map((graph) => ({ label: graph.label, inputs: graph.inputs.length, bytes: graph.text.length })),
  };
}

/**
 * Grep the emitted release artifacts for sentinels. Artifacts that do not exist yet are reported as `missing`
 * (no build has run); the release script must require `missing` to be empty.
 */
export async function checkDistBundles({ root = process.cwd() } = {}) {
  const sentinels = await loadSentinels(root);
  const targets = [join(pluginOutDir(true), "main.js"), CLI_OUT];
  const checked = [];
  const missing = [];
  const violations = [];
  for (const target of targets) {
    const text = await readFile(join(root, target), "utf8").catch(() => undefined);
    if (text === undefined) {
      missing.push(target);
      continue;
    }
    checked.push(target);
    for (const { file, sentinel } of sentinels) if (text.includes(sentinel)) violations.push(`${target} contains the sentinel of ${file}`);
  }
  return { ok: violations.length === 0, checked, missing, violations };
}

/* ---------- lint over source text ---------- */

export const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
const TEMPLATE_IMPORT = /\b(?:import|require)\s*\(\s*`([^`]*)`/g;
const NON_LITERAL_IMPORT = /\b(?:import|require)\s*\(\s*(?!["'`])[^)\s]/g;

/**
 * The only tools/ files that may import src/crypto/testing/ (mvp-07b 4.2, R5-11). Operator-run feature-op scripts
 * (tools/feature-op-<name>.mjs) need the raw hooks to build tampered inputs for the hostile phases. Why this is safe:
 * these files are never bundled (no esbuild entry point reaches tools/; checkHookIsolation builds the real graphs and
 * would list any testing input), never packed into a release, and run only by the operator against throwaway vaults.
 * The entry is a flat file name pattern on purpose: no subfolder, no other tool (the checker, the release tools, this
 * file) and nothing under src/, cli/ or tests/ matches. Helper modules in a feature-op subfolder keep the older
 * workaround (building the folder name at run time) and are not listed. Adding an entry here widens the lint: it needs a
 * stated reason in this comment and a test in tests/unit/crypto-hook-isolation-tools.test.ts that an unlisted tool fails.
 */
export const TOOL_TESTING_IMPORT_ALLOWLIST = Object.freeze(["tools/feature-op-*.mjs"]);
const FEATURE_OP_TOOL = /^tools\/feature-op-[a-z0-9][a-z0-9-]*\.mjs$/;

/** True when `path` (relative to the repository root) is covered by TOOL_TESTING_IMPORT_ALLOWLIST. */
export function isToolTestingImportAllowed(path) {
  return FEATURE_OP_TOOL.test(path.replaceAll("\\", "/"));
}

/**
 * Import lint: no source file outside src/crypto/testing/ imports that folder. Relative specifiers are resolved; any
 * specifier (bare or path-mapped) that names `crypto/testing` is refused; template-literal dynamic imports that name
 * it are refused; `unresolvable` dynamic imports (computed specifiers) are refused in shipped code (`shipped`).
 * `files` is a list of `{ path, text }` with paths relative to `root`.
 */
export function findTestingImports(files, root = process.cwd(), { shipped = true } = {}) {
  const testingRoot = resolve(root, TESTING_DIR);
  const offences = [];
  for (const { path, text } of files) {
    const absolute = resolve(root, path);
    if (absolute.startsWith(`${testingRoot}/`) || isToolTestingImportAllowed(path)) continue;
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const target = specifier.startsWith(".") ? resolve(dirname(absolute), specifier) : undefined;
      const hits = target !== undefined && (target === testingRoot || target.startsWith(`${testingRoot}/`));
      if (hits || specifier.includes("crypto/testing")) offences.push(`${path} imports ${specifier}`);
    }
    for (const match of text.matchAll(TEMPLATE_IMPORT)) {
      if (match[1].includes("testing") || match[1].includes("${")) offences.push(`${path} has a template-literal import "${match[1]}"`);
    }
    if (shipped) for (const match of text.matchAll(NON_LITERAL_IMPORT)) offences.push(`${path} has a dynamic import with a computed specifier near "${match[0]}"`);
  }
  return offences;
}

const CRYPTO = "src/crypto/";
const ONE = (file) => [`${CRYPTO}${file}`];

/**
 * Names that must not spread: each may appear only in the listed files (their definition and their few callers inside
 * src/crypto). src/crypto/testing/ and tests/ are outside the scan. The public index and all wiring code are therefore
 * excluded automatically.
 */
export const RESTRICTED_SYMBOLS = {
  unwrapVckInternal: ONE("key-slots.ts"),
  unlockKeySlotsInternal: ONE("key-slots.ts"),
  createKeySlotsInternal: ONE("key-slots.ts"),
  KeySlotDeps: ONE("key-slots.ts"),
  createBlobEncryptionWith: ONE("blob.ts"),
  encryptBlobBytesWith: ONE("blob.ts"),
  decryptBlobUnchecked: ONE("blob.ts"),
  decryptBlobBytesUnchecked: ONE("blob.ts"),
  ByteReader: ONE("blob.ts"),
  encryptManifestEnvelopeWith: ONE("manifest-envelope.ts"),
  generatePassphraseWith: ONE("passphrase.ts"),
  markGenerated: ONE("passphrase.ts"),
  createSelfTestRunner: ONE("self-test.ts"),
  PLATFORM_PRIMITIVES: ONE("self-test.ts"),
  checkManifestCapsWith: ["src/sync/encrypted-manifest.ts"],
  parseManifestV2With: ["src/sync/encrypted-manifest.ts"],
  encodeManifestFileWith: ["src/sync/encrypted-manifest.ts"],
  markParsed: [`${CRYPTO}key-slot-format.ts`, `${CRYPTO}key-slots.ts`],
  assertParsed: ONE("key-slot-format.ts"),
  createVaultKeys: [`${CRYPTO}key-derivation.ts`, `${CRYPTO}key-slots.ts`],
  deriveKek: [`${CRYPTO}argon2.ts`, `${CRYPTO}key-slots.ts`],
  KdfFunction: [`${CRYPTO}argon2.ts`, `${CRYPTO}key-slots.ts`],
  secureRandom: [`${CRYPTO}random.ts`, `${CRYPTO}key-slots.ts`, `${CRYPTO}blob.ts`, `${CRYPTO}manifest-envelope.ts`, `${CRYPTO}passphrase.ts`],
  randomBytes: [`${CRYPTO}random.ts`, `${CRYPTO}key-slots.ts`, `${CRYPTO}blob.ts`],
  RandomSource: [`${CRYPTO}random.ts`, `${CRYPTO}key-slots.ts`, `${CRYPTO}blob.ts`, `${CRYPTO}manifest-envelope.ts`, `${CRYPTO}passphrase.ts`],
};

/**
 * Property, parameter and shorthand names that carry an injectable collaborator, and the only files (inside
 * src/crypto/** and the manifest codec) that may declare them.
 */
export const INJECTION_NAMES = {
  deps: ONE("key-slots.ts"),
  kdf: [`${CRYPTO}key-slots.ts`, `${CRYPTO}argon2.ts`, `${CRYPTO}key-slot-format.ts`],
  selfTest: ONE("key-slots.ts"),
  random: [`${CRYPTO}random.ts`, `${CRYPTO}key-slots.ts`, `${CRYPTO}blob.ts`, `${CRYPTO}manifest-envelope.ts`, `${CRYPTO}passphrase.ts`],
  exponent: ONE("blob.ts"),
  limits: ["src/sync/encrypted-manifest.ts"],
};

/** Files whose imports of src/crypto may bypass the index (their job is to sit next to the crypto core). */
export const BOUNDARY_EXCEPTIONS = ["src/sync/encrypted-manifest.ts"];

const EXEMPT = ["tools/hook-isolation.mjs", "tools/hook-isolation.d.mts", "esbuild.options.mjs"];
const inInjectionScope = (path) => path.startsWith(CRYPTO) || path === "src/sync/encrypted-manifest.ts";
const isTesting = (path, root) => resolve(root, path).startsWith(`${resolve(root, TESTING_DIR)}/`);

/** Remove comments so prose that mentions a name is not mistaken for code (strings are left alone). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function injectionPattern(name) {
  return new RegExp(`(?<![.\\w])["']?${name}["']?\\s*\\??\\s*[:,})=]`);
}

/**
 * Injection lint over shipped code: a restricted symbol may appear only in its listed files, and an injection name as a
 * property, parameter, quoted key or shorthand only in its listed files (within src/crypto/** and the manifest codec).
 */
export function findInjectionLeaks(files, root = process.cwd()) {
  const offences = [];
  for (const { path, text: raw } of files) {
    const normal = path.replaceAll("\\", "/");
    if (EXEMPT.includes(normal) || isTesting(path, root)) continue;
    const text = stripComments(raw);
    for (const [symbol, homes] of Object.entries(RESTRICTED_SYMBOLS)) {
      if (!homes.includes(normal) && new RegExp(`\\b${symbol}\\b`).test(text)) offences.push(`${path} mentions ${symbol} (only ${homes.join(", ")} may)`);
    }
    if (!inInjectionScope(normal)) continue;
    for (const [name, homes] of Object.entries(INJECTION_NAMES)) {
      if (!homes.includes(normal) && injectionPattern(name).test(text)) offences.push(`${path} declares or passes \`${name}\` (only ${homes.join(", ")} may)`);
    }
  }
  return offences;
}

/**
 * Import boundary: outside src/crypto/**, tests/** and tools/**, an import that resolves into src/crypto must resolve to
 * src/crypto/index.ts (a deep import would reach internals). The listed exceptions are the manifest codec.
 */
export function findBoundaryImports(files, root = process.cwd()) {
  const cryptoRoot = resolve(root, "src/crypto");
  const offences = [];
  for (const { path, text } of files) {
    const normal = path.replaceAll("\\", "/");
    if (normal.startsWith(CRYPTO) || normal.startsWith("tests/") || normal.startsWith("tools/") || BOUNDARY_EXCEPTIONS.includes(normal)) continue;
    const absolute = resolve(root, path);
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        if (/(^|\/)src\/crypto\/./.test(specifier)) offences.push(`${path} deep-imports ${specifier}`);
        continue;
      }
      const target = resolve(dirname(absolute), specifier);
      const isIndex = target === cryptoRoot || target === `${cryptoRoot}/index` || target === `${cryptoRoot}/index.ts`;
      if ((target === cryptoRoot || target.startsWith(`${cryptoRoot}/`)) && !isIndex) offences.push(`${path} deep-imports ${specifier}`);
    }
  }
  return offences;
}

/** Run every lint over the shipped code: src/, cli/ and tools/. */
export async function lintTestingImports(root = process.cwd()) {
  const paths = (await Promise.all(["src", "cli", "tools"].map((dir) => listFiles(join(root, dir), SOURCE_FILE)))).flat();
  const files = await Promise.all(paths.map(async (path) => ({ path: relative(root, path).replaceAll("\\", "/"), text: await readFile(path, "utf8") })));
  const shippedFiles = files.filter((file) => !file.path.startsWith("tools/"));
  return [
    ...findTestingImports(shippedFiles, root),
    ...findTestingImports(files.filter((f) => f.path.startsWith("tools/")), root, { shipped: false }),
    ...findInjectionLeaks(shippedFiles, root),
    ...findBoundaryImports(shippedFiles, root),
  ];
}
