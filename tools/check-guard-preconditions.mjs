// Guard-evidence checker (openspec/changes/mvp-07b-keys-history-guard-release-2, design 9, spec guard-evidence).
//
//   node tools/check-guard-preconditions.mjs --print-tree-hash [--list]
//
//   node tools/check-guard-preconditions.mjs [--json] [--no-tests]   T, B and items A to E; exit 0 only when every one passes
//   node tools/check-guard-preconditions.mjs --build    T and B, then installs the verified outputs (below)
//   node tools/check-guard-preconditions.mjs --enrol-signer <public key file>   enrols the review signer (terminal only)
//
// This file holds part 1a (task 4.3a, the tree hash T), part 1b (task 4.3b, the clean-export build B and `--build`), part
// 1c (task 4.3c, item A, the trust anchor and `--enrol-signer`), part 2a (task 4.4a, item B, the operator-run record), part
// 2b (task 4.4b, item C, phone timing) and part 2c (task 4.4c, items D and E and the exit codes). It is one file and imports
// only Node built-ins and tools/hook-isolation.mjs (a test scans the imports). A default run never writes anything in the
// repository; `--build` writes only dist/plugin/, dist/cli/ and dist/.guard-build.json; `--enrol-signer` writes only the two
// files in the per-user trust directory. Everything else a run writes (the export, the test report) lives in a temporary
// directory outside the repository that is removed before the run ends.
//
// Exit codes: 0 every requested check passed (T, B and items A to E for a default run; or `--build` installed the verified
// outputs, or a signer was enrolled), 1 a check failed (each failure is printed with its reason), 2 usage or environment
// error (not a repository, no commit, git missing, an unknown option, a symbolic link where `--build` would write,
// IPFS_SYNC_ALLOWED_SIGNERS set, no terminal for the enrolment). No option skips or weakens an item: `--no-tests` leaves
// the checklist test run out and item E then fails with `tests-skipped`, so the run is never a pass.
//
// What T binds. T is SHA-256 over lines `<posix path>\t<git mode>\t<sha256 of the blob bytes>\n` for every tracked file
// in the scope, ordered by the path compared by UTF-16 code unit. The file set comes from `git ls-tree -r -z <commit>`
// and the bytes from the object database, so .gitattributes filters, core.autocrlf and the working tree's line
// endings never enter T. The working tree is not hashed; it is only required to equal the commit (below), so nobody
// can believe T describes files that are not what runs.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, posix, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_TESTING_IMPORT_ALLOWLIST, isToolTestingImportAllowed } from "./hook-isolation.mjs";

/* ---------- scope ---------- */

/**
 * The files T covers (design 9 "Tree hash T", narrowed 2026-10-03: the committed 07a files tools/feature-op-mvp-07a.mjs
 * and tools/feature-op-mvp-07a/ are NOT in the glob). `dirs` end in a slash and match by prefix, so
 * `tools/feature-op-mvp-07/` does not match `tools/feature-op-mvp-07a/` and `tools/release/` does not match
 * `tools/release-mvp-07.mjs`. Every tools/ file that `importRoot` imports, transitively, is added by exact path.
 */
export const TREE_SCOPE = Object.freeze({
  files: Object.freeze([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "esbuild.config.mjs",
    "esbuild.options.mjs",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.src.json",
    "manifest.json",
    "tools/check-guard-preconditions.mjs",
    "tools/hook-isolation.mjs",
    "tools/record-phone-timing.mjs",
    "tools/release-mvp-07.mjs",
    "tools/feature-op-mvp-07.mjs",
  ]),
  dirs: Object.freeze(["src/", "cli/", "tools/release/", "tools/feature-op-mvp-07/"]),
  importRoot: "tools/feature-op-mvp-07.mjs",
});

const REGULAR_MODES = new Set(["100644", "100755"]);
const SOURCE_FILE = /\.(?:mjs|cjs|js|mts|cts|ts)$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const inBaseScope = (path) => TREE_SCOPE.files.includes(path) || TREE_SCOPE.dirs.some((dir) => path.startsWith(dir));

/* ---------- errors and failures ---------- */

/** The checker could not run (exit 2): not a repository, no commit, git missing, bad argument. */
export class CheckerEnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckerEnvironmentError";
  }
}

const failure = (code, path, detail) => Object.freeze(path === undefined ? { code, detail } : { code, path, detail });

/* ---------- git ---------- */

const GIT_ENV_ALLOW = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"];
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * The environment git runs in: an allow-list. Any GIT_* variable of the caller is dropped, because a hook or a shell
 * can set GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE and point every check below at another repository or index.
 */
function gitEnvironment() {
  const env = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of GIT_ENV_ALLOW) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/**
 * Runs git in `root` and returns `{ status, stdout, stderr }` (stdout is a Buffer). Fixed global options:
 * `--no-replace-objects` (a refs/replace entry would swap blobs or trees under every read), `--literal-pathspecs`
 * (scope paths are never globs), `core.fsmonitor=false` and `core.untrackedCache=false` (a stale daemon or cache can
 * report a changed or new file as unchanged), `core.quotePath=false`.
 */
export function runGit(root, args, { input } = {}) {
  const result = spawnSync(
    "git",
    ["--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.quotePath=false", ...args],
    { cwd: root, env: gitEnvironment(), input, maxBuffer: GIT_MAX_BUFFER },
  );
  if (result.error) throw new CheckerEnvironmentError(`cannot run git: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString("utf8") };
}

function gitOk(root, args, options) {
  const result = runGit(root, args, options);
  if (result.status !== 0) {
    throw new CheckerEnvironmentError(`git ${args.slice(0, 2).join(" ")} failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

const splitZ = (buffer) => {
  const parts = buffer.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
};

/** `root` must be the top level of a work tree: a checker that ran in a subdirectory would judge only part of it. */
function requireTopLevel(root) {
  const top = gitOk(root, ["rev-parse", "--show-toplevel"]).stdout.toString("utf8").trim();
  if (realpathSync(top) !== realpathSync(root)) {
    throw new CheckerEnvironmentError(`${root} is not the top level of its repository (the top level is ${top})`);
  }
}

function resolveCommit(root, spec) {
  const result = runGit(root, ["rev-parse", "--verify", "--quiet", `${spec}^{commit}`]);
  const oid = result.stdout.toString("utf8").trim();
  if (result.status !== 0 || !OBJECT_ID.test(oid)) throw new CheckerEnvironmentError(`${spec} does not name a commit in ${root}`);
  return oid;
}

/* ---------- objects ---------- */

/** `git ls-tree -r -z`: every file of the commit as a Map path -> { mode, type, oid, pathIsUtf8 }. */
function listTree(root, commit) {
  const tree = new Map();
  const raw = gitOk(root, ["ls-tree", "-r", "-z", "--full-tree", commit]).stdout;
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    if (end < 0) throw new CheckerEnvironmentError("git ls-tree output is not NUL terminated");
    const record = raw.subarray(offset, end);
    offset = end + 1;
    const tab = record.indexOf(0x09);
    const [mode, type, oid] = record.subarray(0, tab).toString("latin1").split(" ");
    const pathBytes = record.subarray(tab + 1);
    const path = pathBytes.toString("utf8");
    tree.set(path, { mode, type, oid, pathIsUtf8: Buffer.from(path, "utf8").equals(pathBytes) });
  }
  return tree;
}

/** Blob bytes from the object database through one `git cat-file --batch`. Returns a Map oid -> Buffer. */
function readBlobs(root, oids) {
  const unique = [...new Set(oids)];
  const blobs = new Map();
  if (unique.length === 0) return blobs;
  const { stdout } = gitOk(root, ["cat-file", "--batch"], { input: unique.map((oid) => `${oid}\n`).join("") });
  let offset = 0;
  for (const oid of unique) {
    const eol = stdout.indexOf(0x0a, offset);
    if (eol < 0) throw new CheckerEnvironmentError(`git cat-file ended early before ${oid}`);
    const [name, type, size] = stdout.toString("latin1", offset, eol).split(" ");
    const length = Number(size);
    if (name !== oid || type !== "blob" || !Number.isSafeInteger(length)) {
      throw new CheckerEnvironmentError(`object ${oid} is not a readable blob (${stdout.toString("latin1", offset, eol)})`);
    }
    const start = eol + 1;
    if (start + length > stdout.length) throw new CheckerEnvironmentError(`git cat-file truncated the blob ${oid}`);
    blobs.set(oid, stdout.subarray(start, start + length));
    offset = start + length + 1;
  }
  return blobs;
}

/* ---------- imports of the operator-run script ---------- */

const LITERAL_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
const TEMPLATE_SPECIFIER = /\b(?:import|require)\s*\(\s*`([^`]*)`/g;
const COMPUTED_SPECIFIER = /\b(?:import|require)\s*\(\s*(?!["'`])[^)\s]/;
const NOT_A_FILE_PATH = /^(?:file:|data:|https?:|#|\/|[A-Za-z]:[\\/])/;

/**
 * Import specifiers of a module's text. A heuristic on text, not a parser: a comment that looks like an import is
 * counted (which fails loudly, never silently drops a file) and `new URL("./x", import.meta.url)` is not seen at all
 * (documented residual risk: such a file is not pulled into the scope).
 */
function scanImports(text) {
  const specifiers = [...text.matchAll(LITERAL_SPECIFIER)].map((match) => match[1]);
  let computed = COMPUTED_SPECIFIER.test(text);
  for (const match of text.matchAll(TEMPLATE_SPECIFIER)) {
    if (match[1].includes("${")) computed = true;
    else specifiers.push(match[1]);
  }
  return { specifiers, computed };
}

/**
 * Walks the relative imports of the tools/ files of the scope. Starting from `TREE_SCOPE.importRoot`, a tools/ file that
 * is reached and is not yet in the scope is ADDED by exact path (a reused 07a module and what it imports). Starting from
 * any other scoped tools/ file, such a file is a failure: it would run in the release or the checker without being
 * hashed. An import that resolves outside every scope, to nothing in the commit, to an absolute path or URL, or that is
 * computed at run time, is a failure too. Bare package names and node: modules are fine (the lockfile binds packages).
 */
function resolveImportScope(tree, getBlob) {
  const extra = new Set();
  const failures = [];
  const visited = new Set();
  const scoped = (path) => inBaseScope(path) || extra.has(path);

  const visit = (path, mayAdd) => {
    if (visited.has(path) || !SOURCE_FILE.test(path)) return;
    visited.add(path);
    const { specifiers, computed } = scanImports(getBlob(tree.get(path).oid).toString("utf8"));
    if (computed) failures.push(failure("import-non-literal", path, `${path} imports a module by a computed specifier, so the files it loads cannot be hashed`));
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) continue;
      if (NOT_A_FILE_PATH.test(specifier)) {
        failures.push(failure("import-outside-scope", path, `${path} imports ${specifier}, which is an absolute path or a URL`));
        continue;
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!tree.has(target)) {
        failures.push(failure("import-missing", path, `${path} imports ${specifier}, which is not a file in the commit (${target})`));
      } else if (scoped(target)) {
        if (target.startsWith("tools/")) visit(target, mayAdd);
      } else if (mayAdd && target.startsWith("tools/")) {
        extra.add(target);
        visit(target, true);
      } else {
        failures.push(failure("import-outside-scope", path, `${path} imports ${target}, which is outside the tree-hash scope`));
      }
    }
  };

  if (tree.has(TREE_SCOPE.importRoot)) visit(TREE_SCOPE.importRoot, true);
  for (const path of [...tree.keys()].filter((candidate) => candidate.startsWith("tools/") && inBaseScope(candidate)).sort()) visit(path, false);
  return { extra: [...extra].sort(), failures };
}

/* ---------- T ---------- */

const compareUtf16 = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The hashed lines and T for `entries` (`{ path, mode, sha256 }`). The input is not modified. A path with a tab or a
 * newline would make two different trees print the same lines, so it throws.
 */
export function hashTreeLines(entries) {
  for (const entry of entries) {
    if (/[\t\n]/.test(entry.path)) throw new TypeError(`path contains a tab or a newline: ${JSON.stringify(entry.path)}`);
  }
  const lines = [...entries].sort((a, b) => compareUtf16(a.path, b.path)).map((entry) => `${entry.path}\t${entry.mode}\t${entry.sha256}\n`);
  return { lines, treeSha256: createHash("sha256").update(lines.join(""), "utf8").digest("hex") };
}

/** The scoped entries of `commit` read from the object database only. `{ entries, failures, pathspecs }`. */
function readScopedTree(root, commit) {
  const tree = listTree(root, commit);
  const base = [...tree.keys()].filter(inBaseScope);
  const blobs = readBlobs(
    root,
    base.filter((path) => REGULAR_MODES.has(tree.get(path).mode) && tree.get(path).type === "blob").map((path) => tree.get(path).oid),
  );
  const getBlob = (oid) => blobs.get(oid) ?? readBlobs(root, [oid]).get(oid);
  const imports = resolveImportScope(tree, getBlob);
  const failures = [...imports.failures];
  const entries = [];
  for (const path of [...base, ...imports.extra]) {
    const { mode, type, oid, pathIsUtf8 } = tree.get(path);
    if (!pathIsUtf8) failures.push(failure("bad-path", JSON.stringify(path), "the path is not valid UTF-8"));
    else if (/[\t\n]/.test(path)) failures.push(failure("bad-path", JSON.stringify(path), "the path contains a tab or a newline"));
    if (!REGULAR_MODES.has(mode) || type !== "blob") {
      failures.push(failure("irregular-mode", path, `${path} has mode ${mode} (${type}); only regular files (100644, 100755) are accepted`));
      continue;
    }
    entries.push({ path, mode, oid, sha256: createHash("sha256").update(getBlob(oid)).digest("hex") });
  }
  return { entries, failures, pathspecs: [...TREE_SCOPE.files, ...TREE_SCOPE.dirs, ...imports.extra] };
}

/** Everything the working tree must not have inside the scope; each result is a failure record. */
function checkWorkingTree(root, commit, pathspecs) {
  const failures = [];
  const list = (args) => splitZ(gitOk(root, [...args, "-z", "--", ...pathspecs]).stdout);
  for (const path of list(["ls-files", "--others", "--exclude-standard"])) {
    failures.push(failure("untracked-file", path, `${path} is untracked and inside the scope`));
  }
  // The second listing catches what .gitignore hides from the first: `src/x/main.js` under the `main.js` rule would
  // still be compiled by `pnpm build`.
  for (const path of list(["ls-files", "--others", "--ignored", "--exclude-standard"])) {
    failures.push(failure("ignored-file", path, `${path} is ignored by git and inside the scope`));
  }
  for (const path of list(["diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", commit])) {
    failures.push(failure("staged-change", path, `${path} differs between the index and the commit`));
  }
  for (const path of list(["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv"])) {
    failures.push(failure("unstaged-change", path, `${path} differs between the working tree and the index`));
  }
  for (const record of list(["ls-files", "-v"])) {
    const tag = record.slice(0, 1);
    if (tag === "H") continue;
    const meaning = tag === "S" || tag === "s" ? "skip-worktree" : tag === "h" ? "assume-unchanged" : "not a plain cached entry";
    failures.push(failure("index-flag", record.slice(2), `${record.slice(2)} carries the index tag ${tag} (${meaning})`));
  }
  return failures;
}

function summarize(commit, scoped, extraFailures = []) {
  const failures = [...scoped.failures, ...extraFailures];
  if (failures.length > 0) return { ok: false, failures };
  const { lines, treeSha256 } = hashTreeLines(scoped.entries);
  return { ok: true, commit, treeSha256, t8: treeSha256.slice(0, 8), fileCount: scoped.entries.length, entries: scoped.entries, lines };
}

/**
 * T for the current checkout: the scoped tree of HEAD, plus the requirement that the index and the working tree equal
 * HEAD inside the scope and that nothing untracked or ignored sits there. Returns `{ ok: true, commit, treeSha256,
 * t8, fileCount, entries, lines }` or `{ ok: false, failures }`; throws CheckerEnvironmentError when it cannot run.
 */
