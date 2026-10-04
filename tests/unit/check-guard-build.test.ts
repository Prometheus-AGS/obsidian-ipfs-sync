import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureIo,
  commitAll,
  createBuildFixture,
  failureCodes,
  git,
  head,
  loadChecker,
  removeRepos,
  stubCommands,
  tempDir,
  writeRepoFile,
  type BuildCommands,
  type CheckerModule,
} from "../helpers/guard-repo.ts";

// mvp-07b task 4.3b: the clean-export build B and `--build` (design 9 "Build hashes B", spec guard-evidence "Build
// hashes from a clean export"). Every case runs over a temporary repository whose "build" is a node script, with the
// install and build commands replaced by stubs: no network, no pnpm, and nothing in the real repository is built.

let checker: CheckerModule;
beforeAll(async () => {
  checker = await loadChecker();
});
afterAll(removeRepos);

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** An empty directory under the real temp dir that the export is made in, so leftovers are visible. */
const exportParent = (): string => tempDir("guard-export-parent-");

interface Run {
  readonly root: string;
  readonly tmpRoot: string;
  readonly commands: BuildCommands;
}

const prepare = (overrides: Record<string, string | null> = {}, commands: BuildCommands = {}): Run => ({
  root: createBuildFixture(overrides),
  tmpRoot: exportParent(),
  commands: stubCommands(commands),
});

const build = (run: Run, environment?: Record<string, string | undefined>): ReturnType<CheckerModule["buildCleanExport"]> =>
  checker.buildCleanExport({ root: run.root, commit: head(run.root), commands: run.commands, tmpRoot: run.tmpRoot, ...(environment ? { environment } : {}) });

function mustBuild(run: Run, environment?: Record<string, string | undefined>): Extract<ReturnType<CheckerModule["buildCleanExport"]>, { ok: true }> {
  const result = build(run, environment);
  if (!result.ok) throw new Error(`expected a build, got ${JSON.stringify(result.failures)}`);
  return result;
}

/** A fresh directory holding the committed files of `root` (never a working-tree build in the fixture itself). */
function tempCopy(root: string): string {
  const dir = tempDir("guard-copy-");
  for (const path of ["build.mjs", "manifest.json", "src/main.ts", "cli/main.ts"]) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), readFileSync(join(root, path)));
  }
  return dir;
}

const listTree = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length))
    .sort();
};

