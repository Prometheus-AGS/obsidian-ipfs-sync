import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PromptTerminal } from "../../cli/passphrase-prompt";

/**
 * Temporary git repositories for the guard-evidence checker (tools/check-guard-preconditions.mjs, mvp-07b 4.3a and later).
 * Every repository lives in its own mkdtemp directory under the real (symlink-resolved) temp directory, is hermetic
 * (no user or system git config, fixed identity) and is removed by `removeRepos`. Nothing here touches the real repository.
 */
export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const CHECKER_PATH = join(REPO_ROOT, "tools/check-guard-preconditions.mjs");

export type FileContent = string | Uint8Array;

export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly sha256: string;
}

export interface TreeFailure {
  readonly code: string;
  readonly path?: string;
  readonly detail: string;
}

export type TreeResult =
  | {
      readonly ok: true;
      readonly commit: string;
      readonly treeSha256: string;
      readonly t8: string;
      readonly fileCount: number;
      readonly entries: readonly TreeEntry[];
      readonly lines: readonly string[];
    }
  | { readonly ok: false; readonly failures: readonly TreeFailure[] };

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** The part of the checker's export surface that tests use; the module is loaded by URL so no .d.mts is needed. */
export interface CheckerModule {
  readonly TREE_SCOPE: { readonly files: readonly string[]; readonly dirs: readonly string[]; readonly importRoot: string };
  readonly CheckerEnvironmentError: new (message: string) => Error;
  readonly hashTreeLines: (entries: readonly { path: string; mode: string; sha256: string }[]) => { lines: string[]; treeSha256: string };
  readonly computeTreeHash: (options: { root: string }) => TreeResult;
  readonly treeHashAtCommit: (options: { root: string; commit: string }) => TreeResult;
  readonly runCli: (argv: readonly string[], context: { root: string } & CliIo & BuildContext) => number;  readonly runGit: (root: string, args: readonly string[], options?: { input?: string | Uint8Array }) => { status: number; stdout: Buffer; stderr: string };
  readonly GUARD_BUILD_FILE: string;
  readonly BUILD_OUTPUTS: readonly { readonly path: string; readonly required: boolean }[];
  readonly hashBuildLines: (files: Readonly<Record<string, string>>) => { lines: string[]; buildSha256: string };
  readonly nodeSatisfiesEngines: (version: string, range: string) => boolean;
  readonly scrubbedBuildEnvironment: (source: Readonly<Record<string, string | undefined>>) => Record<string, string>;
  readonly buildCleanExport: (options: { root: string; commit: string } & BuildContext) => BuildResult;
  readonly REVIEW_RECORD_DIR: string;
  readonly parseReviewRecord: (text: string) => { ok: true; record: Record<string, unknown> } | { ok: false; detail: string };
  readonly checkReviewRecord: (options: { root: string; tree: Extract<TreeResult, { ok: true }>; buildSha256: string; environment?: Environment }) => ReviewCheckResult;
  readonly perUserStateDir: (env: Environment, platform?: string) => string;
  readonly sshKeyFingerprint: (publicKeyLine: string) => string;
  readonly runChecker: (argv: readonly string[], context: { root: string } & CliIo & BuildContext & EnrolContext) => Promise<number>;
  readonly enrolSigner: (options: { keyFile: string; root: string } & CliIo & EnrolContext) => Promise<number>;
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** What item A reports (tools/check-guard-preconditions.mjs `checkReviewRecord`). */
export interface ReviewCheckResult {
  readonly ok: boolean;
  readonly form?: "git-history" | "signature";
  readonly failures: readonly TreeFailure[];
  readonly evidence: { readonly recordPath: string; readonly commit?: string; readonly commitCount?: number; readonly signerFingerprint?: string };
  readonly accepted: readonly { readonly id: string; readonly severity: string; readonly because: string }[];
  readonly unread: readonly string[];
}

/** The terminal streams and nonce source of the enrolment step; tests inject both. */
export interface EnrolContext {
  readonly environment?: Environment;
  readonly terminal?: PromptTerminal;
  readonly nonce?: () => string;
}

/** The commands and places the clean-export build uses; every field has a production default in the checker. */
export interface BuildCommands {
  readonly node?: string;
  readonly install?: readonly string[];
  readonly build?: readonly string[];
  readonly nodeVersion?: readonly string[];
  readonly pnpmVersion?: readonly string[];
  /** Item E: the test runner's command (the checker appends `run <paths> --reporter=json --outputFile=<file>`). */
  readonly tests?: readonly string[];
  /** Item E: the whole audit command. */
  readonly audit?: readonly string[];
}

export interface BuildContext {
  readonly commands?: BuildCommands;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly tmpRoot?: string;
}

/** What the export's own loadSentinels and checkDistBundles reported (item D judges it). */
export interface DistScan {
  readonly sentinels?: readonly string[];
  readonly sentinelError?: string;
  readonly dist?: { readonly ok: boolean; readonly checked: readonly string[]; readonly missing: readonly string[]; readonly violations: readonly string[] };
}

export type BuildResult =
  | {
      readonly ok: true;
      readonly commit: string;
      readonly buildSha256: string;
      readonly files: Readonly<Record<string, string>>;
      readonly artifacts: ReadonlyMap<string, Buffer>;
      readonly versions: { readonly node: string; readonly pnpm: string };
      readonly notices: readonly string[];
      readonly distScan: DistScan;
    }
  | { readonly ok: false; readonly failures: readonly TreeFailure[] };

export async function loadChecker(): Promise<CheckerModule> {
  return (await import(pathToFileURL(CHECKER_PATH).href)) as CheckerModule;
}

const created: string[] = [];

/** Removes every repository made by this module (the directories are mkdtemp results, nothing else). */
export function removeRepos(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const GIT_TEST_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/** Runs git in `cwd` with a hermetic environment; returns stdout as text. Throws on a non-zero exit. */
export function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: GIT_TEST_ENV,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function writeRepoFile(root: string, path: string, content: FileContent, mode?: number): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (mode !== undefined) chmodSync(full, mode);
}

export function tempDir(prefix = "guard-repo-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** `git init`, write `files`, `git add -A`, commit. Returns the repository root. */
export function createRepo(files: Readonly<Record<string, FileContent>>, options: { message?: string } = {}): string {
  const root = tempDir();
  git(root, ["init", "-q", "-b", "main"]);
  for (const [path, content] of Object.entries(files)) writeRepoFile(root, path, content);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", options.message ?? "initial"]);
  return root;
}

/** Stages everything and commits it. Returns the new HEAD. */
export function commitAll(root: string, message = "change"): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

export function head(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

export function failureCodes(result: TreeResult | BuildResult): string[] {
  return result.ok ? [] : result.failures.map((failure) => failure.code);
}

/** Collects what a runCli call writes. */
export function captureIo(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: { out: (text) => void (out += text), err: (text) => void (err += text) },
    out: () => out,
    err: () => err,
  };
}

/* ---------- clean-export build fixture (task 4.3b) ---------- */

/** What the fixture's build.mjs refuses to see in its environment: the variables the checker must scrub. */
const FIXTURE_BUILD = `import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";

const leaked = Object.keys(process.env).filter(
  (key) => key === "NODE_OPTIONS" || key === "OBSIDIAN_PLUGIN_DIR" || key === "FIXTURE_LEAK" || key.startsWith("npm_config_") || key.startsWith("ESBUILD_"),
);
if (leaked.length > 0) {
  console.error("build saw " + leaked.join(","));
  process.exit(3);
}
if (process.env.CI !== "true") {
  console.error("build did not see CI=true");
  process.exit(4);
}
if (existsSync("dist")) {
  console.error("dist/ existed before the build");
  process.exit(5);
}
const count = existsSync(".build-count") ? Number(readFileSync(".build-count", "utf8")) + 1 : 1;
writeFileSync(".build-count", String(count));
const drift = existsSync("nondeterministic.flag") ? "// run " + count + "\\n" : "";
mkdirSync("dist/plugin", { recursive: true });
mkdirSync("dist/cli", { recursive: true });
writeFileSync("dist/plugin/main.js", readFileSync("src/main.ts", "utf8") + drift);
copyFileSync("manifest.json", "dist/plugin/manifest.json");
if (existsSync("src/styles.css")) copyFileSync("src/styles.css", "dist/plugin/styles.css");
if (!existsSync("no-cli.flag")) {
  writeFileSync("dist/cli/ipfs-sync.mjs", "#!/usr/bin/env node\\n" + readFileSync("cli/main.ts", "utf8"));
  chmodSync("dist/cli/ipfs-sync.mjs", 0o755);
}
`;

/** A stand-in for tools/hook-isolation.mjs: the checker runs the export's own copy, so the fixture ships one. */
const FIXTURE_HOOK_ISOLATION = `import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TESTING = "src/crypto/testing";

// A simplification of the real loadSentinels: no folder means no modules (the real one throws), a module needs one literal.
export async function loadSentinels(root = process.cwd()) {
  let names;
  try {
    names = readdirSync(join(root, TESTING));
  } catch {
    return [];
  }
  return names.map((name) => {
    const found = [...readFileSync(join(root, TESTING, name), "utf8").matchAll(/"(TEST_ONLY_SENTINEL_[A-Z0-9_]+)"/g)];
    if (found.length !== 1) throw new Error(TESTING + "/" + name + " must declare exactly one sentinel string, found " + found.length);
    return { file: TESTING + "/" + name, sentinel: found[0][1] };
  });
}

export async function checkDistBundles({ root = process.cwd() } = {}) {
  const checked = [];
  const missing = [];
  const violations = [];
  for (const target of ["dist/plugin/main.js", "dist/cli/ipfs-sync.mjs"]) {
    let text;
    try {
      text = readFileSync(join(root, target), "utf8");
    } catch {
      missing.push(target);
      continue;
    }
    checked.push(target);
    if (text.includes("TEST_ONLY_SENTINEL")) violations.push(target + " contains a sentinel");
  }
  return { ok: violations.length === 0, checked, missing, violations };
}
`;

/** A tiny project whose "build" is a node script, committed in a temporary repository. `overrides` replaces or (null) removes files. */
export function createBuildFixture(overrides: Readonly<Record<string, FileContent | null>> = {}): string {
  const files: Record<string, FileContent | null> = {
    ".gitignore": "dist/\nnode_modules/\n",
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", engines: { node: ">=24.15.0" }, packageManager: "pnpm@12.8.1", scripts: { build: "node build.mjs" } }, null, 2) + "\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "manifest.json": '{"id":"fixture","version":"1.0.0"}\n',
    "src/main.ts": "export const main = 1;\n",
    "cli/main.ts": "export const cli = 1;\n",
    "build.mjs": FIXTURE_BUILD,
    "tools/hook-isolation.mjs": FIXTURE_HOOK_ISOLATION,
    ...overrides,
  };
  const present: Record<string, FileContent> = {};
  for (const [path, content] of Object.entries(files)) if (content !== null) present[path] = content;
  return createRepo(present);
}

/** Production commands replaced by stubs: no network and no pnpm. The Node of the test process stands in for `node`. */
export function stubCommands(overrides: BuildCommands = {}): BuildCommands {
  return {
    node: process.execPath,
    install: [process.execPath, "-e", ""],
    build: [process.execPath, "build.mjs"],
    nodeVersion: [process.execPath, "--version"],
    pnpmVersion: [process.execPath, "-p", "'12.8.1'"],
    // Item E runners that do nothing: no report is written and the audit prints nothing, so item E fails here (cases that
    // are about another item). The cases for item E replace both with the stubs of guard-final.ts.
    tests: [process.execPath, "-e", ""],
    audit: [process.execPath, "-e", ""],
    ...overrides,
  };
}