export function computeTreeHash({ root }) {
  requireTopLevel(root);
  const commit = resolveCommit(root, "HEAD");
  const scoped = readScopedTree(root, commit);
  return summarize(commit, scoped, checkWorkingTree(root, commit, scoped.pathspecs));
}

/**
 * T from the objects of `commit` alone (no working tree, index or ignore rule is consulted): the value a review record's
 * `reviewedCommit` must reproduce. `commit` must be a full object id.
 */
export function treeHashAtCommit({ root, commit }) {
  if (typeof commit !== "string" || !OBJECT_ID.test(commit)) throw new CheckerEnvironmentError("the commit must be a full object id");
  requireTopLevel(root);
  const resolved = resolveCommit(root, commit);
  return summarize(resolved, readScopedTree(root, resolved));
}

/* ---------- B: the clean-export build ---------- */

/** Where `--build` records T and B for the operator-run script and the release tool (stale-dist check). */
export const GUARD_BUILD_FILE = "dist/.guard-build.json";

/** The files B hashes. `required` outputs missing from a build fail it; styles.css exists only when the build makes one. */
export const BUILD_OUTPUTS = Object.freeze(
  [
    { path: "dist/plugin/main.js", required: true },
    { path: "dist/plugin/manifest.json", required: true },
    { path: "dist/plugin/styles.css", required: false },
    { path: "dist/cli/ipfs-sync.mjs", required: true },
  ].map((output) => Object.freeze(output)),
);

/**
 * Reads `dist/.guard-build.json` under `root` for the stale-`dist/` checks of the recorder and the release tool: a regular
 * file (not a link), valid JSON, an object. Returns `{ ok: true, state }` or `{ ok: false, reason }`; what the state must
 * equal (the present tree, the checker's build, the hashes of the files on disk) is each caller's own judgement.
 */
export function readGuardBuildState(root) {
  const statePath = join(root, ...GUARD_BUILD_FILE.split("/"));
  const stats = lstatSyncOrNull(statePath);
  if (stats === null || !stats.isFile()) return { ok: false, reason: `${GUARD_BUILD_FILE} is missing or not a regular file` };
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state === null || typeof state !== "object" || Array.isArray(state)) return { ok: false, reason: `${GUARD_BUILD_FILE} has an unknown shape` };
    return { ok: true, state };
  } catch {
    return { ok: false, reason: `${GUARD_BUILD_FILE} is not valid JSON` };
  }
}

/** The only variables the build sees (design 9). Everything else, in particular NODE_OPTIONS, OBSIDIAN_PLUGIN_DIR, npm_config_* and ESBUILD_*, is dropped. */
const BUILD_ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PNPM_HOME"];
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
const COMMAND_MAX_BUFFER = 256 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 4000;
const NOTICE_LIST_LIMIT = 10;

const DEFAULT_COMMANDS = Object.freeze({
  node: "node",
  install: Object.freeze(["pnpm", "install", "--frozen-lockfile"]),
  build: Object.freeze(["pnpm", "build"]),
  nodeVersion: Object.freeze(["node", "--version"]),
  pnpmVersion: Object.freeze(["pnpm", "--version"]),
  // Item E (spec "Item E"): the checker appends `run <paths> --reporter=json --outputFile=<file>` to `tests`; `audit` is the whole command.
  tests: Object.freeze(["pnpm", "exec", "vitest"]),
  audit: Object.freeze(["pnpm", "audit", "--prod", "--json"]),
});

/**
 * The text of a child program that runs the EXPORT's own `loadSentinels` and `checkDistBundles` (its
 * tools/hook-isolation.mjs, its node_modules) and prints `{ sentinels }` or `{ sentinelError }`, plus `{ dist }` when the
 * sentinels loaded, as JSON. `checkDistBundles` itself throws when a test-only module has no sentinel, so a sentinel
 * problem is reported on its own and the bundle scan is not attempted. Item D judges the result. The specifier is spliced
 * in so that this string is not read as an import of this file by the import scan (it is not one).
 */
const CHECK_DIST_SCRIPT = [
  `import { checkDistBundles, loadSentinels } from ${JSON.stringify("./tools/hook-isolation.mjs")};`,
  "const out = {};",
  "try {",
  "  out.sentinels = (await loadSentinels(process.cwd())).map((entry) => entry.file);",
  "} catch (error) {",
  "  out.sentinelError = error instanceof Error ? error.message : String(error);",
  "}",
  "if (out.sentinelError === undefined) out.dist = await checkDistBundles({ root: process.cwd() });",
  "process.stdout.write(JSON.stringify(out));",
  "",
].join("\n");

/**
 * The environment of the install and the build: an allow-list. PATH keeps only absolute entries, so a relative entry
 * (`.`, `node_modules/.bin`, an empty entry) cannot put a binary of the export in front of `node` or `pnpm`.
 */
export function scrubbedBuildEnvironment(source) {
  const env = {};
  for (const key of BUILD_ENV_ALLOW) {
    const value = source[key];
    if (value === undefined || value === "") continue;
    env[key] = key === "PATH" ? value.split(delimiter).filter((entry) => isAbsolute(entry)).join(delimiter) : value;
  }
  env.CI = "true";
  return env;
}