describe("B: a reproducible clean-export build", () => {
  it("hashes the outputs of two identical builds and returns the same bytes it hashed", () => {
    const run = prepare();
    const result = mustBuild(run);
    expect(Object.keys(result.files).sort()).toEqual(["dist/cli/ipfs-sync.mjs", "dist/plugin/main.js", "dist/plugin/manifest.json"]);
    expect(result.files["dist/plugin/main.js"]).toBe(sha256("export const main = 1;\n"));
    expect(result.files["dist/plugin/manifest.json"]).toBe(sha256('{"id":"fixture","version":"1.0.0"}\n'));
    expect(result.artifacts.get("dist/plugin/main.js")?.toString("utf8")).toBe("export const main = 1;\n");
    expect(result.buildSha256).toBe(checker.hashBuildLines(result.files).buildSha256);
    expect(result.versions.pnpm).toBe("12.8.1");
    expect(result.versions.node).toBe(process.version);
    expect(result.commit).toBe(head(run.root));
  });

  it("includes dist/plugin/styles.css only when the build produces it", () => {
    const withStyles = mustBuild(prepare({ "src/styles.css": "a{}\n" }));
    expect(withStyles.files["dist/plugin/styles.css"]).toBe(sha256("a{}\n"));
    expect(Object.keys(mustBuild(prepare()).files)).not.toContain("dist/plugin/styles.css");
  });

  it("is a known answer: B is the SHA-256 of sorted '<path>\\t<sha256>\\n' lines", () => {
    const files = { "dist/plugin/main.js": "a".repeat(64), "dist/cli/ipfs-sync.mjs": "b".repeat(64) };
    const { lines, buildSha256 } = checker.hashBuildLines(files);
    expect(lines).toEqual([`dist/cli/ipfs-sync.mjs\t${"b".repeat(64)}\n`, `dist/plugin/main.js\t${"a".repeat(64)}\n`]);
    expect(buildSha256).toBe(sha256(lines.join("")));
  });

  it("detects a non-reproducible build and names the file that differs", () => {
    const result = build(prepare({ "nondeterministic.flag": "x\n" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(failureCodes(result)).toEqual(["build-not-reproducible"]);
    expect(result.failures[0]?.path).toBe("dist/plugin/main.js");
  });

  it("removes dist/ between the builds (the fixture build refuses an existing dist/)", () => {
    expect(build(prepare()).ok).toBe(true);
  });

  it("fails when a required output is missing, and names it", () => {
    const result = build(prepare({ "no-cli.flag": "x\n" }));
    expect(failureCodes(result)).toEqual(["build-output-missing"]);
    expect(result.ok ? "" : result.failures[0]?.path).toBe("dist/cli/ipfs-sync.mjs");
  });

  it("fails when the install fails (lockfile drift), and does not build", () => {
    const run = prepare({}, { install: [process.execPath, "-e", "console.error('ERR_PNPM_OUTDATED_LOCKFILE'); process.exit(1)"] });
    const result = build(run);
    expect(failureCodes(result)).toEqual(["install-failed"]);
    expect(result.ok ? "" : result.failures[0]?.detail).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
  });

  it("fails when the build command fails, with the tail of its output", () => {
    const result = build(prepare({}, { build: [process.execPath, "-e", "console.error('boom'); process.exit(7)"] }));
    expect(failureCodes(result)).toEqual(["build-failed"]);
    expect(result.ok ? "" : result.failures[0]?.detail).toContain("boom");
  });

  it("runs checkDistBundles of the export on the second build and returns what it found for item D (a violation is item D's failure, not B's)", () => {
    const clean = mustBuild(prepare());
    expect(clean.distScan.dist).toMatchObject({ ok: true, checked: ["dist/plugin/main.js", "dist/cli/ipfs-sync.mjs"], violations: [] });
    const dirty = mustBuild(prepare({ "src/main.ts": "export const x = 'TEST_ONLY_SENTINEL_X';\n" }));
    expect(dirty.distScan.dist?.ok).toBe(false);
    expect(dirty.distScan.dist?.violations.join()).toContain("dist/plugin/main.js contains a sentinel");
  });

  it("reports a test-only module without a sentinel as sentinelError and does not scan the bundles", () => {
    const result = mustBuild(prepare({ "src/crypto/testing/raw.ts": "export const raw = 1;\n" }));
    expect(result.distScan.sentinelError).toContain("src/crypto/testing/raw.ts must declare exactly one sentinel");
    expect(result.distScan.dist).toBeUndefined();
  });

  it("leaves no temporary export behind, on success and on failure", () => {
    const ok = prepare();
    mustBuild(ok);
    expect(readdirSync(ok.tmpRoot)).toEqual([]);
    const bad = prepare({ "nondeterministic.flag": "x\n" });
    build(bad);
    expect(readdirSync(bad.tmpRoot)).toEqual([]);
  });

  it("refuses a temporary directory inside the repository (a default run must write nothing there)", () => {
    const root = createBuildFixture();
    const inside = join(root, "scratch");
    mkdirSync(inside);
    expect(() => checker.buildCleanExport({ root, commit: head(root), commands: stubCommands(), tmpRoot: inside })).toThrow(/inside the repository/);
    expect(readdirSync(inside)).toEqual([]);
  });
});

describe("the export is the commit's objects and nothing else", () => {
  it("builds the committed bytes, not an edited or untracked working-tree file", () => {
    const run = prepare();
    writeFileSync(join(run.root, "src/main.ts"), "export const main = 'edited';\n");
    writeFileSync(join(run.root, "src/untracked.ts"), "x\n");
    const result = mustBuild(run);
    expect(result.artifacts.get("dist/plugin/main.js")?.toString("utf8")).toBe("export const main = 1;\n");
  });

  it("builds the named commit even when HEAD has moved on", () => {
    const run = prepare();
    const first = head(run.root);
    writeRepoFile(run.root, "src/main.ts", "export const main = 2;\n");
    commitAll(run.root, "second");
    const result = checker.buildCleanExport({ root: run.root, commit: first, commands: run.commands, tmpRoot: run.tmpRoot });
    expect(result.ok && result.artifacts.get("dist/plugin/main.js")?.toString("utf8")).toBe("export const main = 1;\n");
    expect(result.ok && result.commit).toBe(first);
  });

  it("fails when an export differs from a blob because of a .gitattributes rule, and names the file", () => {
    const run = prepare({ ".gitattributes": "src/note.txt text eol=crlf\n", "src/note.txt": "one\ntwo\n" });
    const result = build(run);
    expect(failureCodes(result)).toEqual(["export-differs-from-blob"]);
    expect(result.ok ? "" : result.failures[0]?.path).toBe("src/note.txt");
  });

  it("fails when export-ignore drops a scoped file", () => {
    const run = prepare({ ".gitattributes": "src/note.txt export-ignore\n", "src/note.txt": "one\n" });
    const result = build(run);
    expect(failureCodes(result)).toEqual(["export-differs-from-blob"]);
    expect(result.ok ? "" : result.failures[0]?.detail).toContain("missing");
  });

  it("does not materialize a symbolic link outside the scope, and says so", () => {
    const root = createBuildFixture();
    symlinkSync("/etc/hosts", join(root, "hosts-link"));
    commitAll(root, "link");
    const result = checker.buildCleanExport({ root, commit: head(root), commands: stubCommands(), tmpRoot: exportParent() });
    expect(result.ok && result.notices.some((notice) => notice.includes("hosts-link"))).toBe(true);
  });

  it("keeps the executable bit of the committed file out of the way of the hashes (modes are not part of B)", () => {
    const result = mustBuild(prepare());
    expect(result.files["dist/cli/ipfs-sync.mjs"]).toBe(sha256("#!/usr/bin/env node\nexport const cli = 1;\n"));
  });
});

describe("the scrubbed environment", () => {
  const dirty = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    PNPM_HOME: "/pnpm",
    NODE_OPTIONS: "--require /tmp/evil.js",
    OBSIDIAN_PLUGIN_DIR: "/Users/someone/vault/.obsidian/plugins/x",
    npm_config_registry: "http://127.0.0.1:1",
    NPM_CONFIG_USERCONFIG: "/tmp/evil.npmrc",
    ESBUILD_BINARY_PATH: "/tmp/evil-esbuild",
    FIXTURE_LEAK: "1",
    GIT_DIR: "/elsewhere",
    SECRET_TOKEN: "x",
  };

  it("keeps only the allow-list and sets CI=true", () => {
    const env = checker.scrubbedBuildEnvironment(dirty);
    expect(Object.keys(env).sort()).toEqual(["CI", "HOME", "LANG", "LC_ALL", "PATH", "PNPM_HOME", "TMPDIR"]);
    expect(env.CI).toBe("true");
  });

  it("drops relative and empty PATH entries (a working-directory binary must not shadow node or pnpm)", () => {
    const env = checker.scrubbedBuildEnvironment({ PATH: [".", "", "node_modules/.bin", "/usr/bin", "/bin"].join(":") });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("the build does not see NODE_OPTIONS, OBSIDIAN_PLUGIN_DIR, npm_config_* or ESBUILD_* set in the caller", () => {
    const run = prepare();
    // The fixture build exits non-zero when it sees any of them, or when CI is not "true".
    expect(build(run, dirty).ok).toBe(true);
  });

  it("the fixture build is a real control: handed one of the variables it exits 3, and without CI=true it exits 4", () => {
    const root = createBuildFixture();
    const run = (env: Record<string, string>): number | null =>
      spawnSync(process.execPath, ["build.mjs"], { cwd: tempCopy(root), env: { PATH: process.env.PATH ?? "", ...env } }).status;
    expect(run({ CI: "true", NODE_OPTIONS: "--no-warnings" })).toBe(3);
    expect(run({ CI: "true", npm_config_registry: "x" })).toBe(3);
    expect(run({})).toBe(4);
    expect(run({ CI: "true" })).toBe(0);
  });
});

describe("Node and pnpm versions", () => {
  it("accepts versions that satisfy engines.node and rejects the ones below it", () => {
    expect(checker.nodeSatisfiesEngines("v24.15.0", ">=24.15.0")).toBe(true);
    expect(checker.nodeSatisfiesEngines("v24.16.0", ">=24.15.0")).toBe(true);
    expect(checker.nodeSatisfiesEngines("v25.0.0", ">=24.15.0")).toBe(true);
    expect(checker.nodeSatisfiesEngines("v24.14.9", ">=24.15.0")).toBe(false);
    expect(checker.nodeSatisfiesEngines("v22.20.0", ">=24.15.0")).toBe(false);
  });

  it("fails closed on a range or a version it cannot read", () => {
    expect(() => checker.nodeSatisfiesEngines("v24.16.0", "^24")).toThrow(/engines\.node/);
    expect(() => checker.nodeSatisfiesEngines("not-a-version", ">=24.15.0")).toThrow(/version/);
  });

  it("fails the build for an unsupported Node version, before installing anything", () => {
    const run = prepare({}, { nodeVersion: [process.execPath, "-p", "'v22.1.0'"], install: [process.execPath, "-e", "process.exit(9)"] });
    const result = build(run);
    expect(failureCodes(result)).toEqual(["node-version-unsupported"]);
    expect(result.ok ? "" : result.failures[0]?.detail).toContain("v22.1.0");
  });

  it("asks the Node that the build would run (the scrubbed PATH), not the checker's own", () => {
    const run = prepare({}, { nodeVersion: [process.execPath, "-p", "'v26.0.0'"] });
    expect(mustBuild(run).versions.node).toBe("v26.0.0");
  });

  it("is an environment error when package.json holds no readable engines.node", () => {
    const run = prepare({ "package.json": '{"name":"x","scripts":{}}\n' });
    expect(() => build(run)).toThrow(/engines\.node/);
  });
});

describe("a default run writes nothing in the repository", () => {
  it("leaves git status (with ignored files) clean and dist/ untouched, and exits 1 (no review record: item A fails; the stub test runner and audit fail item E)", () => {
    const run = prepare();
    mkdirSync(join(run.root, "dist/plugin"), { recursive: true });
    writeFileSync(join(run.root, "dist/plugin/main.js"), "old\n");
    const before = { status: git(run.root, ["status", "--porcelain", "--ignored"]), tree: listTree(join(run.root, "dist")) };
    const io = captureIo();
    const code = checker.runCli([], { root: run.root, ...io.io, commands: run.commands, tmpRoot: run.tmpRoot });
    expect(code, io.err()).toBe(1);
    expect(io.err()).toContain("review-record-missing");
    expect(io.err()).toContain("result: fail (A, B, C, E)");
    expect(io.out()).toContain("build-sha256:");
    expect(io.out()).toContain("tree-sha256:");
    expect(git(run.root, ["status", "--porcelain", "--ignored"])).toBe(before.status);
    expect(listTree(join(run.root, "dist"))).toEqual(before.tree);
    expect(readFileSync(join(run.root, "dist/plugin/main.js"), "utf8")).toBe("old\n");
    expect(readdirSync(run.tmpRoot)).toEqual([]);
  });

  it("exits 1 and prints the reason when T fails (dirty working tree), without building", () => {
    const run = prepare({}, { build: [process.execPath, "-e", "process.exit(9)"] });
    writeFileSync(join(run.root, "src/main.ts"), "dirty\n");
    const io = captureIo();
    expect(checker.runCli([], { root: run.root, ...io.io, commands: run.commands, tmpRoot: run.tmpRoot })).toBe(1);
    expect(io.err()).toContain("unstaged-change");
    expect(io.err()).not.toContain("build-failed");
  });

  it("exits 1 for a non-reproducible build, naming the file", () => {
    const run = prepare({ "nondeterministic.flag": "x\n" });
    const io = captureIo();
    expect(checker.runCli([], { root: run.root, ...io.io, commands: run.commands, tmpRoot: run.tmpRoot })).toBe(1);
    expect(io.err()).toContain("build-not-reproducible");
    expect(io.err()).toContain("dist/plugin/main.js");
  });

  it("rejects --list without --print-tree-hash, and unknown options, with exit 2", () => {
    const root = createBuildFixture();
    for (const argv of [["--list"], ["--build", "--list"], ["--skip-build"], ["--build", "--print-tree-hash"]]) {
      const io = captureIo();
      expect(checker.runCli(argv, { root, ...io.io }), argv.join(" ")).toBe(2);
    }
  });
});

describe("--build", () => {
  const fabricateRelease = (root: string): string => {
    const dir = join(root, "dist/release/v0.3.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SHA256SUMS"), "abc  file\n");
    writeFileSync(join(dir, "release-notes.md"), "notes\n");
    return dir;
  };

  it("copies the verified outputs into dist/plugin and dist/cli, writes dist/.guard-build.json, and leaves dist/release/v0.3.0 intact", () => {
    const run = prepare({ "src/styles.css": "a{}\n" });
    const releaseDir = fabricateRelease(run.root);
    const releaseBefore = listTree(join(run.root, "dist/release"));
    const io = captureIo();
    const code = checker.runCli(["--build"], { root: run.root, ...io.io, commands: run.commands, tmpRoot: run.tmpRoot });
    expect(code, io.err()).toBe(0);
    expect(listTree(join(run.root, "dist/release"))).toEqual(releaseBefore);
    expect(readFileSync(join(releaseDir, "SHA256SUMS"), "utf8")).toBe("abc  file\n");
    expect(readFileSync(join(run.root, "dist/plugin/main.js"), "utf8")).toBe("export const main = 1;\n");
    expect(readFileSync(join(run.root, "dist/plugin/styles.css"), "utf8")).toBe("a{}\n");
    expect(readFileSync(join(run.root, "dist/cli/ipfs-sync.mjs"), "utf8")).toBe("#!/usr/bin/env node\nexport const cli = 1;\n");
    expect(lstatSync(join(run.root, "dist/cli/ipfs-sync.mjs")).mode & 0o777).toBe(0o755);

    const state = JSON.parse(readFileSync(join(run.root, checker.GUARD_BUILD_FILE), "utf8")) as Record<string, unknown>;
    const tree = checker.computeTreeHash({ root: run.root });
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    expect(state).toMatchObject({
      schema: 1,
      commit: head(run.root),
      treeSha256: tree.treeSha256,
      node: process.version,
      pnpm: "12.8.1",
    });
    const files = state.files as Record<string, string>;
    expect(Object.keys(files).sort()).toEqual(["dist/cli/ipfs-sync.mjs", "dist/plugin/main.js", "dist/plugin/manifest.json", "dist/plugin/styles.css"]);
    for (const [path, hash] of Object.entries(files)) expect(sha256(readFileSync(join(run.root, path))), path).toBe(hash);
    expect(state.buildSha256).toBe(checker.hashBuildLines(files).buildSha256);
    expect(io.out()).toContain(`build-sha256: ${String(state.buildSha256)}`);
    expect(readdirSync(run.tmpRoot)).toEqual([]);
  });

  it("writes only dist/plugin, dist/cli and dist/.guard-build.json (the repository is otherwise unchanged)", () => {
    const run = prepare();
    const before = git(run.root, ["status", "--porcelain", "--ignored"]);
    expect(checker.runCli(["--build"], { root: run.root, ...captureIo().io, commands: run.commands, tmpRoot: run.tmpRoot })).toBe(0);
    expect(git(run.root, ["status", "--porcelain"])).toBe("");
    expect(before).toBe("");
    expect(listTree(join(run.root, "dist"))).toEqual(
      ["/.guard-build.json", "/cli", "/cli/ipfs-sync.mjs", "/plugin", "/plugin/main.js", "/plugin/manifest.json"].sort(),
    );
  });

  it("removes a stale styles.css and other loose files in dist/plugin that the verified build does not produce", () => {
    const run = prepare();
    mkdirSync(join(run.root, "dist/plugin"), { recursive: true });
    writeFileSync(join(run.root, "dist/plugin/styles.css"), "stale\n");
    writeFileSync(join(run.root, "dist/plugin/main.js.map"), "stale\n");
    expect(checker.runCli(["--build"], { root: run.root, ...captureIo().io, commands: run.commands, tmpRoot: run.tmpRoot })).toBe(0);
    expect(existsSync(join(run.root, "dist/plugin/styles.css"))).toBe(false);
    expect(existsSync(join(run.root, "dist/plugin/main.js.map"))).toBe(false);
  });

  it("replaces the state file last: a failed build leaves the old outputs and the old state untouched", () => {
    const run = prepare();
    expect(checker.runCli(["--build"], { root: run.root, ...captureIo().io, commands: run.commands, tmpRoot: run.tmpRoot })).toBe(0);
    const stateBefore = readFileSync(join(run.root, checker.GUARD_BUILD_FILE), "utf8");
    writeRepoFile(run.root, "nondeterministic.flag", "x\n");
    commitAll(run.root, "make it non-reproducible");
    const io = captureIo();
    expect(checker.runCli(["--build"], { root: run.root, ...io.io, commands: run.commands, tmpRoot: run.tmpRoot })).toBe(1);
    expect(readFileSync(join(run.root, checker.GUARD_BUILD_FILE), "utf8")).toBe(stateBefore);
    expect(readFileSync(join(run.root, "dist/plugin/main.js"), "utf8")).toBe("export const main = 1;\n");
  });

  it("refuses when the working tree is not the commit (T fails), and writes nothing", () => {
    const run = prepare();
    writeFileSync(join(run.root, "src/main.ts"), "dirty\n");
    const io = captureIo();
    expect(checker.runCli(["--build"], { root: run.root, ...io.io, commands: run.commands, tmpRoot: run.tmpRoot })).toBe(1);
    expect(existsSync(join(run.root, "dist"))).toBe(false);
  });

  it.each(["dist", "dist/plugin", "dist/cli"])("refuses to write through a symbolic link at %s (exit 2, nothing written there)", (link) => {
    const run = prepare();
    const elsewhere = tempDir("guard-elsewhere-");
    mkdirSync(join(run.root, link, ".."), { recursive: true });
    symlinkSync(elsewhere, join(run.root, link));
    const io = captureIo();
    expect(checker.runCli(["--build"], { root: run.root, ...io.io, commands: run.commands, tmpRoot: run.tmpRoot }), io.err()).toBe(2);
    expect(io.err()).toContain("symbolic link");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a subdirectory inside dist/plugin (it cannot say what it holds), exit 2", () => {
    const run = prepare();
    mkdirSync(join(run.root, "dist/plugin/extra"), { recursive: true });
    const io = captureIo();
    expect(checker.runCli(["--build"], { root: run.root, ...io.io, commands: run.commands, tmpRoot: run.tmpRoot })).toBe(2);
    expect(existsSync(join(run.root, checker.GUARD_BUILD_FILE))).toBe(false);
  });

  it("fails when HEAD moves while the build runs (time of check to time of use), and writes nothing", () => {
    const run = prepare();
    const marker = join(run.root, ".git", "moved-marker");
    const mover = [
      process.execPath,
      "-e",
      `const { execFileSync } = require("node:child_process"); const fs = require("node:fs");` +
        `if (!fs.existsSync(${JSON.stringify(marker)})) {` +
        `fs.writeFileSync(${JSON.stringify(marker)}, "x");` +
        `fs.writeFileSync(${JSON.stringify(join(run.root, "src/main.ts"))}, "moved\\n");` +
        `execFileSync("git", ["-c","commit.gpgsign=false","-c","user.name=t","-c","user.email=t@example.invalid","commit","-qam","moved"], { cwd: ${JSON.stringify(run.root)} });` +
        `}` +
        `execFileSync(process.execPath, ["build.mjs"], { stdio: "inherit" });`,
    ];
    const io = captureIo();
    const code = checker.runCli(["--build"], { root: run.root, ...io.io, commands: { ...run.commands, build: mover }, tmpRoot: run.tmpRoot });
    expect(code, io.err()).toBe(1);
    expect(io.err()).toContain("tree-changed-during-build");
    expect(existsSync(join(run.root, "dist/plugin/main.js"))).toBe(false);
    expect(existsSync(join(run.root, checker.GUARD_BUILD_FILE))).toBe(false);
  });
});