/** `version` (as printed by `node --version`) against an `engines.node` range of the form `>=X.Y.Z`; anything else throws. */
export function nodeSatisfiesEngines(version, range) {
  const wanted = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!wanted) throw new CheckerEnvironmentError(`engines.node ${JSON.stringify(range)} is not of the form ">=X.Y.Z", so the Node version cannot be checked`);
  const actual = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!actual) throw new CheckerEnvironmentError(`cannot read the Node version from ${JSON.stringify(version)}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(actual[index]) - Number(wanted[index]);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** The sorted lines `<path>\t<sha256>\n` and B, their SHA-256. `files` maps a repository-relative output path to its sha256. */
export function hashBuildLines(files) {
  const lines = Object.entries(files)
    .sort(([a], [b]) => compareUtf16(a, b))
    .map(([path, sha256]) => `${path}\t${sha256}\n`);
  return { lines, buildSha256: createHash("sha256").update(lines.join(""), "utf8").digest("hex") };
}

const tail = (text) => (text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text).trim();

function runCommand(command, { cwd, env, timeout }) {
  const [file, ...args] = command;
  const result = spawnSync(file, args, { cwd, env, timeout, maxBuffer: COMMAND_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.error) return { ok: false, status: null, stdout: "", output: `${command.join(" ")}: ${result.error.message}` };
  return { ok: result.status === 0, status: result.status, stdout: result.stdout, output: tail(`${result.stderr}${result.stdout}`) };
}

/** Minimal ustar and pax reader for `git archive --format=tar`. Regular files are returned; links and submodules are listed as skipped. */
function readTar(buffer) {
  const files = new Map();
  const skipped = [];
  const text = (start, length) => {
    const field = buffer.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
  };
  const octal = (start, length) => Number.parseInt(text(start, length).trim() || "0", 8);
  let pax = {};
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    if (buffer.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const size = octal(offset + 124, 12);
    const typeflag = String.fromCharCode(buffer[offset + 156] || 0x30);
    const dataStart = offset + 512;
    if (!Number.isSafeInteger(size) || dataStart + size > buffer.length) throw new CheckerEnvironmentError("git archive produced a truncated tar stream");
    const data = buffer.subarray(dataStart, dataStart + size);
    const name = text(offset, 100);
    const prefix = text(offset + 345, 155);
    const mode = octal(offset + 100, 8);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (typeflag === "g") continue;
    if (typeflag === "x") {
      pax = {};
      let position = 0;
      while (position < data.length) {
        const space = data.indexOf(0x20, position);
        const length = Number.parseInt(data.toString("latin1", position, space), 10);
        if (space < 0 || !Number.isSafeInteger(length) || length <= 0) throw new CheckerEnvironmentError("git archive produced a malformed pax header");
        const record = data.toString("utf8", space + 1, position + length - 1);
        const equals = record.indexOf("=");
        pax[record.slice(0, equals)] = record.slice(equals + 1);
        position += length;
      }
      continue;
    }
    const path = (pax.path ?? (prefix === "" ? name : `${prefix}/${name}`)).replace(/\/$/, "");
    pax = {};
    if (typeflag === "5") continue;
    if (typeflag === "2" || typeflag === "1") {
      skipped.push(path);
      continue;
    }
    if (typeflag !== "0") throw new CheckerEnvironmentError(`git archive produced an unexpected tar entry type ${JSON.stringify(typeflag)} for ${path}`);
    if (path === "" || isAbsolute(path) || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new CheckerEnvironmentError(`git archive produced an unsafe path ${JSON.stringify(path)}`);
    }
    files.set(path, { data, executable: (mode & 0o111) !== 0 });
  }
  return { files, skipped };
}

/**
 * Writes the commit's tree into `destination` from `git archive` (objects only: no hook runs, nothing is read from
 * the working tree) with the line-ending settings pinned, and compares every scoped file with its blob. A difference
 * means an attribute rule (eol, filter, ident, export-subst, export-ignore) changes what a checkout builds, so B would
 * describe bytes nobody else gets. Symbolic links and submodules are not written (a build that needs one fails).
 */
function exportCommit(root, commit, scoped, destination) {
  const archive = gitOk(root, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", commit]);
  const { files, skipped } = readTar(archive.stdout);
  for (const [path, { data, executable }] of files) {
    const target = join(destination, ...path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, data, { mode: executable ? 0o755 : 0o644, flag: "wx" });
  }
  const failures = [];
  for (const entry of scoped.entries) {
    const exported = files.get(entry.path);
    if (exported === undefined) {
      failures.push(failure("export-differs-from-blob", entry.path, `${entry.path} is missing from the export of the commit (an export-ignore rule?)`));
    } else if (createHash("sha256").update(exported.data).digest("hex") !== entry.sha256) {
      failures.push(failure("export-differs-from-blob", entry.path, `${entry.path} differs between the export and its blob (an eol, filter, ident or export-subst attribute changes it)`));
    }
  }
  return { failures, skipped };
}

/** Hashes the build outputs under `exportDir`. A required output that is missing or not a plain file is a failure. */
function collectOutputs(exportDir) {
  const files = {};
  const artifacts = new Map();
  const failures = [];
  for (const { path, required } of BUILD_OUTPUTS) {
    const full = join(exportDir, ...path.split("/"));
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      if (required) failures.push(failure("build-output-missing", path, `the build did not produce ${path}`));
      continue;
    }
    if (!stats.isFile()) {
      failures.push(failure("build-output-irregular", path, `${path} is not a regular file`));
      continue;
    }
    const data = readFileSync(full);
    files[path] = createHash("sha256").update(data).digest("hex");
    artifacts.set(path, data);
  }
  return { files, artifacts, failures };
}

function userConfigNotices(home) {
  if (!home) return [];
  const candidates = [join(home, ".npmrc"), join(home, ".config", "pnpm", "rc"), join(home, "Library", "Preferences", "pnpm", "rc")];
  return candidates.filter((path) => lstatSyncOrNull(path) !== null).map((path) => `user-level package manager config ${path} exists and is read by pnpm during the install; it is not part of T or B`);
}

export const lstatSyncOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

function engineRange(root, commit) {
  const result = runGit(root, ["cat-file", "blob", `${commit}:package.json`]);
  let range;
  try {
    range = JSON.parse(result.stdout.toString("utf8"))?.engines?.node;
  } catch {
    range = undefined;
  }
  if (result.status !== 0 || typeof range !== "string") throw new CheckerEnvironmentError(`package.json of ${commit} holds no readable engines.node`);
  return range;
}

/** The temporary parent must exist, be a real path, and lie outside the repository, so that a default run writes nothing there. */
function temporaryParent(root, requested) {
  const parent = realpathSync(requested ?? tmpdir());
  const rel = relative(realpathSync(root), parent);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new CheckerEnvironmentError(`the temporary directory ${parent} is inside the repository ${root}; set TMPDIR to a directory outside it`);
  }
  return parent;
}

/**
 * The clean-export build of `commit` (design 9 "Build hashes B"). Steps: pin Node against `engines.node`; export the
 * commit's objects into a fresh directory outside the repository and compare the scoped files with their blobs;
 * `install --frozen-lockfile`; build; hash the outputs; remove `dist/`; build again; require identical hashes; run the
 * export's own `loadSentinels` and `checkDistBundles` on the second build and returns what they found as `distScan` (item D
 * judges it; a bundle with a sentinel is not a build failure here). `options.inExport`, when given, is called once with
 * `{ exportDir, workDir, env, tool }` while the export and its install still exist and its result is returned as
 * `exportChecks` (item E runs the checklist tests and the audit there). `options.commands`, `options.environment` and
 * `options.tmpRoot` exist for tests (stubbed install and build, no network); the command line passes none of them.
 *
 * Returns `{ ok: true, commit, buildSha256, files, artifacts, versions, notices, distScan, exportChecks }` (`artifacts`
 * holds the very bytes that were hashed, so a later copy cannot differ from B) or `{ ok: false, failures }`. Throws
 * CheckerEnvironmentError when it cannot run. The temporary directory is always removed.
 */
export function buildCleanExport({ root, commit, commands = {}, environment = process.env, tmpRoot, inExport }) {
  if (typeof commit !== "string" || !OBJECT_ID.test(commit)) throw new CheckerEnvironmentError("the commit must be a full object id");
  requireTopLevel(root);
  const resolved = resolveCommit(root, commit);
  const scoped = readScopedTree(root, resolved);
  if (scoped.failures.length > 0) return { ok: false, failures: scoped.failures };
  const range = engineRange(root, resolved);
  const tool = { ...DEFAULT_COMMANDS, ...commands };
  const env = scrubbedBuildEnvironment(environment);
  const work = mkdtempSync(join(temporaryParent(root, tmpRoot), "guard-build-"));
  try {
    const exportDir = join(work, "export");
    mkdirSync(exportDir);
    const probe = (command, label) => {
      const run = runCommand(command, { cwd: exportDir, env, timeout: PROBE_TIMEOUT_MS });
      if (!run.ok) throw new CheckerEnvironmentError(`cannot run ${label} (${command.join(" ")}): ${run.output}`);
      return run.stdout.trim();
    };
    const node = probe(tool.nodeVersion, "node");
    if (!nodeSatisfiesEngines(node, range)) {
      return { ok: false, failures: [failure("node-version-unsupported", undefined, `the build would run on Node ${node}, which does not satisfy engines.node ${range}`)] };
    }
    const exported = exportCommit(root, resolved, scoped, exportDir);
    if (exported.failures.length > 0) return { ok: false, failures: exported.failures };
    // After the export: pnpm picks its version from the package.json it finds (packageManager), so asked in an empty
    // directory it would name the global pnpm and not the one that runs the install.
    const versions = { node, pnpm: probe(tool.pnpmVersion, "pnpm") };

    const install = runCommand(tool.install, { cwd: exportDir, env, timeout: INSTALL_TIMEOUT_MS });
    if (!install.ok) return { ok: false, failures: [failure("install-failed", undefined, `${tool.install.join(" ")} failed (exit ${install.status}): ${install.output}`)] };

    const builds = [];
    for (let round = 1; round <= 2; round += 1) {
      if (round === 2) rmSync(join(exportDir, "dist"), { recursive: true, force: true });
      const run = runCommand(tool.build, { cwd: exportDir, env, timeout: BUILD_TIMEOUT_MS });
      if (!run.ok) return { ok: false, failures: [failure("build-failed", undefined, `build ${round} (${tool.build.join(" ")}) failed (exit ${run.status}): ${run.output}`)] };
      const outputs = collectOutputs(exportDir);
      if (outputs.failures.length > 0) return { ok: false, failures: outputs.failures };
      builds.push(outputs);
    }
    const [first, second] = builds;
    const differing = [...new Set([...Object.keys(first.files), ...Object.keys(second.files)])].sort().filter((path) => first.files[path] !== second.files[path]);
    if (differing.length > 0) {
      return { ok: false, failures: differing.map((path) => failure("build-not-reproducible", path, `${path} differs between two builds of the same export`)) };
    }

    const dist = runCommand([tool.node, "--input-type=module", "-e", CHECK_DIST_SCRIPT], { cwd: exportDir, env, timeout: PROBE_TIMEOUT_MS });
    let distScan;
    try {
      distScan = JSON.parse(dist.stdout);
    } catch {
      distScan = undefined;
    }
    if (!dist.ok || !isObject(distScan)) return { ok: false, failures: [failure("dist-check-failed", undefined, `the sentinel and bundle scan did not run in the export: ${dist.output}`)] };

    const notices = [...userConfigNotices(environment.HOME)];
    if (exported.skipped.length > 0) {
      const shown = exported.skipped.slice(0, NOTICE_LIST_LIMIT).join(", ");
      notices.push(`the export left out ${exported.skipped.length} symbolic link or submodule entries (${shown}${exported.skipped.length > NOTICE_LIST_LIMIT ? ", ..." : ""})`);
    }
    const exportChecks = inExport === undefined ? undefined : inExport({ exportDir, workDir: work, env, tool });
    return {
      ok: true,
      commit: resolved,
      buildSha256: hashBuildLines(second.files).buildSha256,
      files: second.files,
      artifacts: second.artifacts,
      versions,
      notices,
      distScan,
      exportChecks,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* ---------- --build: installing the verified outputs ---------- */

const DIST_DIRS = ["dist", "dist/plugin", "dist/cli"];

/** `--build` writes through dist/, dist/plugin and dist/cli: none may be a symbolic link and the two output folders hold no subfolders. */
function assertDistWritable(root) {
  for (const dir of DIST_DIRS) {
    const stats = lstatSyncOrNull(join(root, dir));
    if (stats === null) continue;
    if (stats.isSymbolicLink()) throw new CheckerEnvironmentError(`${dir} is a symbolic link; --build will not write through it`);
    if (!stats.isDirectory()) throw new CheckerEnvironmentError(`${dir} is not a directory`);
  }
  for (const dir of ["dist/plugin", "dist/cli"]) {
    if (lstatSyncOrNull(join(root, dir)) === null) continue;
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) throw new CheckerEnvironmentError(`${dir}/${entry.name} is a folder; remove it first, --build does not guess what it holds`);
    }
  }
}

const replaceFile = (target, data, mode) => {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode, flag: "w" });
  renameSync(temporary, target);
};

/**
 * Replaces dist/plugin/ and dist/cli/ with the verified outputs and writes dist/.guard-build.json last, so a crash
 * leaves no state file that vouches for a half-written folder. Files in those two folders that the verified build does
 * not produce are removed; dist/release/ is never touched.
 */
function installOutputs(root, built, tree) {
  assertDistWritable(root);
  const stateFile = join(root, ...GUARD_BUILD_FILE.split("/"));
  rmSync(stateFile, { force: true });
  for (const dir of ["dist/plugin", "dist/cli"]) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const entry of readdirSync(join(root, dir))) {
      if (!Object.hasOwn(built.files, `${dir}/${entry}`)) unlinkSync(join(root, dir, entry));
    }
  }
  for (const [path, data] of built.artifacts) replaceFile(join(root, ...path.split("/")), data, path === "dist/cli/ipfs-sync.mjs" ? 0o755 : 0o644);
  for (const [path, sha256] of Object.entries(built.files)) {
    if (createHash("sha256").update(readFileSync(join(root, ...path.split("/")))).digest("hex") !== sha256) {
      throw new CheckerEnvironmentError(`${path} does not hold the verified bytes after the copy`);
    }
  }
  const state = {
    schema: 1,
    commit: built.commit,
    treeSha256: tree.treeSha256,
    t8: tree.t8,
    buildSha256: built.buildSha256,
    files: built.files,
    node: built.versions.node,
    pnpm: built.versions.pnpm,
  };
  replaceFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o644);
}

/* ---------- the per-user state directory ---------- */

const STATE_DIRECTORY_NAME = "ipfs-sync";
const TRUST_DIRECTORY_NAME = "trust";
const ALLOWED_SIGNERS_FILE = "allowed-signers";
const SIGNER_RECORD_FILE = "review-signer.json";

/**
 * The per-user state directory: `$XDG_STATE_HOME/ipfs-sync` when that variable is set (any platform but Windows), else
 * macOS `~/Library/Application Support/ipfs-sync`, Windows `%LOCALAPPDATA%\ipfs-sync`, other systems
 * `~/.local/state/ipfs-sync`. The same rule as `deviceStoreDirectory` in cli/device-store-node.ts (a test requires the
 * two to agree); the home directory is read from `HOME` of the given environment only. A relative or missing base throws.
 */
export function perUserStateDir(env, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  const base = (variable, ...rest) => {
    const value = env[variable];
    if (value === undefined || value === "" || !path.isAbsolute(value)) {
      throw new CheckerEnvironmentError(`cannot locate the per-user state directory: ${variable} is not set to an absolute path`);
    }
    return path.join(value, ...rest, STATE_DIRECTORY_NAME);
  };
  if (platform === "win32") return base("LOCALAPPDATA");
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "") return base("XDG_STATE_HOME");
  return platform === "darwin" ? base("HOME", "Library", "Application Support") : base("HOME", ".local", "state");
}

/** True when `child` is `parent` or lies below it. Both must be real paths. */
const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** The real path of `path` when it exists, else the real path of its nearest existing ancestor joined with the rest. */
function resolveThroughMissing(path) {
  const missing = [];
  let current = path;
  for (;;) {
    if (lstatSyncOrNull(current) !== null) return join(realpathSync(current), ...missing);
    const parent = join(current, "..");
    if (parent === current) return path;
    missing.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
}

/** Problems with the owner and the mode of `stats` (skipped where the platform has no uid, as in the CLI's device store). */
function ownerAndModeProblems(stats, wantedMode, label, codePrefix = "trust") {
  if (typeof process.getuid !== "function") return [];
  const problems = [];
  if (stats.uid !== process.getuid()) problems.push(failure(`${codePrefix}-owner`, label, `${label} is owned by uid ${stats.uid}, not by the current user`));
  const mode = stats.mode & 0o777;
  if (mode !== wantedMode) problems.push(failure(`${codePrefix}-mode`, label, `${label} has mode ${mode.toString(8).padStart(4, "0")}, expected ${wantedMode.toString(8).padStart(4, "0")}`));
  return problems;
}

/* ---------- SSH public keys ---------- */

const SIGNER_OVERRIDE_VARIABLE = "IPFS_SYNC_ALLOWED_SIGNERS";
export const REVIEW_NAMESPACE = "ipfs-sync-review";
const REVIEW_PRINCIPAL = "operator";
const KEY_TYPES = new Set([
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);
const PUBLIC_KEY_MAX_BYTES = 16 * 1024;

/** No environment variable selects another allowed-signers file or trust directory: when this one is set, the checker stops. */
function assertNoSignerOverride(environment) {
  if (environment[SIGNER_OVERRIDE_VARIABLE] !== undefined) {
    throw new CheckerEnvironmentError(`${SIGNER_OVERRIDE_VARIABLE} is set; no environment variable selects the allowed-signers file or the trust directory, unset it`);
  }
}

/** `{ type, body }` of one OpenSSH public key line (`<type> <base64> [comment]`); anything else throws. */
function parsePublicKeyLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || !KEY_TYPES.has(parts[0])) {
    throw new CheckerEnvironmentError("not an OpenSSH public key line of a supported type (ssh-ed25519, ecdsa-sha2-nistp*, or their sk- forms), or it carries options in front");
  }
  return { type: parts[0], body: parts[1] };
}

/**
 * The fingerprint `ssh-keygen -l` prints for the key (`SHA256:` and the unpadded base64 of the SHA-256 of the key blob),
 * computed here so that no process has to run to enrol or to compare. The base64 must be canonical and the blob's own
 * type string must equal the line's type. Throws CheckerEnvironmentError on anything else.
 */
export function sshKeyFingerprint(publicKeyLine) {
  const { type, body } = parsePublicKeyLine(publicKeyLine);
  const blob = Buffer.from(body, "base64");
  if (blob.length === 0 || blob.toString("base64") !== body) throw new CheckerEnvironmentError("the key body is not canonical base64");
  const innerLength = blob.length >= 4 ? blob.readUInt32BE(0) : -1;
  if (innerLength < 0 || 4 + innerLength > blob.length || blob.toString("latin1", 4, 4 + innerLength) !== type) {
    throw new CheckerEnvironmentError("the key body does not hold a key of the type the line names");
  }
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The environment ssh-keygen sees: the absolute entries of PATH and the locale. */
function signerToolEnvironment(source) {
  const env = {};
  if (source.PATH) env.PATH = source.PATH.split(delimiter).filter((entry) => isAbsolute(entry)).join(delimiter);
  for (const key of ["LANG", "LC_ALL", "TMPDIR"]) if (source[key]) env[key] = source[key];
  return env;
}

/* ---------- item A: the review record ---------- */

/** Where the per-tree records live (design 9): `review-final-<T8>.md` and, for the signature form, `review-final-<T8>.md.sig`. */
export const REVIEW_RECORD_DIR = "openspec/changes/mvp-07b-keys-history-guard-release-2";
const REVIEWER = "security-reviewer";
const BLOCK_OPEN = "<!-- guard-review:v1 -->";
const BLOCK_CLOSE = "<!-- /guard-review -->";
const SEVERITIES = ["critical", "high", "medium", "low"];
const STATUSES = new Set(["fixed", "open", "accepted"]);
const CHECKER_PATH_IN_TREE = "tools/check-guard-preconditions.mjs";
const COVERED_PREFIXES = ["src/", "cli/", "tools/"];

const reviewRecordPath = (t8) => `${REVIEW_RECORD_DIR}/review-final-${t8}.md`;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const occurrences = (text, needle) => text.split(needle).length - 1;

/** The first thing wrong with the shape of a parsed record, or undefined. Types only: values are judged by the checks that use them. */
function shapeProblem(record) {
  if (!isObject(record)) return "the block is not a JSON object";
  for (const field of ["reviewer", "verdict", "reviewedCommit", "treeSha256", "buildSha256", "checkerSha256"]) {
    if (typeof record[field] !== "string") return `${field} is missing or not a string`;
  }
  if (!Number.isSafeInteger(record.treeFileCount) || record.treeFileCount < 0) return "treeFileCount is missing or not a non-negative integer";
  if (!isObject(record.checklistTests) || !Object.values(record.checklistTests).every((value) => typeof value === "string")) return "checklistTests is missing or not a map of path to hash";
  if (!Array.isArray(record.coverage) || !record.coverage.every((entry) => isObject(entry) && typeof entry.path === "string" && typeof entry.read === "boolean")) {
    return "coverage is missing or holds an entry that is not {path: string, read: boolean}";
  }
  if (!isObject(record.counts) || !SEVERITIES.every((severity) => Number.isSafeInteger(record.counts[severity]) && record.counts[severity] >= 0)) {
    return "counts is missing or lacks a non-negative integer for critical, high, medium or low";
  }
  const findingsOk =
    Array.isArray(record.findings) &&
    record.findings.every(
      (item) =>
        isObject(item) &&
        typeof item.id === "string" &&
        SEVERITIES.includes(item.severity) &&
        STATUSES.has(item.status) &&
        (item.acceptedBecause === undefined || typeof item.acceptedBecause === "string"),
    );
  return findingsOk ? undefined : "findings is missing or holds a finding without a string id, a known severity and a known status";
}

/**
 * The JSON object between `<!-- guard-review:v1 -->` and `<!-- /guard-review -->`: exactly one block, valid JSON, the shape
 * of design 9. Returns `{ ok: true, record }` or `{ ok: false, detail }`.
 */
export function parseReviewRecord(text) {
  if (occurrences(text, BLOCK_OPEN) !== 1 || occurrences(text, BLOCK_CLOSE) !== 1) {
    return { ok: false, detail: `the file must hold exactly one ${BLOCK_OPEN} ... ${BLOCK_CLOSE} block` };
  }
  const start = text.indexOf(BLOCK_OPEN) + BLOCK_OPEN.length;
  const end = text.indexOf(BLOCK_CLOSE);
  if (end < start) return { ok: false, detail: "the closing marker comes before the opening marker" };
  let record;
  try {
    record = JSON.parse(text.slice(start, end));
  } catch (error) {
    return { ok: false, detail: `the block is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const problem = shapeProblem(record);
  return problem === undefined ? { ok: true, record } : { ok: false, detail: problem };
}

/** A file of `commit` read from the object database: `undefined` when absent, `{ irregular: true }` for a link or folder, else `{ oid, data }`. */
function blobAt(root, commit, path) {
  const listed = runGit(root, ["ls-tree", "-z", commit, "--", path]);
  if (listed.status !== 0 || listed.stdout.length === 0) return undefined;
  const text = listed.stdout.toString("utf8");
  const tab = text.indexOf("\t");
  const [mode, type, oid] = text.slice(0, tab).split(" ");
  if (type !== "blob" || !REGULAR_MODES.has(mode)) return { irregular: true };
  return { oid, data: readBlobs(root, [oid]).get(oid) };
}

const isSafeRelativePath = (path) => path !== "" && !isAbsolute(path) && !path.includes("\0") && !path.split("/").some((part) => part === "" || part === "." || part === "..");

/** Every check of the record's content against T, B, the checker file and the checklist tests. Returns `{ failures, accepted, unread }`. */
function checkRecordContent({ root, tree, buildSha256, record, path }) {
  const failures = [];
  const bad = (code, subject, detail) => void failures.push(failure(code, subject, detail));
  if (record.reviewer !== REVIEWER) bad("review-reviewer", path, `reviewer is ${JSON.stringify(record.reviewer)}, expected ${JSON.stringify(REVIEWER)}`);
  if (record.verdict !== "approved") bad("review-verdict", path, `verdict is ${JSON.stringify(record.verdict)}, expected "approved"`);
  if (record.treeSha256 !== tree.treeSha256) bad("review-tree-mismatch", path, `the record reviewed tree ${record.treeSha256}, the current tree is ${tree.treeSha256}`);
  if (record.treeSha256.slice(0, 8) !== tree.t8) bad("review-name-mismatch", path, `the file name carries T8 ${tree.t8}, the record's tree starts with ${record.treeSha256.slice(0, 8)}`);
  if (record.treeFileCount !== tree.fileCount) bad("review-file-count", path, `treeFileCount is ${record.treeFileCount}, the tree has ${tree.fileCount} files`);
  if (record.buildSha256 !== buildSha256) bad("review-build-mismatch", path, `buildSha256 ${record.buildSha256} is not the build hash B ${buildSha256}`);
  const checkerEntry = tree.entries.find((entry) => entry.path === CHECKER_PATH_IN_TREE);
  if (checkerEntry === undefined) bad("review-checker-mismatch", path, `${CHECKER_PATH_IN_TREE} is not in the tree`);
  else if (record.checkerSha256 !== checkerEntry.sha256) bad("review-checker-mismatch", path, `checkerSha256 ${record.checkerSha256} is not the hash of ${CHECKER_PATH_IN_TREE} (${checkerEntry.sha256})`);

  for (const [testPath, hash] of Object.entries(record.checklistTests)) {
    if (!isSafeRelativePath(testPath)) {
      bad("review-checklist-path", testPath, `checklistTests names ${JSON.stringify(testPath)}, which is not a path inside the repository`);
      continue;
    }
    const found = blobAt(root, tree.commit, testPath);
    if (found === undefined || found.irregular) bad("review-checklist-missing", testPath, `${testPath} is not a file in the commit`);
    else if (createHash("sha256").update(found.data).digest("hex") !== hash) bad("review-checklist-mismatch", testPath, `${testPath} differs from the hash in checklistTests`);
  }

  const derived = Object.fromEntries(SEVERITIES.map((severity) => [severity, record.findings.filter((item) => item.severity === severity).length]));
  const contradicting = SEVERITIES.filter((severity) => derived[severity] !== record.counts[severity]);
  if (contradicting.length > 0) {
    bad("review-counts-mismatch", path, `counts ${contradicting.map((s) => `${s}=${record.counts[s]}`).join(", ")} contradict the findings (${contradicting.map((s) => `${s}=${derived[s]}`).join(", ")})`);
  }
  const accepted = [];
  for (const item of record.findings) {
    const blocking = item.severity === "critical" || item.severity === "high";
    if (item.status === "fixed") continue;
    if (blocking || item.status === "open") {
      bad("review-open-finding", item.id, `${item.id} (${item.severity}) is ${item.status}${blocking ? "; critical and high findings must be fixed" : ""}`);
    } else if (typeof item.acceptedBecause !== "string" || item.acceptedBecause.trim() === "") {
      bad("review-accepted-without-reason", item.id, `${item.id} (${item.severity}) is accepted without a reason`);
    } else {
      accepted.push({ id: item.id, severity: item.severity, because: item.acceptedBecause });
    }
  }

  const expected = new Set(tree.entries.map((entry) => entry.path).filter((entryPath) => COVERED_PREFIXES.some((prefix) => entryPath.startsWith(prefix))));
  const seen = new Set();
  for (const entry of record.coverage) {
    if (seen.has(entry.path)) bad("review-coverage-repeated", entry.path, `coverage lists ${entry.path} more than once`);
    else if (!expected.has(entry.path)) bad("review-coverage-extra", entry.path, `coverage lists ${entry.path}, which is not in the file list`);
    seen.add(entry.path);
  }
  for (const covered of [...expected].sort()) if (!seen.has(covered)) bad("review-coverage-missing", covered, `coverage has no entry for ${covered}`);
  const unread = record.coverage.filter((entry) => entry.read === false && expected.has(entry.path)).map((entry) => entry.path).sort();
  return { failures, accepted, unread };
}

/**
 * Form (a), the git-history binding: E is the last commit that touched the record, it descends from `reviewedCommit` and
 * changed only that file, the file at the checked commit equals the file at E, and T computed from the objects of
 * `reviewedCommit` equals the record's `treeSha256`. Returns `{ failures, evidence }` (E and the commit count).
 */
function authenticateByHistory({ root, tree, record, path }) {
  const failures = [];
  const bad = (code, detail) => void failures.push(failure(code, path, detail));
  const reviewed = record.reviewedCommit;
  let reviewable = false;
  if (!OBJECT_ID.test(reviewed)) bad("review-commit-invalid", `reviewedCommit ${JSON.stringify(reviewed)} is not a full object id`);
  else if (runGit(root, ["rev-parse", "--verify", "--quiet", `${reviewed}^{commit}`]).status !== 0) bad("review-commit-unknown", `reviewedCommit ${reviewed} is not a commit in this repository`);
  else reviewable = true;

  const touching = gitOk(root, ["rev-list", "--topo-order", "--full-history", tree.commit, "--", path]).stdout.toString("utf8").split("\n").filter((line) => line !== "");
  if (touching.length === 0) {
    bad("review-not-committed", `${path} has no commit in the history of ${tree.commit}`);
    return { failures, evidence: {} };
  }
  const commit = touching[0];
  const evidence = { commit, commitCount: touching.length };
  const changed = splitZ(gitOk(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", "--root", commit]).stdout);
  if (changed.length !== 1 || changed[0] !== path) bad("review-commit-extra-files", `the last commit ${commit} changed ${changed.length} files (${changed.slice(0, 5).join(", ")}), expected only ${path}`);
  const blobOf = (spec) => runGit(root, ["rev-parse", spec]).stdout.toString("utf8").trim();
  if (blobOf(`${tree.commit}:${path}`) !== blobOf(`${commit}:${path}`)) bad("review-record-edited", `${path} at ${tree.commit} differs from the file at its last commit ${commit}`);
  if (reviewable) {
    if (reviewed === commit || runGit(root, ["merge-base", "--is-ancestor", reviewed, commit]).status !== 0) {
      bad("review-commit-not-ancestor", `the record's commit ${commit} does not descend from reviewedCommit ${reviewed}`);
    } else {
      const atReviewed = treeHashAtCommit({ root, commit: reviewed });
      if (!atReviewed.ok) bad("review-reviewed-tree-unreadable", `T cannot be computed from reviewedCommit ${reviewed}: ${atReviewed.failures.map((item) => item.code).join(", ")}`);
      else if (atReviewed.treeSha256 !== record.treeSha256) bad("review-reviewed-tree-differs", `T computed from reviewedCommit ${reviewed} is ${atReviewed.treeSha256}, the record says ${record.treeSha256}`);
    }
  }
  return { failures, evidence };
}

/* ---------- the trust anchor for the signature form ---------- */

/**
 * Inspects `<per-user dir>/trust/` (design 9, Q-14): the directory 0700 and the files 0600, owned by the current user,
 * none a symbolic link, the real path outside the repository, allowed-signers holding exactly one entry
 * `operator namespaces="ipfs-sync-review" <key>`, and the fingerprint of that key equal to the enrolled one. There is no
 * way to point it elsewhere. Returns `{ ok: true, allowedSignersPath, fingerprint }` or `{ ok: false, failures }`.
 */
function inspectTrustAnchor({ root, environment }) {
  assertNoSignerOverride(environment);
  const directory = join(perUserStateDir(environment), TRUST_DIRECTORY_NAME);
  const stop = (...failures) => ({ ok: false, failures });
  const stats = lstatSyncOrNull(directory);
  if (stats === null) return stop(failure("trust-missing", directory, `no trust directory at ${directory}; enrol a signer with --enrol-signer on a terminal`));
  if (stats.isSymbolicLink()) return stop(failure("trust-symlink", directory, `${directory} is a symbolic link`));
  if (!stats.isDirectory()) return stop(failure("trust-not-directory", directory, `${directory} is not a directory`));
  const realRoot = realpathSync(root);
  const realDirectory = realpathSync(directory);
  if (isInside(realRoot, realDirectory) || isInside(realDirectory, realRoot)) {
    return stop(failure("trust-inside-repository", directory, `the trust directory ${realDirectory} and the repository ${realRoot} overlap; the trust anchor must live outside the repository`));
  }
  const problems = ownerAndModeProblems(stats, 0o700, directory);
  const paths = { allowed: join(directory, ALLOWED_SIGNERS_FILE), signer: join(directory, SIGNER_RECORD_FILE) };
  for (const file of Object.values(paths)) {
    const info = lstatSyncOrNull(file);
    if (info === null) problems.push(failure("trust-missing", file, `${file} does not exist`));
    else if (info.isSymbolicLink()) problems.push(failure("trust-symlink", file, `${file} is a symbolic link`));
    else if (!info.isFile()) problems.push(failure("trust-not-file", file, `${file} is not a regular file`));
    else problems.push(...ownerAndModeProblems(info, 0o600, file));
  }
  if (problems.length > 0) return { ok: false, failures: problems };

  const allowed = readFileSync(paths.allowed, "utf8");
  const entries = allowed.split(/\r?\n/).filter((line) => line.trim() !== "");
  const entry = entries.length === 1 ? new RegExp(`^${REVIEW_PRINCIPAL} namespaces="${REVIEW_NAMESPACE}" (\\S+) (\\S+)(?:\\s.*)?$`).exec(entries[0]) : null;
  let fingerprint;
  try {
    if (entry === null) throw new CheckerEnvironmentError(`allowed-signers must hold exactly one entry '${REVIEW_PRINCIPAL} namespaces="${REVIEW_NAMESPACE}" <key>' and nothing else`);
    fingerprint = sshKeyFingerprint(`${entry[1]} ${entry[2]}`);
  } catch (error) {
    return stop(failure("trust-allowed-signers", paths.allowed, error instanceof Error ? error.message : String(error)));
  }
  let enrolled;
  try {
    const parsed = JSON.parse(readFileSync(paths.signer, "utf8"));
    if (!isObject(parsed) || parsed.schema !== 1 || typeof parsed.fingerprint !== "string") throw new Error("expected {schema: 1, fingerprint: string}");
    enrolled = parsed.fingerprint;
  } catch (error) {
    return stop(failure("trust-signer-file", paths.signer, `${SIGNER_RECORD_FILE} is unreadable: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (enrolled !== fingerprint) return stop(failure("trust-fingerprint-mismatch", paths.signer, `the enrolled fingerprint ${enrolled} is not the fingerprint of the key in allowed-signers (${fingerprint})`));
  return { ok: true, allowedSignersPath: paths.allowed, fingerprint };
}

/**
 * The signature check shared by item A (the review record) and item C (the phone-timing statement):
 * `ssh-keygen -Y verify -f <allowed-signers> -I operator -n ipfs-sync-review -s <sig>` with the signed bytes on standard
 * input, against the trust anchor above, and the verifying key must be the enrolled one. `codePrefix` names the item's
 * failure codes (`review`, `phone`); a trust-anchor problem keeps its `trust-*` code.
 */
function verifyWithTrustAnchor({ root, environment, path, data, signatureData, codePrefix }) {
  const trust = inspectTrustAnchor({ root, environment });
  if (!trust.ok) return { failures: trust.failures, evidence: {} };
  const work = mkdtempSync(join(temporaryParent(root), "guard-signature-"));
  try {
    const signatureFile = join(work, "record.sig");
    writeFileSync(signatureFile, signatureData, { mode: 0o600 });
    const run = spawnSync("ssh-keygen", ["-Y", "verify", "-f", trust.allowedSignersPath, "-I", REVIEW_PRINCIPAL, "-n", REVIEW_NAMESPACE, "-s", signatureFile], {
      input: data,
      env: signerToolEnvironment(environment),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    });
    if (run.error) return { failures: [failure(`${codePrefix}-signature-unverifiable`, path, `cannot run ssh-keygen: ${run.error.message}`)], evidence: {} };
    const signer = /key (SHA256:[A-Za-z0-9+/]+)/.exec(run.stdout)?.[1];
    if (run.status !== 0) return { failures: [failure(`${codePrefix}-signature-invalid`, path, `ssh-keygen -Y verify refused the signature: ${tail(`${run.stderr}${run.stdout}`)}`)], evidence: {} };
    if (signer !== trust.fingerprint) return { failures: [failure(`${codePrefix}-signature-invalid`, path, `the signature verified under ${signer ?? "an unknown key"}, not under the enrolled key ${trust.fingerprint}`)], evidence: {} };
    return { failures: [], evidence: { signerFingerprint: trust.fingerprint } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Form (b) of item A: the committed `.sig` over the committed record. */
const authenticateBySignature = ({ root, environment, path, recordData, signatureData }) =>
  verifyWithTrustAnchor({ root, environment, path, data: recordData, signatureData, codePrefix: "review" });

/**
 * Item A for the tree `tree` (a successful `computeTreeHash` result) and the build hash B. Reads the record, its
 * signature and everything else from the objects of `tree.commit`, never from the working tree. A committed
 * `.sig` selects form (b), and a failing signature is a failure, not a reason to fall back to form (a). Returns
 * `{ ok, form, failures, evidence, accepted, unread }`; throws CheckerEnvironmentError when it cannot run.
 */
export function checkReviewRecord({ root, tree, buildSha256, environment = process.env }) {
  assertNoSignerOverride(environment);
  const path = reviewRecordPath(tree.t8);
  const result = (failures, rest = {}) => ({ ok: failures.length === 0, form: undefined, evidence: { recordPath: path }, accepted: [], unread: [], ...rest, failures });
  const found = blobAt(root, tree.commit, path);
  if (found === undefined) return result([failure("review-record-missing", path, `${path} is not committed at ${tree.commit} (T8 ${tree.t8}); a review record is a new file per tree`)]);
  if (found.irregular) return result([failure("review-record-missing", path, `${path} is not a regular file`)]);
  const parsed = parseReviewRecord(found.data.toString("utf8"));
  if (!parsed.ok) return result([failure("review-record-malformed", path, parsed.detail)]);
  const content = checkRecordContent({ root, tree, buildSha256, record: parsed.record, path });
  const signature = blobAt(root, tree.commit, `${path}.sig`);
  const form = signature === undefined ? "git-history" : "signature";
  let authenticated;
  if (signature === undefined) authenticated = authenticateByHistory({ root, tree, record: parsed.record, path });
  else if (signature.irregular) authenticated = { failures: [failure("review-signature-invalid", `${path}.sig`, `${path}.sig is not a regular file`)], evidence: {} };
  else authenticated = authenticateBySignature({ root, environment, path, recordData: found.data, signatureData: signature.data });
  return result([...content.failures, ...authenticated.failures], {
    form: authenticated.failures.length === 0 ? form : undefined,
    evidence: { recordPath: path, ...authenticated.evidence },
    accepted: content.accepted,
    unread: content.unread,
  });
}

/**
 * Which commit the build is made from: `reviewedCommit` of the record for this tree when it is an ancestor of the checked
 * commit and its scoped tree equals T (design 9: "the tree of reviewedCommit, HEAD before a record exists"), else the
 * checked commit. A record that is missing or malformed is item A's failure, not a reason to stop here.
 */
function chooseBuildCommit(root, tree) {
  const found = blobAt(root, tree.commit, reviewRecordPath(tree.t8));
  if (found === undefined || found.irregular) return tree.commit;
  const parsed = parseReviewRecord(found.data.toString("utf8"));
  if (!parsed.ok || !OBJECT_ID.test(parsed.record.reviewedCommit)) return tree.commit;
  const reviewed = parsed.record.reviewedCommit;
  if (runGit(root, ["rev-parse", "--verify", "--quiet", `${reviewed}^{commit}`]).status !== 0) return tree.commit;
  if (runGit(root, ["merge-base", "--is-ancestor", reviewed, tree.commit]).status !== 0) return tree.commit;
  const atReviewed = treeHashAtCommit({ root, commit: reviewed });
  return atReviewed.ok && atReviewed.treeSha256 === tree.treeSha256 ? reviewed : tree.commit;
}

/* ---------- item B: the operator-run record ---------- */

/** The record and the transcript the operator-run script (task 4.6) writes beside each other in `<per-user dir>/feature-ops/`. */
export const OPERATOR_RECORD_FILE = "feature-op-mvp-07.json";
export const OPERATOR_TRANSCRIPT_FILE = "feature-op-mvp-07.transcript.log";
export const FEATURE_OPS_DIRECTORY = "feature-ops";
/** Freshness bound (spec "Item B"): `finishedAt` at most this long before the check. */
export const OPERATOR_RECORD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A `finishedAt` later than now by more than this is a clock error or a forgery, not a fresh run. */
const OPERATOR_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The run uses two throwaway vaults (design 11). */
const MIN_THROWAWAY_VAULTS = 2;

const requiredAssertion = (id, kind = "machine") => Object.freeze({ id, kind });

/**
 * The assertion ids the operator run must record, each passed, with the kind each must carry (spec "Item B": held in the
 * checker, never read from the record). The ids are those of the `release-2` spec; a test compares them with its text, and
 * task 4.6 compares them with the list the operator-run script exports. `first-pull-confirm-shown` is the one the spec
 * marks operator-observed.
 */
export const REQUIRED_ASSERTIONS = Object.freeze([
  requiredAssertion("ciphertext-only-on-node"),
  requiredAssertion("plaintext-restored-byte-equal"),
  requiredAssertion("wrong-passphrase-refused"),
  requiredAssertion("first-pull-confirm-shown", "operator-observed"),
  requiredAssertion("sequence-recorded"),
  requiredAssertion("tamper-refused-nothing-written"),
  requiredAssertion("pull-no-node-mutation"),
  requiredAssertion("conflict-copy-kept"),
  requiredAssertion("multi-segment-blob-pulled-in-plugin"),
  requiredAssertion("older-root-by-name-refused"),
  requiredAssertion("restore-older-version"),
  requiredAssertion("fork-resolved"),
  requiredAssertion("rewrap-and-accept"),
  requiredAssertion("increase-cost"),
  requiredAssertion("prune-history"),
  requiredAssertion("mass-removal-stopped"),
  requiredAssertion("installed-files-hashed"),
  requiredAssertion("only-demo-root-and-owned-key-changed"),
]);

/** A throwaway vault's installed plugin files and the build output each must equal. styles.css exists only when the build makes one. */
const INSTALLED_PLUGIN_FILES = Object.freeze([
  Object.freeze({ name: "main.js", built: "dist/plugin/main.js" }),
  Object.freeze({ name: "manifest.json", built: "dist/plugin/manifest.json" }),
  Object.freeze({ name: "styles.css", built: "dist/plugin/styles.css" }),
]);
const INSTALLED_CLI_OUTPUT = "dist/cli/ipfs-sync.mjs";

/** The first thing wrong with the shape of a parsed operator record, or undefined. Types only: values are judged by the checks that use them. */
function operatorShapeProblem(record) {
  if (!isObject(record)) return "the record is not a JSON object";
  for (const field of ["mode", "finishedAt", "treeSha256", "transcriptSha256"]) {
    if (typeof record[field] !== "string") return `${field} is missing or not a string`;
  }
  if (typeof record.passed !== "boolean") return "passed is missing or not a boolean";
  const { installed } = record;
  if (!isObject(installed) || typeof installed.cli !== "string" || !Array.isArray(installed.vaults)) return "installed is missing or lacks vaults (a list) and cli (a hash)";
  const vaultsOk = installed.vaults.every((vault) => isObject(vault) && isObject(vault.files) && Object.values(vault.files).every((value) => typeof value === "string"));
  if (!vaultsOk) return "installed.vaults holds an entry that is not {name, files: {file: hash}}";
  const assertionsOk = Array.isArray(record.assertions) && record.assertions.every((entry) => isObject(entry) && typeof entry.id === "string" && typeof entry.kind === "string" && typeof entry.passed === "boolean");
  return assertionsOk ? undefined : "assertions is missing or holds an entry without a string id, a string kind and a boolean passed";
}

/**
 * One file of the feature-ops folder, read after its own checks: not a symbolic link, a regular file, owned by the current
 * user and mode 0600. Returns `{ failures, data }`; `data` is absent when the file is missing, a link or not a regular
 * file (nothing behind a link is read), and present, with the owner or mode failure listed, otherwise.
 */
function readOperatorFile(path, missingCode, missingDetail, prefix = "operator") {
  const stats = lstatSyncOrNull(path);
  if (stats === null) return { failures: [failure(missingCode, path, missingDetail)] };
  if (stats.isSymbolicLink()) return { failures: [failure(`${prefix}-symlink`, path, `${path} is a symbolic link`)] };
  if (!stats.isFile()) return { failures: [failure(`${prefix}-not-file`, path, `${path} is not a regular file`)] };
  return { failures: ownerAndModeProblems(stats, 0o600, path, prefix), data: readFileSync(path) };
}

/**
 * The `feature-ops` folder: present, a real directory, owned by the current user, mode 0700. Returns `{ failures, directory,
 * recordPath, usable }`. Items B and C share it; `recordFile`, `prefix` (the failure-code prefix) and `missingDetail` say whose
 * record the caller looks for.
 */
function inspectFeatureOps(environment, { recordFile = OPERATOR_RECORD_FILE, prefix = "operator", missingDetail } = {}) {
  const directory = join(perUserStateDir(environment), FEATURE_OPS_DIRECTORY);
  const stats = lstatSyncOrNull(directory);
  const recordPath = join(directory, recordFile);
  if (stats === null) {
    const detail = missingDetail ?? `no operator-run record at ${recordPath}; the operator run (tools/feature-op-mvp-07.mjs) writes it`;
    return { directory, recordPath, usable: false, failures: [failure(`${prefix}-record-missing`, recordPath, detail)] };
  }
  if (stats.isSymbolicLink()) return { directory, recordPath, usable: false, failures: [failure(`${prefix}-symlink`, directory, `${directory} is a symbolic link`)] };
  if (!stats.isDirectory()) return { directory, recordPath, usable: false, failures: [failure(`${prefix}-not-directory`, directory, `${directory} is not a directory`)] };
  return { directory, recordPath, usable: true, failures: ownerAndModeProblems(stats, 0o700, directory, prefix) };
}

/** The installed-file hashes of the record against B; one failure per file that differs. */
function installedFileProblems(installed, buildFiles) {
  const failures = [];
  const compare = (label, actual, wanted, builtPath) => {
    if (wanted === undefined && actual !== undefined) failures.push(failure("operator-install-mismatch", label, `${label} is recorded, but the build B has no ${builtPath}`));
    else if (wanted !== undefined && actual === undefined) failures.push(failure("operator-install-mismatch", label, `${label} is not recorded; the build B has ${builtPath}`));
    else if (wanted !== undefined && actual !== wanted) failures.push(failure("operator-install-mismatch", label, `${label} has sha256 ${actual}, the build B has ${wanted} for ${builtPath}`));
  };
  if (installed.vaults.length < MIN_THROWAWAY_VAULTS) {
    failures.push(failure("operator-vaults", undefined, `the record lists ${installed.vaults.length} throwaway vaults, the run uses ${MIN_THROWAWAY_VAULTS}`));
  }
  installed.vaults.forEach((vault, index) => {
    const name = typeof vault.name === "string" ? vault.name : `vault ${index + 1}`;
    for (const file of INSTALLED_PLUGIN_FILES) compare(`${name}/${file.name}`, vault.files[file.name], buildFiles[file.built], file.built);
  });
  compare("cli bundle", installed.cli, buildFiles[INSTALLED_CLI_OUTPUT], INSTALLED_CLI_OUTPUT);
  return failures;
}

/** Each required assertion present once, passed, and of the required kind. */
function assertionProblems(assertions) {
  const failures = [];
  const found = new Map();
  const repeated = new Set();
  for (const entry of assertions) {
    if (found.has(entry.id)) repeated.add(entry.id);
    else found.set(entry.id, entry);
  }
  let satisfied = 0;
  for (const required of REQUIRED_ASSERTIONS) {
    const entry = found.get(required.id);
    if (repeated.has(required.id)) failures.push(failure("operator-assertion-duplicate", required.id, `${required.id} is listed more than once`));
    else if (entry === undefined) failures.push(failure("operator-assertion-missing", required.id, `the record has no assertion ${required.id}`));
    else {
      const before = failures.length;
      if (entry.kind !== required.kind) failures.push(failure("operator-assertion-kind", required.id, `${required.id} is recorded as ${JSON.stringify(entry.kind)}, the checker requires ${JSON.stringify(required.kind)}`));
      if (entry.passed !== true) failures.push(failure("operator-assertion-failed", required.id, `${required.id} did not pass`));
      if (failures.length === before) satisfied += 1;
    }
  }
  return { failures, satisfied };
}

/**
 * Item B for the tree `tree` (a successful `computeTreeHash` result) and the build files `buildFiles` (B's map of path to
 * sha256): `<per-user dir>/feature-ops/feature-op-mvp-07.json` and the transcript beside it (spec "Item B"). Checked: the
 * folder and the files (owner, mode 0700 / 0600, no symbolic link), `mode` manual and not a simulated run, `passed`, `finishedAt`
 * within 14 days and not in the future, `treeSha256` equal to T, the installed-file hashes of at least two vaults and the
 * CLI bundle equal to B, every `REQUIRED_ASSERTIONS` id present once, passed and of the required kind, and `transcriptSha256`
 * equal to the hash of the transcript. `now` is for tests. Returns `{ ok, failures, evidence }`; the evidence holds the
 * record path, the finish time and the number of required assertions satisfied. Reads only; throws CheckerEnvironmentError
 * when the per-user directory cannot be located.
 */
export function checkOperatorRecord({ tree, buildFiles, environment = process.env, now = Date.now() }) {
  const folder = inspectFeatureOps(environment);
  const evidence = { recordPath: folder.recordPath };
  const result = (failures) => ({ ok: failures.length === 0, failures, evidence });
  if (!folder.usable) return result(folder.failures);
  const failures = [...folder.failures];
  const recordFile = readOperatorFile(folder.recordPath, "operator-record-missing", `no operator-run record at ${folder.recordPath}; the operator run (tools/feature-op-mvp-07.mjs) writes it`);
  failures.push(...recordFile.failures);
  if (recordFile.data === undefined) return result(failures);
  let record;
  try {
    record = JSON.parse(recordFile.data.toString("utf8"));
  } catch (error) {
    return result([...failures, failure("operator-record-malformed", folder.recordPath, `the record is not valid JSON (${error instanceof Error ? error.message : String(error)})`)]);
  }
  const shape = operatorShapeProblem(record);
  if (shape !== undefined) return result([...failures, failure("operator-record-malformed", folder.recordPath, shape)]);

  const bad = (code, subject, detail) => void failures.push(failure(code, subject, detail));
  if (record.mode === "verify-only" || record.verifyOnly === true || record.phases === "script-only") {
    bad("operator-simulated", folder.recordPath, "the record comes from a verify-only or script-only run, which is not operator evidence");
  } else if (record.mode !== "manual") {
    bad("operator-not-manual", folder.recordPath, `mode is ${JSON.stringify(record.mode)}, expected "manual"`);
  }
  if (record.passed !== true) bad("operator-not-passed", folder.recordPath, "the record says the run did not pass");
  const finished = Date.parse(record.finishedAt);
  if (Number.isNaN(finished)) bad("operator-record-malformed", folder.recordPath, `finishedAt ${JSON.stringify(record.finishedAt)} is not a date`);
  else {
    evidence.finishedAt = record.finishedAt;
    if (finished > now + OPERATOR_CLOCK_SKEW_MS) bad("operator-finished-in-future", folder.recordPath, `finishedAt ${record.finishedAt} is in the future`);
    else if (now - finished > OPERATOR_RECORD_MAX_AGE_MS) bad("operator-stale", folder.recordPath, `the run finished at ${record.finishedAt}, more than 14 days before this check`);
  }
  if (record.treeSha256 !== tree.treeSha256) bad("operator-tree-mismatch", folder.recordPath, `the run was for tree ${record.treeSha256}, the current tree is ${tree.treeSha256}`);
  failures.push(...installedFileProblems(record.installed, buildFiles));
  const assertions = assertionProblems(record.assertions);
  failures.push(...assertions.failures);
  evidence.assertionCount = assertions.satisfied;

  const transcriptPath = join(folder.directory, OPERATOR_TRANSCRIPT_FILE);
  const transcript = readOperatorFile(transcriptPath, "operator-transcript-missing", `no transcript at ${transcriptPath}; the record's transcriptSha256 cannot be checked`);
  failures.push(...transcript.failures);
  if (transcript.data !== undefined && createHash("sha256").update(transcript.data).digest("hex") !== record.transcriptSha256) {
    bad("operator-transcript-mismatch", transcriptPath, "the transcript beside the record does not match its transcriptSha256");
  }
  return result(failures);
}

/* ---------- item C: phone timing or recorded acceptance ---------- */

/**
 * The files the recorder (task 4.5) writes beside the operator-run record, in `<per-user dir>/feature-ops/`. The spec fixes
 * neither a name nor the signed statement's location; these are this checker's choice and the recorder imports them. The
 * signed form is the statement and `<statement>.sig`, made by the enrolled key.
 */
export const PHONE_TIMING_RECORD_FILE = "phone-timing.json";
export const PHONE_TIMING_STATEMENT_FILE = "phone-timing-statement.txt";
/** The cost the timing is measured at (mvp-06 default) and the thresholds of the mobile-feasibility phase (operator decision 4, 2026-10-03). */
export const PHONE_TIMING_PARAMETERS = "m=65536 KiB t=3 p=1";
export const PHONE_TIMING_MAX_SECONDS = 3;
export const PHONE_TIMING_MAX_GAP_MS = 100;
/** Freshness bound of a measurement and of an acceptance: the same 14 days as item B. */
export const PHONE_TIMING_MAX_AGE_MS = OPERATOR_RECORD_MAX_AGE_MS;
/** The phrase the operator types to record an acceptance (the wording is open question 8; the recorder imports it from here). */
export const PHONE_ACCEPTANCE_PHRASE = "I accept the phone timing as unmeasured for this tree and build";
const PHONE_CODE = "phone";
const PLUGIN_MAIN_JS = "dist/plugin/main.js";
/** The plugin command shows the first 16 hex characters of the `main.js` hash (design 10); a signed statement names the same prefix. */
const BUILD_PREFIX_LENGTH = 16;
const STATEMENT_MAX_BYTES = 16 * 1024;

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** True when `text` holds `token` as a whole hexadecimal word: not inside a longer run of hex digits. */
const namesToken = (text, token) => new RegExp(`(?<![0-9a-fA-F])${token}(?![0-9a-fA-F])`).test(text);

/** The failure for a missing, unparsable, future or stale time stamp in `value`, or undefined. */
function timeProblem(value, field, path, now) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) return failure("phone-record-malformed", path, `${field} ${JSON.stringify(value)} is not a date`);
  if (time > now + OPERATOR_CLOCK_SKEW_MS) return failure("phone-finished-in-future", path, `${field} ${value} is in the future`);
  if (now - time > PHONE_TIMING_MAX_AGE_MS) return failure("phone-stale", path, `${field} ${value} is more than 14 days before this check`);
  return undefined;
}

/** `pluginMainJsSha256` of a record against the `main.js` hash of B: a missing hash or another build fails. */
function buildBindingProblem(record, buildFiles, path) {
  const wanted = buildFiles[PLUGIN_MAIN_JS];
  if (wanted === undefined) return failure("phone-build-mismatch", path, `the build B has no ${PLUGIN_MAIN_JS}`);
  if (record.pluginMainJsSha256 === wanted) return undefined;
  const found = typeof record.pluginMainJsSha256 === "string" ? record.pluginMainJsSha256 : "no hash";
  return failure("phone-build-mismatch", path, `the record is for plugin build ${found}, the build B has ${wanted}`);
}

/** `kind: "measured"`: a completed derivation at the default cost, under the thresholds, bound to the build B. */
function judgeMeasured(record, { path, buildFiles, now }) {
  const failures = [];
  const bad = (code, detail) => void failures.push(failure(code, path, detail));
  if (record.completed !== true) bad("phone-not-completed", "the measurement did not complete (completed is not true)");
  if (record.parameters !== PHONE_TIMING_PARAMETERS) bad("phone-parameters", `parameters are ${JSON.stringify(record.parameters)}, expected ${JSON.stringify(PHONE_TIMING_PARAMETERS)}`);
  if (!isFiniteNumber(record.seconds) || record.seconds <= 0 || record.seconds >= PHONE_TIMING_MAX_SECONDS) {
    bad("phone-seconds", `seconds is ${JSON.stringify(record.seconds)}, expected a number greater than 0 and under ${PHONE_TIMING_MAX_SECONDS}`);
  }
  if (!isFiniteNumber(record.longestGapMs) || record.longestGapMs < 0 || record.longestGapMs >= PHONE_TIMING_MAX_GAP_MS) {
    bad("phone-gap", `longestGapMs is ${JSON.stringify(record.longestGapMs)}, expected a number of at least 0 and under ${PHONE_TIMING_MAX_GAP_MS}`);
  }
  if (!isNonEmptyString(record.device) || !isNonEmptyString(record.os)) bad("phone-device", "the record names no device or no OS");
  if (record.nonceVerified !== true) bad("phone-nonce", "the nonce was not verified (nonceVerified is not true)");
  const time = timeProblem(record.finishedAt, "finishedAt", path, now);
  if (time !== undefined) failures.push(time);
  const binding = buildBindingProblem(record, buildFiles, path);
  if (binding !== undefined) failures.push(binding);
  const details = { timingMeasured: true, device: record.device, os: record.os, seconds: record.seconds, longestGapMs: record.longestGapMs, finishedAt: record.finishedAt };
  return { failures, form: "measured", details };
}

/** `kind: "acceptance"`: the operator's typed phrase and statement, bound to the tree T and the build B, within 14 days. */
function judgeAcceptance(record, { path, tree, buildFiles, now }) {
  const failures = [];
  const bad = (code, detail) => void failures.push(failure(code, path, detail));
  if (record.nonceVerified !== true) bad("phone-nonce", "the nonce was not verified (nonceVerified is not true)");
  if (record.phrase !== PHONE_ACCEPTANCE_PHRASE) bad("phone-phrase", "the typed phrase is missing or is not the one the checker requires");
  if (!isNonEmptyString(record.statement)) bad("phone-statement", "the acceptance carries no statement");
  const time = timeProblem(record.acceptedAt, "acceptedAt", path, now);
  if (time !== undefined) failures.push(time);
  if (record.treeSha256 !== tree.treeSha256) bad("phone-tree-mismatch", `the acceptance is for tree ${typeof record.treeSha256 === "string" ? record.treeSha256 : "none"}, the current tree is ${tree.treeSha256}`);
  const binding = buildBindingProblem(record, buildFiles, path);
  if (binding !== undefined) failures.push(binding);
  return { failures, form: "acceptance", details: { timingMeasured: false, finishedAt: record.acceptedAt } };
}

/** The JSON record form: `phone-timing.json` read after its owner, mode and link checks, then judged by its `kind`. */
function judgeTimingRecord(path, context) {
  const file = readOperatorFile(path, "phone-record-missing", `no phone-timing record at ${path}`, PHONE_CODE);
  if (file.data === undefined) return { failures: file.failures };
  let record;
  try {
    record = JSON.parse(file.data.toString("utf8"));
  } catch (error) {
    return { failures: [...file.failures, failure("phone-record-malformed", path, `the record is not valid JSON (${error instanceof Error ? error.message : String(error)})`)] };
  }
  if (!isObject(record)) return { failures: [...file.failures, failure("phone-record-malformed", path, "the record is not a JSON object")] };
  const judge = record.kind === "measured" ? judgeMeasured : record.kind === "acceptance" ? judgeAcceptance : undefined;
  if (judge === undefined) return { failures: [...file.failures, failure("phone-kind", path, `kind is ${JSON.stringify(record.kind)}, expected "measured" or "acceptance"`)] };
  const judged = judge(record, { path, ...context });
  return { ...judged, failures: [...file.failures, ...judged.failures] };
}

/**
 * The signed form: `phone-timing-statement.txt` with `phone-timing-statement.txt.sig`, verified against the trust anchor
 * (the same invocation as item A's form (b)), and the signed text must name T8 and the first 16 hex characters of B's
 * `main.js` hash. It is a statement, not a measurement.
 */
function judgeSignedStatement(directory, { root, environment, tree, buildFiles }) {
  const statementPath = join(directory, PHONE_TIMING_STATEMENT_FILE);
  const signaturePath = `${statementPath}.sig`;
  const statement = readOperatorFile(statementPath, "phone-record-missing", `no signed statement at ${statementPath}`, PHONE_CODE);
  if (statement.data === undefined) return { failures: statement.failures };
  const signature = readOperatorFile(signaturePath, "phone-signature-missing", `${statementPath} has no signature file ${signaturePath}`, PHONE_CODE);
  const failures = [...statement.failures, ...signature.failures];
  if (signature.data === undefined) return { failures };
  if (statement.data.length > STATEMENT_MAX_BYTES) return { failures: [...failures, failure("phone-statement-mismatch", statementPath, `the statement is larger than ${STATEMENT_MAX_BYTES} bytes`)] };
  const verified = verifyWithTrustAnchor({ root, environment, path: statementPath, data: statement.data, signatureData: signature.data, codePrefix: PHONE_CODE });
  failures.push(...verified.failures);
  const text = statement.data.toString("utf8");
  const main = buildFiles[PLUGIN_MAIN_JS];
  const prefix = main === undefined ? undefined : main.slice(0, BUILD_PREFIX_LENGTH);
  if (!namesToken(text, tree.t8)) failures.push(failure("phone-statement-mismatch", statementPath, `the signed statement does not name the tree (T8 ${tree.t8})`));
  if (prefix === undefined) failures.push(failure("phone-build-mismatch", statementPath, `the build B has no ${PLUGIN_MAIN_JS}`));
  else if (!namesToken(text, prefix)) failures.push(failure("phone-statement-mismatch", statementPath, `the signed statement does not name the plugin build (main.js hash prefix ${prefix})`));
  return { failures, form: "signed", path: statementPath, details: { timingMeasured: false, ...verified.evidence } };
}

/**
 * Item C for the tree `tree` (a successful `computeTreeHash` result) and the build files `buildFiles` (B): a measured
 * record, an acceptance or a signed statement in `<per-user dir>/feature-ops/` (spec "Item C"). Each form that is present
 * is judged on its own and the item passes when one passes and the folder checks (owner, mode 0700 / 0600, no symbolic
 * link) hold; when none passes every present form's failures are returned. Nothing is written. `root` is the repository,
 * needed to refuse a trust directory inside it; `now` is for tests. Returns `{ ok, form, failures, evidence }`;
 * `evidence.timingMeasured` is true only for a measurement, so the release notes list the timing as unverified otherwise.
 * Throws CheckerEnvironmentError when the per-user directory cannot be located or IPFS_SYNC_ALLOWED_SIGNERS is set.
 */
export function checkPhoneTiming({ root, tree, buildFiles, environment = process.env, now = Date.now() }) {
  assertNoSignerOverride(environment);
  const folder = inspectFeatureOps(environment, {
    recordFile: PHONE_TIMING_RECORD_FILE,
    prefix: PHONE_CODE,
    missingDetail: `no phone-timing record at ${join(perUserStateDir(environment), FEATURE_OPS_DIRECTORY, PHONE_TIMING_RECORD_FILE)}; tools/record-phone-timing.mjs writes it`,
  });
  const evidence = { recordPath: folder.recordPath };
  if (!folder.usable) return { ok: false, form: undefined, failures: folder.failures, evidence };
  const statementPath = join(folder.directory, PHONE_TIMING_STATEMENT_FILE);
  const judged = [];
  if (lstatSyncOrNull(folder.recordPath) !== null) judged.push(judgeTimingRecord(folder.recordPath, { tree, buildFiles, now }));
  if (lstatSyncOrNull(statementPath) !== null) judged.push(judgeSignedStatement(folder.directory, { root, environment, tree, buildFiles }));
  if (judged.length === 0) {
    const detail = `no phone-timing record at ${folder.recordPath} and no signed statement at ${statementPath}; tools/record-phone-timing.mjs writes the record`;
    return { ok: false, form: undefined, failures: [...folder.failures, failure("phone-record-missing", folder.recordPath, detail)], evidence };
  }
  const passing = judged.find((entry) => entry.failures.length === 0);
  if (passing === undefined) return { ok: false, form: undefined, failures: [...folder.failures, ...judged.flatMap((entry) => entry.failures)], evidence };
  const passedEvidence = { ...evidence, ...(passing.path === undefined ? {} : { recordPath: passing.path }), ...passing.details };
  return { ok: folder.failures.length === 0, form: folder.failures.length === 0 ? passing.form : undefined, failures: folder.failures, evidence: passedEvidence };
}

/* ---------- item D: distribution bundles and hooks ---------- */

/**
 * The documented allowlist entry of tools/hook-isolation.mjs (task 4.2, R5-11) that lets the operator-run scripts
 * `tools/feature-op-*.mjs` import the raw test hooks. Item D requires it to be present and to admit that one flat name
 * pattern and no other tool: the probes below are the paths it must admit and must refuse.
 */
const FEATURE_OP_ALLOWLIST_ENTRY = "tools/feature-op-*.mjs";
const ALLOWLIST_ADMITTED_PROBE = "tools/feature-op-mvp-07.mjs";
const ALLOWLIST_REFUSED_PROBES = Object.freeze([
  "tools/check-guard-preconditions.mjs",
  "tools/record-phone-timing.mjs",
  "tools/release-mvp-07.mjs",
  "tools/feature-op-mvp-07/helper.mjs",
  "src/main.ts",
]);

/**
 * Item D (spec "Item D"). `distScan` is what the export's own `loadSentinels` and `checkDistBundles` reported for the second
 * build (see CHECK_DIST_SCRIPT): `{ sentinels }` (the testing modules, each with exactly one sentinel) or `{ sentinelError }`
 * (a testing module without a sentinel, or with a shared one), and `dist` `{ ok, checked, missing, violations }` when the
 * sentinels loaded. `hookIsolation` is the allowlist surface of tools/hook-isolation.mjs, the checker's own import; it is a
 * parameter so that a test can show the check failing. Returns `{ ok, failures, evidence }`; reads nothing.
 */
export function checkItemD({ distScan, hookIsolation = { TOOL_TESTING_IMPORT_ALLOWLIST, isToolTestingImportAllowed } }) {
  const failures = [];
  const bad = (code, path, detail) => void failures.push(failure(code, path, detail));
  const dist = distScan.dist;
  if (typeof distScan.sentinelError === "string") {
    bad("sentinel-missing", undefined, `a test-only module does not carry exactly one sentinel, so the bundles cannot be scanned: ${distScan.sentinelError}`);
  } else if (!isObject(dist) || !Array.isArray(dist.violations) || !Array.isArray(dist.missing)) {
    bad("dist-check-failed", undefined, "the bundle scan returned no result");
  } else {
    for (const violation of dist.violations) bad("dist-bundle-violation", undefined, String(violation));
    for (const missing of dist.missing) bad("dist-bundle-missing", String(missing), `${missing} was not produced, so it was not scanned`);
  }
  const entries = Array.isArray(hookIsolation.TOOL_TESTING_IMPORT_ALLOWLIST) ? [...hookIsolation.TOOL_TESTING_IMPORT_ALLOWLIST] : [];
  const admitsOnlyFeatureOps =
    entries.includes(FEATURE_OP_ALLOWLIST_ENTRY) &&
    hookIsolation.isToolTestingImportAllowed(ALLOWLIST_ADMITTED_PROBE) === true &&
    ALLOWLIST_REFUSED_PROBES.every((probe) => hookIsolation.isToolTestingImportAllowed(probe) === false);
  if (!admitsOnlyFeatureOps) {
    bad("allowlist-entry-missing", "tools/hook-isolation.mjs", `the documented allowlist entry ${FEATURE_OP_ALLOWLIST_ENTRY} is missing from tools/hook-isolation.mjs, or it admits more than the feature-op scripts`);
  }
  return {
    ok: failures.length === 0,
    failures,
    evidence: { bundlesChecked: isObject(dist) && Array.isArray(dist.checked) ? [...dist.checked] : [], sentinelModules: Array.isArray(distScan.sentinels) ? distScan.sentinels.length : 0, allowlist: entries },
  };
}

/* ---------- item E: the checklist held in the checker ---------- */

/**
 * The checklist test files and the fewest tests each must run (spec "Item E": mass-removal guard, prune-history, the
 * single-read upload source, history-name order, the permissive guard modules, the plaintext-removal refusals, rewrap and
 * accept, the maintenance-journal cross-tests). They are held here and not read from the record, so a record cannot
 * shorten the list. Minimums are the count of top-level `it(` and `test(` calls in each file on 2026-10-04 less about ten
 * percent, so a counting difference between that grep and the runner does not fail a release, while a file emptied of most of its tests does.
 * `guard-permissive.test.ts` is written on the release branch (task 6.2) and does not exist on `main`; its minimum is an
 * estimate (the task text lists four behaviours), and item E fails until the file exists. `path-fold.test.ts` is left out on
 * purpose: it holds a `skipIf` test, which this item does not allow.
 */
export const CHECKLIST_TESTS = Object.freeze(
  [
    // mass-removal guard
    ["tests/unit/removal-guard.test.ts", 8],
    ["tests/unit/publish-mass-removal.test.ts", 10],
    ["tests/unit/cli-publish-mass-removal.test.ts", 3],
    // prune-history
    ["tests/unit/prune-history.test.ts", 25],
    ["tests/unit/prune-history-plan.test.ts", 9],
    ["tests/unit/cli-prune-history.test.ts", 13],
    // single-read upload source
    ["tests/unit/encrypted-transfer.test.ts", 16],
    // history-name order
    ["tests/unit/history-names.test.ts", 7],
    // the permissive guard modules (release branch only)
    ["tests/unit/guard-permissive.test.ts", 4],
    // plaintext-removal refusals
    ["tests/unit/plaintext-removal.test.ts", 5],
    // rewrap and accept
    ["tests/unit/crypto-key-slots-rewrap.test.ts", 13],
    ["tests/unit/key-management.test.ts", 32],
    ["tests/unit/key-accept.test.ts", 28],
    ["tests/unit/slot-acceptance.test.ts", 14],
    ["tests/unit/cli-keys-accept.test.ts", 16],
    // the maintenance-journal cross-tests
    ["tests/unit/maintenance-journal.test.ts", 14],
    ["tests/unit/maintenance-node.test.ts", 5],
  ].map(([path, min]) => Object.freeze({ path, min })),
);

/**
 * The limit sentences README and DESIGN section 8 must contain (spec "Item E" and "Attestations, not proofs"). They are exact
 * strings; the documentation compares after whitespace is collapsed, so a hard-wrapped line does not hide a sentence, and
 * nothing else is normalised. The documentation task (5.1) writes these sentences verbatim.
 */
export const LIMIT_SENTENCES = Object.freeze(
  [
    ["silent-corruption", "Silent per-file corruption of unchanged files by someone who can write to the node is not detected by the publisher."],
    ["concurrent-publish", "Concurrent publishes are narrowed, not prevented"],
    ["attestations", "The review record, the operator-run record and the phone-timing record are attestations, not proofs."],
    ["defect-loop", "A change to any scoped file after the review record or after the operator run changes the tree hash, and both must be redone."],
    ["floor-limits", "The sequence floor does not stop a node from showing an old copy to a device that has no recorded state."],
    ["rewrap-no-revoke", "Rewrap does not revoke the old passphrase or any old copy of the key slot."],
  ].map(([id, text]) => Object.freeze({ id, text })),
);

/** The documentation outside T whose hashes go into the evidence (it is not hashed by T, so the release evidence carries them). */
export const DOCUMENT_FILES = Object.freeze(["README.md", "CHANGELOG.md", "DESIGN.md", "docs/operator/encrypted-vault.md"]);

const TESTS_TIMEOUT_MS = 60 * 60_000;
const AUDIT_TIMEOUT_MS = 5 * 60_000;
const REPORT_FILE = "checklist-report.json";

const collapseWhitespace = (text) => text.replace(/\s+/g, " ").trim();
const posixRelative = (from, to) => relative(from, to).split(sep).join("/");

/**
 * Runs inside the clean export, while it and its install still exist (called by `buildCleanExport`): the sha256 of each
 * checklist file as the export holds it (null when absent or not a plain file), the checklist test run (unless `skipTests`)
 * with the JSON report in a temporary file beside the export, and `pnpm audit --prod --json`. Nothing is judged here.
 */
function runExportChecks({ exportDir, workDir, env, tool }, { skipTests }) {
  const hashes = {};
  for (const { path } of CHECKLIST_TESTS) {
    const stats = lstatSyncOrNull(join(exportDir, ...path.split("/")));
    hashes[path] = stats !== null && stats.isFile() ? createHash("sha256").update(readFileSync(join(exportDir, ...path.split("/")))).digest("hex") : null;
  }
  let tests = { skipped: true };
  if (!skipTests) {
    const reportFile = join(workDir, REPORT_FILE);
    const run = runCommand([...tool.tests, "run", ...CHECKLIST_TESTS.map((entry) => entry.path), "--reporter=json", `--outputFile=${reportFile}`], {
      cwd: exportDir,
      env,
      timeout: TESTS_TIMEOUT_MS,
    });
    tests = { skipped: false, status: run.status, output: run.output, report: lstatSyncOrNull(reportFile) === null ? undefined : readFileSync(reportFile, "utf8") };
  }
  const audit = runCommand(tool.audit, { cwd: exportDir, env, timeout: AUDIT_TIMEOUT_MS });
  return { exportDir, hashes, tests, audit: { status: audit.status, stdout: audit.stdout, output: audit.output } };
}

/** The first thing wrong with the shape of a vitest JSON report, or undefined. */
function reportShapeProblem(report) {
  if (!isObject(report) || !Array.isArray(report.testResults)) return "the report has no testResults list";
  if (!Number.isFinite(report.numTodoTests) || !Number.isFinite(report.numPendingTests)) return "the report has no numTodoTests and numPendingTests counts";
  const filesOk = report.testResults.every(
    (file) => isObject(file) && typeof file.name === "string" && Array.isArray(file.assertionResults) && file.assertionResults.every((entry) => isObject(entry) && typeof entry.status === "string"),
  );
  return filesOk ? undefined : "a testResults entry has no file name or no assertionResults list of statuses";
}

/**
 * Judges the checklist test run (spec "Item E", design 9). `tests` is the run (`{ skipped }` or `{ status, output, report }`),
 * `hashes` the sha256 of each checklist file in the export (null: no such file), `record` the review record
 * (undefined when item A could not read one) and `exportDir` the directory the report's absolute file names are relative to.
 * Every named file must be in the report with at least its minimum of passing tests, every assertion must have passed, the
 * report must count no todo and no pending tests, the runner must have exited 0, and each file's sha256 must equal the
 * record's `checklistTests` entry. Returns `{ failures, files }`; `files` lists `{ path, min, passed, total }` for each named file that ran.
 */
export function judgeChecklistRun({ tests, hashes, record, exportDir }) {
  const failures = [];
  const files = [];
  const bad = (code, path, detail) => void failures.push(failure(code, path, detail));
  let byPath;
  let report;
  if (tests.skipped === true) {
    bad("tests-skipped", undefined, "the checklist tests were not run (--no-tests); a run without the tests is never a pass");
  } else {
    if (tests.status !== 0) bad("tests-run-failed", undefined, `the test runner exited with ${tests.status === null ? "no status" : tests.status}: ${tail(tests.output ?? "")}`);
    if (typeof tests.report !== "string" || tests.report === "") {
      bad("tests-no-report", undefined, `the test runner wrote no JSON report: ${tail(tests.output ?? "")}`);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(tests.report);
      } catch (error) {
        bad("tests-report-malformed", undefined, `the report is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      }
      const problem = parsed === undefined ? undefined : reportShapeProblem(parsed);
      if (problem !== undefined) bad("tests-report-malformed", undefined, problem);
      else if (parsed !== undefined) report = parsed;
    }
  }
  if (report !== undefined) {
    byPath = new Map();
    for (const file of report.testResults) {
      const path = isAbsolute(file.name) ? posixRelative(exportDir, file.name) : file.name;
      byPath.set(path, file);
      const notPassed = file.assertionResults.filter((entry) => entry.status !== "passed");
      if (notPassed.length > 0 || (file.status === "failed" && file.assertionResults.length === 0)) {
        const kinds = [...new Set(notPassed.map((entry) => entry.status))].join(", ");
        bad("tests-not-passed", path, `${path}: ${notPassed.length} of ${file.assertionResults.length} assertions did not pass${kinds === "" ? " (the file did not load)" : ` (${kinds})`}`);
      }
    }
  }
  for (const { path, min } of CHECKLIST_TESTS) {
    const hash = hashes[path];
    if (typeof hash !== "string") {
      bad("checklist-file-missing", path, `${path} is not a file in the clean export, so it cannot be the named checklist test`);
      continue;
    }
    if (byPath !== undefined) {
      const file = byPath.get(path);
      if (file === undefined) bad("checklist-file-not-run", path, `${path} is not in the test report, so the runner did not run it`);
      else {
        const passed = file.assertionResults.filter((entry) => entry.status === "passed").length;
        files.push({ path, min, passed, total: file.assertionResults.length });
        if (passed < min) bad("checklist-too-few", path, `${path} ran ${passed} passing tests, the checklist requires at least ${min}`);
      }
    }
    if (record !== undefined) {
      const recorded = record.checklistTests[path];
      if (typeof recorded !== "string") bad("checklist-record-missing-path", path, `the review record's checklistTests does not name ${path}, which the checker requires`);
      else if (recorded !== hash) bad("checklist-hash-mismatch", path, `${path} has sha256 ${hash} in the export, the review record says ${recorded}`);
    }
  }
  if (record === undefined) bad("checklist-record-unavailable", undefined, "no readable review record, so the checklist file hashes cannot be compared (item A reports the record)");
  if (report !== undefined && (report.numTodoTests !== 0 || report.numPendingTests !== 0)) {
    bad("tests-todo-or-pending", undefined, `the report counts ${report.numTodoTests} todo and ${report.numPendingTests} pending (skipped) tests; both must be zero`);
  }
  return { failures, files };
}

/** Every identifier an audit entry can be named by, lower case: the GHSA id, the numeric id, the URL and its last segment, the CVEs. */
function advisoryIdentifiers(advisory) {
  const ids = new Set();
  const add = (value) => {
    if ((typeof value === "string" && value.trim() !== "") || Number.isSafeInteger(value)) ids.add(String(value).trim().toLowerCase());
  };
  if (!isObject(advisory)) return ids;
  add(advisory.github_advisory_id);
  add(advisory.id);
  add(advisory.url);
  if (typeof advisory.url === "string") add(advisory.url.split("/").filter(Boolean).at(-1));
  if (Array.isArray(advisory.cves)) advisory.cves.forEach(add);
  return ids;
}

const describeAdvisory = (advisory) => {
  if (!isObject(advisory)) return "an advisory";
  const name = advisory.github_advisory_id ?? advisory.url ?? advisory.id ?? "unnamed";
  return `${name}${typeof advisory.module_name === "string" ? ` in ${advisory.module_name}` : ""}${typeof advisory.severity === "string" ? ` (${advisory.severity})` : ""}`;
};

/**
 * Judges `pnpm audit --prod --json` against the review record's findings (spec "Item E"; evaluated at check time and not
 * bound to T). The output must be an audit document (an object with an `advisories` object): anything else, an error
 * document included, is `audit-unavailable` and fails, so an unreachable registry never passes. Every advisory must match a
 * finding with status `accepted` that names it in `advisory` and carries a valid `acceptedAt` that is not in the future.
 * The exit status is not used: pnpm exits non-zero when it finds advisories. Returns `{ failures, advisories }`.
 */
export function judgeAudit({ audit, findings, now }) {
  let document;
  try {
    document = JSON.parse(audit.stdout);
  } catch {
    document = undefined;
  }
  if (!isObject(document) || document.error !== undefined || !isObject(document.advisories)) {
    return { failures: [failure("audit-unavailable", undefined, `pnpm audit returned no audit document (exit ${audit.status ?? "none"}); the registry may be unreachable: ${tail(audit.output ?? audit.stdout ?? "")}`)], advisories: 0 };
  }
  const accepted = findings.filter((item) => item.status === "accepted" && typeof item.advisory === "string" && item.advisory.trim() !== "");
  const failures = [];
  const advisories = Object.values(document.advisories);
  for (const advisory of advisories) {
    const ids = advisoryIdentifiers(advisory);
    const matching = accepted.filter((item) => ids.has(item.advisory.trim().toLowerCase()));
    const isDated = (item) => {
      const time = typeof item.acceptedAt === "string" ? Date.parse(item.acceptedAt) : Number.NaN;
      return !Number.isNaN(time) && time <= now + OPERATOR_CLOCK_SKEW_MS;
    };
    if (matching.length === 0) failures.push(failure("audit-unaccepted", undefined, `the audit reports ${describeAdvisory(advisory)}, which no accepted finding of the review record names`));
    else if (!matching.some(isDated)) failures.push(failure("audit-acceptance-undated", undefined, `${describeAdvisory(advisory)} is accepted in the review record without a valid acceptedAt date`));
  }
  return { failures, advisories: advisories.length };
}

/** The text of DESIGN section 8 (from its `## 8.` heading to the next `## ` heading), whitespace collapsed; undefined when there is none. */
function designSectionEight(design) {
  const heading = /^## 8\.[^\n]*$/m.exec(design);
  if (heading === null) return undefined;
  const start = heading.index + heading[0].length;
  const next = /^## /m.exec(design.slice(start));
  return collapseWhitespace(design.slice(start, next === null ? design.length : start + next.index));
}

/** Every `LIMIT_SENTENCES` entry must be in README and in DESIGN section 8 (whitespace collapsed on both sides). Returns `{ failures }`. */
export function checkLimitSentences({ readme, design }) {
  const failures = [];
  const readmeText = collapseWhitespace(readme);
  const section = designSectionEight(design);
  if (section === undefined) failures.push(failure("design-section-8-missing", "DESIGN.md", "DESIGN.md has no section 8 (a heading starting with '## 8.')"));
  for (const { id, text } of LIMIT_SENTENCES) {
    const needle = collapseWhitespace(text);
    if (!readmeText.includes(needle)) failures.push(failure("limit-sentence-missing", "README.md", `README.md lacks the required limit sentence ${id}: "${text}"`));
    if (section !== undefined && !section.includes(needle)) failures.push(failure("limit-sentence-missing", "DESIGN.md section 8", `DESIGN.md section 8 lacks the required limit sentence ${id}: "${text}"`));
  }
  return { failures };
}

/** The documentation as committed at `tree.commit`: hashes for the evidence, and the sentence check. Returns `{ failures, hashes }`. */
function checkDocuments(root, tree) {
  const failures = [];
  const hashes = {};
  const texts = {};
  for (const path of DOCUMENT_FILES) {
    const found = blobAt(root, tree.commit, path);
    if (found === undefined || found.irregular) failures.push(failure("doc-missing", path, `${path} is not a file in the commit; the evidence records its hash`));
    else {
      hashes[path] = createHash("sha256").update(found.data).digest("hex");
      texts[path] = found.data.toString("utf8");
    }
  }
  if (texts["README.md"] !== undefined && texts["DESIGN.md"] !== undefined) failures.push(...checkLimitSentences({ readme: texts["README.md"], design: texts["DESIGN.md"] }).failures);
  return { failures, hashes };
}

/** The review record of the tree for item E (it needs `checklistTests` and `findings`); item A reports a record that is missing or malformed. */
function readRecordForChecklist(root, tree) {
  const found = blobAt(root, tree.commit, reviewRecordPath(tree.t8));
  if (found === undefined || found.irregular) return undefined;
  const parsed = parseReviewRecord(found.data.toString("utf8"));
  return parsed.ok ? parsed.record : undefined;
}

/**
 * Item E for the tree `tree` (a successful `computeTreeHash` result) and the checks `exportChecks` that ran in the clean
 * export (`runExportChecks`): the checklist tests, the audit, the limit sentences and the documentation hashes. The record,
 * the README, DESIGN and the other documents are read from the objects of `tree.commit`, never from the working tree. `now`
 * is for tests. Returns `{ ok, failures, evidence }`.
 */
export function checkItemE({ root, tree, exportChecks, now = Date.now() }) {
  const record = readRecordForChecklist(root, tree);
  const tests = judgeChecklistRun({ tests: exportChecks.tests, hashes: exportChecks.hashes, record, exportDir: exportChecks.exportDir });
  const audit = judgeAudit({ audit: exportChecks.audit, findings: record === undefined ? [] : record.findings, now });
  const documents = checkDocuments(root, tree);
  const failures = [...tests.failures, ...audit.failures, ...documents.failures];
  return {
    ok: failures.length === 0,
    failures,
    evidence: { testsRun: exportChecks.tests.skipped !== true, tests: tests.files, documents: documents.hashes, advisories: audit.advisories },
  };
}

/* ---------- enrolment of the review signer ---------- */

const ENROL_NONCE_BYTES = 6;
export const randomNonce = () => randomBytes(ENROL_NONCE_BYTES).toString("hex");
/**
 * C0 and C1 controls except tab and newline, the line and paragraph separators, and the bidi overrides and isolates.
 * Built from code points so that no invisible character sits in this source file.
 */
export const UNSAFE_TEXT = new RegExp(
  `[${[[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
    .map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`)
    .join("")}]`,
  "g",
);
/** Stops control characters of file or terminal content from reaching the operator's terminal (newline and tab stay). */
export const plain = (text) => String(text).replace(UNSAFE_TEXT, "?");

export class InputEnded extends Error {}

/**
 * Line input over a terminal's input stream (the shape of `process.stdin`; tests inject `tests/helpers/fake-terminal.ts`).
 * Cooked mode: the terminal echoes and edits, this only collects lines. `next()` resumes the stream when it has to wait;
 * `close()` removes the listeners and pauses the stream.
 */
export function createLineReader(input) {
  const lines = [];
  let buffered = "";
  let ended = false;
  let waiting;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const deliver = (line) => {
    if (waiting === undefined) lines.push(line);
    else {
      const { resolve } = waiting;
      waiting = undefined;
      resolve(line);
    }
  };
  const onData = (chunk) => {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (let match = /\r\n|\n|\r/.exec(buffered); match !== null; match = /\r\n|\n|\r/.exec(buffered)) {
      const line = buffered.slice(0, match.index);
      buffered = buffered.slice(match.index + match[0].length);
      deliver(line);
    }
  };
  const onEnd = () => {
    ended = true;
    if (waiting !== undefined) {
      const { reject } = waiting;
      waiting = undefined;
      reject(new InputEnded("the terminal input ended"));
    }
  };
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  input.on("error", onEnd);
  return {
    next: () => {
      if (lines.length > 0) return Promise.resolve(lines.shift());
      if (ended) return Promise.reject(new InputEnded("the terminal input ended"));
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        input.resume();
      });
    },
    close: () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      input.removeListener("error", onEnd);
      input.pause();
    },
  };
}

const atomicWrite = (target, text) => {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: "w" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
};

/** The public key line in `keyFile`, after the checks that keep a planted or private key out. Throws CheckerEnvironmentError. */
function readPublicKeyFile(keyFile, root) {
  const resolved = realpathSync(keyFile);
  const stats = lstatSyncOrNull(resolved);
  if (stats === null || !stats.isFile()) throw new CheckerEnvironmentError(`${keyFile} is not a regular file`);
  if (stats.size > PUBLIC_KEY_MAX_BYTES) throw new CheckerEnvironmentError(`${keyFile} is larger than ${PUBLIC_KEY_MAX_BYTES} bytes, so it is not a public key file`);
  if (isInside(realpathSync(root), resolved)) throw new CheckerEnvironmentError(`${keyFile} is inside the repository; a key that lives in the repository is not an operator-owned key`);
  const text = readFileSync(resolved, "utf8");
  if (text.includes("PRIVATE KEY")) throw new CheckerEnvironmentError(`${keyFile} holds a private key; give the public key file (.pub)`);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) throw new CheckerEnvironmentError(`${keyFile} must hold exactly one public key line, it holds ${lines.length}`);
  const { type, body } = parsePublicKeyLine(lines[0]);
  return { type, body, fingerprint: sshKeyFingerprint(lines[0]) };
}

/** The fingerprint already enrolled, or undefined (best effort: it is only shown to the operator). */
function enrolledFingerprint(trustDirectory) {
  try {
    const parsed = JSON.parse(readFileSync(join(trustDirectory, SIGNER_RECORD_FILE), "utf8"));
    return isObject(parsed) && typeof parsed.fingerprint === "string" ? plain(parsed.fingerprint) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `--enrol-signer <public key file>` (design 9, Q-14). Needs a terminal on both streams, else exit 2 before anything is
 * read. Prints the key's fingerprint and a nonce, and writes `<per-user dir>/trust/allowed-signers` and
 * `review-signer.json` (0600, in a 0700 directory) only after the operator retypes both. Returns the exit code: 0
 * enrolled, 1 the operator did not retype correctly or the input ended, 2 usage or environment (no terminal, a key
 * inside the repository, a trust directory inside it, a signer override variable, a bad key file).
 */
export async function enrolSigner({ keyFile, root, out, err, environment = process.env, terminal, nonce = randomNonce }) {
  let reader;
  try {
    assertNoSignerOverride(environment);
    if (terminal === undefined || terminal.input.isTTY !== true || terminal.output.isTTY !== true) {
      throw new CheckerEnvironmentError("enrolment needs a terminal on standard input and standard output; nothing was written");
    }
    const key = readPublicKeyFile(keyFile, root);
    const stateDirectory = perUserStateDir(environment);
    const trustDirectory = join(stateDirectory, TRUST_DIRECTORY_NAME);
    if (isInside(realpathSync(root), resolveThroughMissing(trustDirectory))) {
      throw new CheckerEnvironmentError(`the trust directory ${trustDirectory} would be inside the repository; the trust anchor must live outside it`);
    }
    const existing = lstatSyncOrNull(trustDirectory);
    if (existing !== null) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new CheckerEnvironmentError(`${trustDirectory} is not a plain directory`);
      const problems = ownerAndModeProblems(existing, 0o700, trustDirectory);
      if (problems.length > 0) throw new CheckerEnvironmentError(problems.map((item) => item.detail).join("; "));
    }
    const previous = existing === null ? undefined : enrolledFingerprint(trustDirectory);
    const expectedNonce = nonce();
    const say = (text) => void terminal.output.write(text);
    say(`Enrolling the review signer for item A (signature form).\nkey fingerprint: ${key.fingerprint}\nkey type: ${key.type}\n`);
    if (previous !== undefined) say(`enrolling this key replaces ${previous}\n`);
    say(`nonce: ${expectedNonce}\nCompare the fingerprint with the key you hold elsewhere before you retype it.\n`);
    reader = createLineReader(terminal.input);
    say("Retype the fingerprint: ");
    if ((await reader.next()).trim() !== key.fingerprint) {
      err("the retyped fingerprint does not match; nothing was written\n");
      return 1;
    }
    say("Retype the nonce: ");
    if ((await reader.next()).trim() !== expectedNonce) {
      err("the retyped nonce does not match; nothing was written\n");
      return 1;
    }
    const stateExisted = lstatSyncOrNull(stateDirectory) !== null;
    mkdirSync(trustDirectory, { recursive: true, mode: 0o700 });
    if (!stateExisted) chmodSync(stateDirectory, 0o700);
    chmodSync(trustDirectory, 0o700);
    // allowed-signers first: a crash between the two files leaves a fingerprint mismatch, which fails closed.
    atomicWrite(join(trustDirectory, ALLOWED_SIGNERS_FILE), `${REVIEW_PRINCIPAL} namespaces="${REVIEW_NAMESPACE}" ${key.type} ${key.body}\n`);
    atomicWrite(join(trustDirectory, SIGNER_RECORD_FILE), `${JSON.stringify({ schema: 1, fingerprint: key.fingerprint })}\n`);
    out(`enrolled ${key.fingerprint} in ${trustDirectory}\n`);
    return 0;
  } catch (error) {
    if (error instanceof InputEnded) {
      err("the terminal input ended before the retyping was complete; nothing was written\n");
      return 1;
    }
    err(`checker error: ${plain(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  } finally {
    reader?.close();
  }
}

/* ---------- command line ---------- */

const USAGE =
  "usage: node tools/check-guard-preconditions.mjs [--json] [--no-tests]   (--no-tests never passes: item E fails)\n" +
  "       node tools/check-guard-preconditions.mjs --build\n" +
  "       node tools/check-guard-preconditions.mjs --print-tree-hash [--list]\n" +
  "       node tools/check-guard-preconditions.mjs --enrol-signer <public key file>   (terminal only)\n";
const OPTION_SETS = [[], ["--build"], ["--json"], ["--no-tests"], ["--json", "--no-tests"], ["--print-tree-hash"], ["--list", "--print-tree-hash"]];

const printFailures = (err, failures) => {
  for (const item of failures) err(`FAIL ${item.code}: ${plain(item.detail)}\n`);
};

const treeLines = (tree) => `tree-sha256: ${tree.treeSha256}\ntree-t8: ${tree.t8}\ntree-files: ${tree.fileCount}\ncommit: ${tree.commit}\n`;

const buildLines = (built) =>
  `build-sha256: ${built.buildSha256}\n${hashBuildLines(built.files).lines.map((line) => `build-file: ${line}`).join("")}node: ${built.versions.node}\npnpm: ${built.versions.pnpm}\n`;

/**
 * T, then B of the same commit, then T again (HEAD, the index or the working tree moving during the build fails the run).
 * With `exportChecks` the export is kept alive for the checklist tests and the audit of item E (`skipTests` leaves the test run out).
 */
function checkTreeAndBuild(root, context, { exportChecks = false, skipTests = false } = {}) {
  const tree = computeTreeHash({ root });
  if (!tree.ok) return { failures: tree.failures };
  const built = buildCleanExport({
    root,
    commit: chooseBuildCommit(root, tree),
    commands: context.commands,
    environment: context.environment,
    tmpRoot: context.tmpRoot,
    ...(exportChecks ? { inExport: (inside) => runExportChecks(inside, { skipTests }) } : {}),
  });
  if (!built.ok) return { failures: built.failures };
  const after = computeTreeHash({ root });
  if (!after.ok || after.commit !== tree.commit || after.treeSha256 !== tree.treeSha256) {
    return { failures: [failure("tree-changed-during-build", undefined, "HEAD, the index or the working tree changed while the build ran, so B does not describe the tree that T was computed for")] };
  }
  return { tree, built };
}

/** The lines item A adds to the human output: the verdict, the evidence form, E and its count or the signer, accepted findings, unread files. */
function itemALines(item) {
  const lines = [`item-a: ${item.ok ? "pass" : "fail"}\n`];
  if (item.form !== undefined) lines.push(`item-a-form: ${item.form}\n`);
  lines.push(`item-a-record: ${plain(item.evidence.recordPath)}\n`);
  if (item.evidence.commit !== undefined) lines.push(`item-a-commit: ${item.evidence.commit}\nitem-a-commit-count: ${item.evidence.commitCount}\n`);
  if (item.evidence.signerFingerprint !== undefined) lines.push(`item-a-signer: ${item.evidence.signerFingerprint}\n`);
  for (const finding of item.accepted) lines.push(`item-a-accepted: ${plain(finding.id)} (${finding.severity}) ${plain(finding.because)}\n`);
  for (const path of item.unread) lines.push(`item-a-unread: ${plain(path)}\n`);
  lines.push(`item-a-unread-count: ${item.unread.length}\n`);
  return lines.join("");
}

/** The lines item B adds to the human output: the verdict, the record, the finish time and how many required assertions were satisfied. */
function itemBLines(operator) {
  const lines = [`item-b: ${operator.ok ? "pass" : "fail"}\n`, `item-b-record: ${plain(operator.evidence.recordPath)}\n`];
  if (operator.evidence.finishedAt !== undefined) lines.push(`item-b-finished-at: ${plain(operator.evidence.finishedAt)}\n`);
  if (operator.evidence.assertionCount !== undefined) lines.push(`item-b-assertions: ${operator.evidence.assertionCount}\n`);
  return lines.join("");
}

/**
 * The lines item C adds to the human output: the verdict, the form, the record, whether the timing was measured, and for a
 * measurement the device, OS, seconds and longest gap (an acceptance or a signed statement prints "unverified").
 */
function itemCLines(phone) {
  const lines = [`item-c: ${phone.ok ? "pass" : "fail"}\n`];
  if (phone.form !== undefined) lines.push(`item-c-form: ${phone.form}\n`);
  lines.push(`item-c-record: ${plain(phone.evidence.recordPath)}\n`);
  if (phone.ok) lines.push(`item-c-timing: ${phone.evidence.timingMeasured ? "measured" : "unverified"}\n`);
  if (phone.ok && phone.evidence.timingMeasured) {
    lines.push(`item-c-device: ${plain(phone.evidence.device)}\nitem-c-os: ${plain(phone.evidence.os)}\n`);
    lines.push(`item-c-seconds: ${phone.evidence.seconds}\nitem-c-longest-gap-ms: ${phone.evidence.longestGapMs}\n`);
  }
  if (phone.ok && phone.evidence.finishedAt !== undefined) lines.push(`item-c-finished-at: ${plain(phone.evidence.finishedAt)}\n`);
  if (phone.evidence.signerFingerprint !== undefined) lines.push(`item-c-signer: ${phone.evidence.signerFingerprint}\n`);
  return lines.join("");
}

/** The lines item D adds to the human output: the verdict, the bundles scanned, the testing modules and the allowlist entry. */
function itemDLines(itemD) {
  const lines = [`item-d: ${itemD.ok ? "pass" : "fail"}\n`];
  lines.push(`item-d-bundles: ${itemD.evidence.bundlesChecked.map(plain).join(", ")}\n`);
  lines.push(`item-d-sentinel-modules: ${itemD.evidence.sentinelModules}\nitem-d-allowlist: ${itemD.evidence.allowlist.map(plain).join(", ")}\n`);
  return lines.join("");
}

/** The lines item E adds to the human output: the verdict, each checklist file's count, the documentation hashes and the audit. */
function itemELines(itemE) {
  const lines = [`item-e: ${itemE.ok ? "pass" : "fail"}\n`, `item-e-tests: ${itemE.evidence.testsRun ? "run" : "not run (--no-tests)"}\n`];
  for (const file of itemE.evidence.tests) lines.push(`item-e-test-file: ${plain(file.path)} ${file.passed}/${file.min}\n`);
  for (const [path, sha256] of Object.entries(itemE.evidence.documents)) lines.push(`item-e-document: ${plain(path)} ${sha256}\n`);
  lines.push(`item-e-audit-advisories: ${itemE.evidence.advisories}\n`);
  return lines.join("");
}

/** The `--json` document: `pass` is true only when T, B and every item passed; the release tool reads `pass` and `items`. */
function jsonReport({ tree, built, item, operator, phone, itemD, itemE }) {
  const pass = item.ok && operator.ok && phone.ok && itemD.ok && itemE.ok;
  return `${JSON.stringify(
    {
      schema: 1,
      pass,
      complete: true,
      tree: { sha256: tree.treeSha256, t8: tree.t8, fileCount: tree.fileCount, commit: tree.commit },
      build: { sha256: built.buildSha256, commit: built.commit, files: built.files, node: built.versions.node, pnpm: built.versions.pnpm, notices: built.notices },
      items: {
        A: { status: item.ok ? "pass" : "fail", form: item.form ?? null, evidence: item.evidence, failures: item.failures, accepted: item.accepted, unread: item.unread },
        B: { status: operator.ok ? "pass" : "fail", evidence: operator.evidence, failures: operator.failures },
        C: { status: phone.ok ? "pass" : "fail", form: phone.form ?? null, evidence: phone.evidence, failures: phone.failures },
        D: { status: itemD.ok ? "pass" : "fail", evidence: itemD.evidence, failures: itemD.failures },
        E: { status: itemE.ok ? "pass" : "fail", evidence: itemE.evidence, failures: itemE.failures },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Runs the command line against the repository at `root` and returns the exit code (0, 1 or 2). `out` and `err`
 * receive text. Nothing here reads the environment to choose a repository: the root is the caller's argument.
 * `context.commands`, `context.environment`, `context.tmpRoot` and `context.now` are for tests; the process entry point passes none.
 * `--enrol-signer` is asynchronous and lives in `runChecker`.
 */
export function runCli(argv, context) {
  const { root, out, err } = context;
  try {
    const sorted = [...argv].sort();
    if (!OPTION_SETS.some((set) => set.length === sorted.length && set.every((option, index) => option === sorted[index]))) {
      err(`cannot use ${argv.length === 0 ? "no option" : argv.join(" ")}\n${USAGE}`);
      return 2;
    }
    const environment = context.environment ?? process.env;
    assertNoSignerOverride(environment);
    if (argv.includes("--print-tree-hash")) {
      const result = computeTreeHash({ root });
      if (!result.ok) {
        printFailures(err, result.failures);
        return 1;
      }
      out(treeLines(result));
      if (argv.includes("--list")) out(`\n${result.lines.join("")}`);
      return 0;
    }
    const building = argv.includes("--build");
    const json = argv.includes("--json");
    if (building) assertDistWritable(root);
    const checked = checkTreeAndBuild(root, context, { exportChecks: !building, skipTests: argv.includes("--no-tests") });
    if (checked.failures) {
      if (json) out(`${JSON.stringify({ schema: 1, pass: false, complete: false, failures: checked.failures }, null, 2)}\n`);
      else printFailures(err, checked.failures);
      return 1;
    }
    const itemD = checkItemD({ distScan: checked.built.distScan });
    if (building) {
      // A bundle that holds a test-only sentinel, or a testing module without one, is never installed.
      if (!itemD.ok) {
        printFailures(err, itemD.failures);
        return 1;
      }
      out(treeLines(checked.tree) + buildLines(checked.built));
      for (const notice of checked.built.notices) out(`note: ${notice}\n`);
      installOutputs(root, checked.built, checked.tree);
      out(`installed dist/plugin/ and dist/cli/ and wrote ${GUARD_BUILD_FILE}\n`);
      return 0;
    }
    const item = checkReviewRecord({ root, tree: checked.tree, buildSha256: checked.built.buildSha256, environment });
    const operator = checkOperatorRecord({ tree: checked.tree, buildFiles: checked.built.files, environment, now: context.now });
    const phone = checkPhoneTiming({ root, tree: checked.tree, buildFiles: checked.built.files, environment, now: context.now });
    const itemE = checkItemE({ root, tree: checked.tree, exportChecks: checked.built.exportChecks, now: context.now });
    const results = [
      ["A", item],
      ["B", operator],
      ["C", phone],
      ["D", itemD],
      ["E", itemE],
    ];
    const failed = results.filter(([, result]) => !result.ok).map(([name]) => name);
    const code = failed.length === 0 ? 0 : 1;
    if (json) {
      out(jsonReport({ tree: checked.tree, built: checked.built, item, operator, phone, itemD, itemE }));
      return code;
    }
    out(treeLines(checked.tree) + buildLines(checked.built));
    for (const notice of checked.built.notices) out(`note: ${notice}\n`);
    out(itemALines(item) + itemBLines(operator) + itemCLines(phone) + itemDLines(itemD) + itemELines(itemE));
    printFailures(err, results.flatMap(([, result]) => result.failures));
    if (code === 0) out("result: pass\n");
    else err(`result: fail (${failed.join(", ")})\n`);
    return code;
  } catch (error) {
    err(`checker error: ${plain(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}

/** `--enrol-signer <public key file>` is the only asynchronous mode; everything else is `runCli`. */
export async function runChecker(argv, context) {
  if (argv[0] !== "--enrol-signer") return runCli(argv, context);
  if (argv.length !== 2 || argv[1].startsWith("-")) {
    context.err(`--enrol-signer takes exactly one public key file\n${USAGE}`);
    return 2;
  }
  return enrolSigner({ keyFile: argv[1], root: context.root, out: context.out, err: context.err, environment: context.environment, terminal: context.terminal, nonce: context.nonce });
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === here) {
  process.exitCode = await runChecker(process.argv.slice(2), {
    root: fileURLToPath(new URL("..", import.meta.url)),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    terminal: { input: process.stdin, output: process.stdout },
  });
}
