import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECKER_PATH,
  REPO_ROOT,
  captureIo,
  commitAll,
  createRepo,
  failureCodes,
  git,
  head,
  loadChecker,
  removeRepos,
  tempDir,
  writeRepoFile,
  type CheckerModule,
} from "../helpers/guard-repo.ts";

// mvp-07b task 4.3a: the tree hash T of the guard-evidence checker (design 9 "Tree hash T", spec guard-evidence
// "Tree hash over the scope"). Every case runs over a temporary git repository; the real repository is only read for
// its .gitignore and the checker's own source.

let checker: CheckerModule;
beforeAll(async () => {
  checker = await loadChecker();
});
afterAll(removeRepos);

const sha256Hex = async (text: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
};

/** A small repository with one file in each scope family and some files outside the scope. */
const baseFiles = (): Record<string, string> => ({
  "package.json": "a\n",
  "src/index.ts": "b\n",
  "cli/main.ts": "c\n",
  "docs/readme.md": "x\n",
  ".gitignore": readFileSync(join(REPO_ROOT, ".gitignore"), "utf8"),
});

function mustHash(root: string): Extract<ReturnType<CheckerModule["computeTreeHash"]>, { ok: true }> {
  const result = checker.computeTreeHash({ root });
  if (!result.ok) throw new Error(`expected a tree hash, got ${JSON.stringify(result.failures)}`);
  return result;
}

describe("known answers", () => {
  // Expected values were computed with printf and shasum, not with the checker.
  const A = "87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7"; // sha256("a\n")
  const B = "0263829989b6fd954f72baaf2fc64bc2e2f01d692d4de72986ea808f6e99813f"; // sha256("b\n")
  const C = "a3a5e715f0cc574a73c3f9bebb6bc24f32ffd5b67b387244c2c909da779a1478"; // sha256("c\n")

  it("hashes lines ordered by UTF-16 code unit, not by code point", () => {
    // U+FF5E is one code unit 0xFF5E; U+1F600 is the pair 0xD83D 0xDE00, so the emoji sorts BEFORE U+FF5E in
    // UTF-16 order and AFTER it in UTF-8 / code point order. The input is given in code point order.
    const { lines, treeSha256 } = checker.hashTreeLines([
      { path: "src/a.ts", mode: "100644", sha256: A },
      { path: "src/～.ts", mode: "100644", sha256: C },
      { path: "src/\u{1F600}.ts", mode: "100755", sha256: B },
    ]);
    expect(lines).toEqual([`src/a.ts\t100644\t${A}\n`, `src/\u{1F600}.ts\t100755\t${B}\n`, `src/～.ts\t100644\t${C}\n`]);
    expect(treeSha256).toBe("81881f48e667391f60aaef42404307f4285c66a35888d7606e55b21812a753ea");
  });

  it("a repository with fixed content has the pinned T and the pinned lines", () => {
    const root = createRepo(baseFiles());
    const result = mustHash(root);
    expect(result.treeSha256).toBe("b35d20f8e2fb248531cb8f136fec5aeaaf7738646dbdf4fdbc78952635aa4bf1");
    expect(result.lines).toEqual([`cli/main.ts\t100644\t${C}\n`, `package.json\t100644\t${A}\n`, `src/index.ts\t100644\t${B}\n`]);
    expect(result.fileCount).toBe(3);
    expect(result.t8).toBe("b35d20f8");
    expect(result.commit).toBe(head(root));
  });
});

describe("stability", () => {
  it("gives the same T for the same content with other commit metadata, other mtimes and a second run", () => {
    const first = createRepo(baseFiles(), { message: "one" });
    const second = createRepo(baseFiles(), { message: "a different message" });
    const before = mustHash(first).treeSha256;
    writeFileSync(join(first, "src/index.ts"), "b\n"); // rewrite: new mtime, same bytes
    expect(mustHash(first).treeSha256).toBe(before);
    expect(mustHash(second).treeSha256).toBe(before);
  });

  it("a checkout with CRLF line endings (core.autocrlf=true) gives the same T as the LF checkout", () => {
    const source = createRepo(baseFiles());
    const crlf = join(tempDir(), "clone");
    git(dirname(crlf), ["clone", "-q", "-c", "core.autocrlf=true", source, crlf]);
    expect(readFileSync(join(crlf, "src/index.ts"), "utf8")).toBe("b\r\n"); // the setup did change the worktree
    expect(mustHash(crlf).treeSha256).toBe(mustHash(source).treeSha256);
  });

  it("a checkout whose .gitattributes force eol=crlf gives the same T", () => {
    const source = createRepo({ ...baseFiles(), ".gitattributes": "* text eol=crlf\n" });
    const clone = join(tempDir(), "clone");
    git(dirname(clone), ["clone", "-q", source, clone]);
    expect(readFileSync(join(clone, "cli/main.ts"), "utf8")).toBe("c\r\n");
    expect(mustHash(clone).treeSha256).toBe(mustHash(source).treeSha256);
  });

  it("hashes committed bytes as they are: a committed CRLF file keeps its CRLF in the hash", async () => {
    const lf = createRepo({ ...baseFiles(), "src/index.ts": "b\n" });
    const crlf = createRepo({ ...baseFiles(), "src/index.ts": "b\r\n" });
    expect(mustHash(lf).treeSha256).not.toBe(mustHash(crlf).treeSha256);
    const line = mustHash(crlf).lines.find((entry) => entry.startsWith("src/index.ts"));
    expect(line).toBe(`src/index.ts\t100644\t${await sha256Hex("b\r\n")}\n`);
  });

  it("a git replace ref cannot change what is hashed", () => {
    const root = createRepo(baseFiles());
    const before = mustHash(root);
    const original = git(root, ["rev-parse", "HEAD:src/index.ts"]).trim();
    const other = git(root, ["hash-object", "-w", "--stdin"], "something else\n").trim();
    git(root, ["replace", original, other]);
    expect(mustHash(root).treeSha256).toBe(before.treeSha256);
  });

  it("GIT_DIR and GIT_INDEX_FILE inherited from the caller (a git hook) do not redirect the checks", () => {
    const root = createRepo(baseFiles());
    const decoy = createRepo({ "src/other.ts": "decoy\n" });
    const expected = mustHash(root).treeSha256;
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(decoy, ".git");
    process.env.GIT_INDEX_FILE = join(decoy, ".git/index");
    process.env.GIT_WORK_TREE = decoy;
    try {
      expect(mustHash(root).treeSha256).toBe(expected);
    } finally {
      for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_INDEX_FILE", saved.index], ["GIT_WORK_TREE", saved.tree]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("writes nothing: the index file is byte-identical after a run", () => {
    const root = createRepo(baseFiles());
    const before = readFileSync(join(root, ".git/index"));
    mustHash(root);
    expect(readFileSync(join(root, ".git/index")).equals(before)).toBe(true);
    expect(git(root, ["status", "--porcelain"])).toBe("");
  });
});

describe("scope", () => {
  const scopeFiles = (): Record<string, string> => ({
    ...baseFiles(),
    "pnpm-lock.yaml": "lock\n",
    "tools/check-guard-preconditions.mjs": "// checker\n",
    "tools/hook-isolation.mjs": "// lint\n",
    "tools/release/plan.mjs": "// release\n",
    "tools/release-mvp-05.mjs": "// release 1 entry, outside the scope\n",
    "tools/release-mvp-07.mjs": "// release 2 entry\n",
    "tools/feature-op-mvp-07.mjs": "// operator-run entry\n",
    "tools/feature-op-mvp-07/helper.mjs": "// helper\n",
    "tools/feature-op-mvp-07a.mjs": "// committed 07a entry, excluded\n",
    "tools/feature-op-mvp-07a/shared.mjs": "// committed 07a helper, excluded\n",
    "tools/feature-op-mvp-06.mjs": "// older operation, excluded\n",
    "tests/unit/a.test.ts": "// tests are not in the glob\n",
    "src/a.test.ts": "// a test file under src/ is hashed\n",
    "esbuild.config.mjs": "// build\n",
    "tsconfig.json": "{}\n",
  });

  it("includes exactly the named families and excludes the committed 07a files and look-alike names", () => {
    const paths = mustHash(createRepo(scopeFiles())).entries.map((entry) => entry.path);
    expect(paths).toEqual([
      "cli/main.ts",
      "esbuild.config.mjs",
      "package.json",
      "pnpm-lock.yaml",
      "src/a.test.ts",
      "src/index.ts",
      "tools/check-guard-preconditions.mjs",
      "tools/feature-op-mvp-07.mjs",
      "tools/feature-op-mvp-07/helper.mjs",
      "tools/hook-isolation.mjs",
      "tools/release-mvp-07.mjs",
      "tools/release/plan.mjs",
      "tsconfig.json",
    ]);
  });

  it("a change to a file outside the scope does not change T and does not fail", () => {
    const root = createRepo(scopeFiles());
    const before = mustHash(root).treeSha256;
    writeFileSync(join(root, "docs/readme.md"), "dirty outside the scope\n");
    writeFileSync(join(root, "tools/feature-op-mvp-07a/shared.mjs"), "// edited 07a helper\n");
    writeRepoFile(root, "tools/feature-op-mvp-07a/untracked.mjs", "// untracked 07a file\n");
    writeRepoFile(root, "notes/untracked.txt", "untracked\n");
    expect(mustHash(root).treeSha256).toBe(before);
    commitAll(root, "outside edits");
    expect(mustHash(root).treeSha256).toBe(before);
  });

  it("a committed change to a file inside the scope changes T", () => {
    const root = createRepo(scopeFiles());
    const before = mustHash(root).treeSha256;
    writeFileSync(join(root, "src/index.ts"), "changed\n");
    commitAll(root);
    expect(mustHash(root).treeSha256).not.toBe(before);
  });

  it("a test file under src/ is part of T", () => {
    const result = mustHash(createRepo(scopeFiles()));
    expect(result.lines.some((line) => line.startsWith("src/a.test.ts\t"))).toBe(true);
  });

  it("the exported scope names no 07a path", () => {
    const named = [...checker.TREE_SCOPE.files, ...checker.TREE_SCOPE.dirs];
    expect(named.filter((entry) => entry.includes("07a"))).toEqual([]);
    expect(named).toContain("tools/feature-op-mvp-07.mjs");
    expect(named).toContain("tools/feature-op-mvp-07/");
  });
});

describe("files the working tree must not have", () => {
  it("fails on an untracked file inside the scope, and an untracked file outside the scope is fine", () => {
    const root = createRepo(baseFiles());
    writeRepoFile(root, "docs/new.md", "outside\n");
    expect(mustHash(root).ok).toBe(true);
    writeRepoFile(root, "src/new.ts", "inside\n");
    const result = checker.computeTreeHash({ root });
    expect(failureCodes(result)).toEqual(["untracked-file"]);
    expect(result.ok ? [] : result.failures.map((failure) => failure.path)).toEqual(["src/new.ts"]);
  });

  it("fails on an untracked .npmrc (it would change the install and the build, and is not in T)", () => {
    const root = createRepo(baseFiles());
    writeRepoFile(root, ".npmrc", "registry=http://example.invalid/\n");
    expect(failureCodes(checker.computeTreeHash({ root }))).toEqual(["untracked-file"]);
  });

  it("fails on src/x/main.js under the real .gitignore rule, which the plain untracked listing does not show", () => {
    const root = createRepo(baseFiles());
    writeRepoFile(root, "src/x/main.js", "export {};\n");
    // The premise: the first listing is empty, only the ignored listing sees the file.
    expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("");
    expect(git(root, ["ls-files", "--others", "--ignored", "--exclude-standard"]).trim()).toBe("src/x/main.js");
    const result = checker.computeTreeHash({ root });
    expect(failureCodes(result)).toEqual(["ignored-file"]);
    expect(result.ok ? [] : result.failures.map((failure) => failure.path)).toEqual(["src/x/main.js"]);
  });

  it("an ignored file outside the scope is fine", () => {
    const root = createRepo(baseFiles());
    writeRepoFile(root, "docs/main.js", "ignored by the main.js rule\n");
    expect(git(root, ["ls-files", "--others", "--ignored", "--exclude-standard"]).trim()).toBe("docs/main.js");
    expect(mustHash(root).ok).toBe(true);
  });

  it("an info/exclude entry cannot hide an untracked scoped file", () => {
    const root = createRepo(baseFiles());
    writeFileSync(join(root, ".git/info/exclude"), "src/hidden.ts\n");
    writeRepoFile(root, "src/hidden.ts", "hidden\n");
    expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("");
    expect(failureCodes(checker.computeTreeHash({ root }))).toEqual(["ignored-file"]);
  });
});

describe("index and working tree must equal HEAD inside the scope", () => {
  it("fails on a staged difference and names the file", () => {
    const root = createRepo(baseFiles());
    writeFileSync(join(root, "src/index.ts"), "staged\n");
    git(root, ["add", "src/index.ts"]);
    const result = checker.computeTreeHash({ root });
    expect(failureCodes(result)).toContain("staged-change");
    expect(result.ok ? [] : result.failures.find((failure) => failure.code === "staged-change")?.path).toBe("src/index.ts");
  });

  it("fails on an unstaged modification and on a deleted file", () => {
    const root = createRepo(baseFiles());
    writeFileSync(join(root, "cli/main.ts"), "edited\n");
    unlinkSync(join(root, "src/index.ts"));
    const result = checker.computeTreeHash({ root });
    expect(failureCodes(result)).toEqual(["unstaged-change", "unstaged-change"]);
    expect(result.ok ? [] : result.failures.map((failure) => failure.path).sort()).toEqual(["cli/main.ts", "src/index.ts"]);
  });

  it("fails on an intent-to-add entry (a new file the index knows and HEAD does not)", () => {
    const root = createRepo(baseFiles());
    writeRepoFile(root, "src/planned.ts", "planned\n");
    git(root, ["add", "-N", "src/planned.ts"]);
    expect(checker.computeTreeHash({ root }).ok).toBe(false);
  });

  it("fails on a skip-worktree flag even when the file is unchanged, and on assume-unchanged hiding an edit", () => {
    const skipped = createRepo(baseFiles());
    git(skipped, ["update-index", "--skip-worktree", "src/index.ts"]);
    expect(failureCodes(checker.computeTreeHash({ root: skipped }))).toEqual(["index-flag"]);

    const assumed = createRepo(baseFiles());
    writeFileSync(join(assumed, "src/index.ts"), "edited behind the flag\n");
    git(assumed, ["update-index", "--assume-unchanged", "src/index.ts"]);
    expect(git(assumed, ["diff", "--name-only"])).toBe(""); // the plain diff is blind to it
    expect(failureCodes(checker.computeTreeHash({ root: assumed }))).toEqual(["index-flag"]);
  });

  it("a skip-worktree flag outside the scope is fine", () => {
    const root = createRepo(baseFiles());
    git(root, ["update-index", "--skip-worktree", "docs/readme.md"]);
    expect(mustHash(root).ok).toBe(true);
  });

  it("a staged or unstaged change outside the scope is fine", () => {
    const root = createRepo(baseFiles());
    writeFileSync(join(root, "docs/readme.md"), "staged outside\n");
    git(root, ["add", "docs/readme.md"]);
    writeFileSync(join(root, "docs/readme.md"), "unstaged outside\n");
    expect(mustHash(root).ok).toBe(true);
  });
});

describe("modes and paths", () => {
  it("fails on a symbolic link inside the scope, and a link outside the scope is fine", () => {
    const outside = createRepo(baseFiles());
    symlinkSync("readme.md", join(outside, "docs/link.md"));
    commitAll(outside, "link outside");
    expect(mustHash(outside).ok).toBe(true);

    const inside = createRepo(baseFiles());
    symlinkSync("index.ts", join(inside, "src/link.ts"));
    commitAll(inside, "link inside");
    const result = checker.computeTreeHash({ root: inside });
    expect(failureCodes(result)).toEqual(["irregular-mode"]);
    expect(result.ok ? [] : result.failures.map((failure) => `${failure.path} ${failure.detail}`)).toEqual([expect.stringContaining("src/link.ts")]);
  });

  it("fails on a submodule entry (mode 160000) inside the scope", () => {
    const root = createRepo(baseFiles());
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${head(root)},src/sub`]);
    git(root, ["commit", "-q", "-m", "gitlink"]);
    expect(failureCodes(checker.computeTreeHash({ root }))).toContain("irregular-mode");
  });

  it("the exec bit is part of T and is printed in the line", () => {
    const root = createRepo(baseFiles());
    const before = mustHash(root);
    git(root, ["update-index", "--chmod=+x", "src/index.ts"]);
    chmodSync(join(root, "src/index.ts"), 0o755);
    git(root, ["commit", "-q", "-m", "chmod"]);
    const after = mustHash(root);
    expect(after.treeSha256).not.toBe(before.treeSha256);
    expect(after.lines.find((line) => line.startsWith("src/index.ts"))).toMatch(/^src\/index\.ts\t100755\t/);
  });

  it("fails on a path containing a tab or a newline inside the scope", () => {
    const tab = createRepo(baseFiles());
    writeRepoFile(tab, "src/a\tb.ts", "tab\n");
    commitAll(tab);
    expect(failureCodes(checker.computeTreeHash({ root: tab }))).toEqual(["bad-path"]);

    const newline = createRepo(baseFiles());
    writeRepoFile(newline, "src/a\nb.ts", "newline\n");
    commitAll(newline);
    expect(failureCodes(checker.computeTreeHash({ root: newline }))).toEqual(["bad-path"]);
  });

  it("hashes a non-ASCII path", () => {
    const root = createRepo({ ...baseFiles(), "src/café.ts": "e\n" });
    expect(mustHash(root).entries.map((entry) => entry.path)).toContain("src/café.ts");
  });

  it("fails closed on a path that is not valid UTF-8", () => {
    const root = createRepo(baseFiles());
    const blob = git(root, ["rev-parse", "HEAD:src/index.ts"]).trim();
    // A path with the byte 0xFF cannot be written through the shell-free helpers on every file system, so it goes in through the index.
    const input = Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from("src/bad"), Buffer.from([0xff]), Buffer.from(".ts\0")]);
    const spawned = spawnSync("git", ["update-index", "-z", "--index-info"], {
      cwd: root,
      input,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(spawned.status).toBe(0);
    git(root, ["commit", "-q", "-m", "bad path"]);
    expect(failureCodes(checker.computeTreeHash({ root }))).toContain("bad-path");
  });
});

describe("renames", () => {
  it("a committed rename inside the scope changes T although the content is the same", () => {
    const root = createRepo(baseFiles());
    const before = mustHash(root);
    renameSync(join(root, "src/index.ts"), join(root, "src/renamed.ts"));
    commitAll(root, "rename");
    const after = mustHash(root);
    expect(after.treeSha256).not.toBe(before.treeSha256);
    expect(after.entries.map((entry) => entry.sha256)).toEqual(before.entries.map((entry) => entry.sha256));
  });

  it("a rename out of the scope changes T (the file leaves the hash)", () => {
    const root = createRepo(baseFiles());
    const before = mustHash(root);
    mkdirSync(join(root, "notes"));
    renameSync(join(root, "src/index.ts"), join(root, "notes/index.ts"));
    commitAll(root, "move out");
    const after = mustHash(root);
    expect(after.fileCount).toBe(before.fileCount - 1);
    expect(after.treeSha256).not.toBe(before.treeSha256);
  });

  it("an uncommitted rename (git mv) fails, with the old and the new path named", () => {
    const root = createRepo(baseFiles());
    git(root, ["mv", "src/index.ts", "src/renamed.ts"]);
    const result = checker.computeTreeHash({ root });
    expect(failureCodes(result)).toContain("staged-change");
    const paths = result.ok ? [] : result.failures.map((failure) => failure.path);
    expect(paths).toEqual(expect.arrayContaining(["src/index.ts", "src/renamed.ts"]));
  });
});

describe("objects only, at a named commit", () => {
  it("gives the T that the full check gave when that commit was HEAD, and ignores a dirty working tree", () => {
    const root = createRepo(baseFiles());
    const first = mustHash(root);
    writeFileSync(join(root, "src/index.ts"), "second\n");
    commitAll(root, "second");
    writeFileSync(join(root, "cli/main.ts"), "dirty\n");
    writeRepoFile(root, "src/untracked.ts", "untracked\n");
    const at = checker.treeHashAtCommit({ root, commit: first.commit });
    expect(at.ok && at.treeSha256).toBe(first.treeSha256);
    expect(checker.computeTreeHash({ root }).ok).toBe(false);
  });

  it("refuses an argument that is not a commit id", () => {
    const root = createRepo(baseFiles());
    expect(() => checker.treeHashAtCommit({ root, commit: "--output=/tmp/x" })).toThrow(checker.CheckerEnvironmentError);
    expect(() => checker.treeHashAtCommit({ root, commit: "main" })).toThrow(checker.CheckerEnvironmentError);
    expect(() => checker.treeHashAtCommit({ root, commit: "0".repeat(40) })).toThrow(checker.CheckerEnvironmentError);
  });
});

describe("environment errors", () => {
  it("throws when the directory is not a repository, has no commit, or is not the top level", () => {
    expect(() => checker.computeTreeHash({ root: tempDir() })).toThrow(checker.CheckerEnvironmentError);
    const unborn = tempDir();
    git(unborn, ["init", "-q", "-b", "main"]);
    expect(() => checker.computeTreeHash({ root: unborn })).toThrow(checker.CheckerEnvironmentError);
    const root = createRepo(baseFiles());
    expect(() => checker.computeTreeHash({ root: join(root, "src") })).toThrow(checker.CheckerEnvironmentError);
  });
});

describe("imports of the operator-run script are in the scope", () => {
  const withEntry = (entry: string, extra: Record<string, string> = {}): string =>
    createRepo({
      ...baseFiles(),
      "tools/feature-op-mvp-07.mjs": entry,
      "tools/feature-op-mvp-07/helper.mjs": "export const helper = 1;\n",
      "tools/feature-op-mvp-07a/shared.mjs": 'import { dep } from "./dep.mjs";\nexport const shared = dep;\n',
      "tools/feature-op-mvp-07a/dep.mjs": "export const dep = 1;\n",
      "tools/feature-op-mvp-07a/unrelated.mjs": "export const unrelated = 1;\n",
      ...extra,
    });

  it("adds a reused 07a module and its transitive import by exact path, and no other 07a file", () => {
    const root = withEntry('import { shared } from "./feature-op-mvp-07a/shared.mjs";\nimport { helper } from "./feature-op-mvp-07/helper.mjs";\nexport { shared, helper };\n');
    const paths = mustHash(root).entries.map((entry) => entry.path);
    expect(paths).toContain("tools/feature-op-mvp-07a/shared.mjs");
    expect(paths).toContain("tools/feature-op-mvp-07a/dep.mjs");
    expect(paths).not.toContain("tools/feature-op-mvp-07a/unrelated.mjs");
  });

  it("follows dynamic imports with a literal specifier and multi-line named imports", () => {
    const root = withEntry('import {\n  shared,\n} from "./feature-op-mvp-07a/shared.mjs";\nconst later = await import("./feature-op-mvp-07a/unrelated.mjs");\nexport { shared, later };\n');
    const paths = mustHash(root).entries.map((entry) => entry.path);
    expect(paths).toContain("tools/feature-op-mvp-07a/unrelated.mjs");
  });

  it("imports of node: modules, bare packages and src/ files need nothing added", () => {
    const root = withEntry('import { readFileSync } from "node:fs";\nimport esbuild from "esbuild";\nimport { x } from "../src/index.ts";\nexport { readFileSync, esbuild, x };\n');
    expect(mustHash(root).entries.map((entry) => entry.path)).not.toContain("tools/feature-op-mvp-07a/shared.mjs");
  });

  it("T changes when the reused 07a module changes", () => {
    const root = withEntry('import { shared } from "./feature-op-mvp-07a/shared.mjs";\nexport { shared };\n');
    const before = mustHash(root).treeSha256;
    writeFileSync(join(root, "tools/feature-op-mvp-07a/dep.mjs"), "export const dep = 2;\n");
    commitAll(root, "edit dep");
    expect(mustHash(root).treeSha256).not.toBe(before);
  });

  it("fails when the script imports a file outside any scope (tests/, docs/)", () => {
    const root = withEntry('import { a } from "../tests/helpers/a.ts";\nexport { a };\n', { "tests/helpers/a.ts": "export const a = 1;\n" });
    const result = checker.computeTreeHash({ root });
    expect(failureCodes(result)).toEqual(["import-outside-scope"]);
    expect(result.ok ? [] : result.failures.map((failure) => failure.detail)).toEqual([expect.stringContaining("tests/helpers/a.ts")]);
  });

  it("fails on an import that resolves to nothing in HEAD, on an absolute specifier and on a computed specifier", () => {
    const missing = withEntry('import { a } from "./feature-op-mvp-07a/absent.mjs";\nexport { a };\n');
    expect(failureCodes(checker.computeTreeHash({ root: missing }))).toEqual(["import-missing"]);

    const absolute = withEntry('import { a } from "file:///etc/hosts";\nexport { a };\n');
    expect(failureCodes(checker.computeTreeHash({ root: absolute }))).toEqual(["import-outside-scope"]);

    const computed = withEntry('const name = "./feature-op-mvp-07a/unrelated.mjs";\nexport const later = await import(name);\n');
    expect(failureCodes(checker.computeTreeHash({ root: computed }))).toEqual(["import-non-literal"]);
  });

  it("another scoped tool importing an unscoped tools/ file fails; the same import from the script is added", () => {
    const root = withEntry("export {};\n", {
      "tools/release/plan.mjs": 'import { shared } from "../feature-op-mvp-07a/shared.mjs";\nexport { shared };\n',
    });
    expect(failureCodes(checker.computeTreeHash({ root }))).toEqual(["import-outside-scope"]);
  });

  it("an untracked file in the scope still fails even when the script imports cleanly", () => {
    const root = withEntry('import { shared } from "./feature-op-mvp-07a/shared.mjs";\nexport { shared };\n');
    writeRepoFile(root, "tools/feature-op-mvp-07/untracked.mjs", "export {};\n");
    expect(failureCodes(checker.computeTreeHash({ root }))).toEqual(["untracked-file"]);
  });
});

describe("the import scan on this repository's own scoped tools", () => {
  it("finds no import failure in hook-isolation, the release tools, esbuild.options and the checker itself", () => {
    const files: Record<string, string> = { "package.json": "{}\n" };
    for (const path of ["tools/hook-isolation.mjs", "tools/check-guard-preconditions.mjs", "esbuild.options.mjs", "tools/release/plan.mjs", "tools/release/record.mjs", "tools/release/assemble.mjs", "tools/release/steps.mjs", "tools/release/descriptors.mjs", "tools/release/constants.mjs", "tools/release/facts.mjs", "tools/release/bump.mjs", "tools/release/notes.mjs", "tools/release/tar.mjs", "tools/release/release1.mjs", "tools/release/release2.mjs", "tools/release-mvp-07.mjs"]) {
      files[path] = readFileSync(join(REPO_ROOT, path), "utf8");
    }
    const result = checker.computeTreeHash({ root: createRepo(files) });
    expect(result.ok ? [] : result.failures, "import failures").toEqual([]);
  });
});

describe("--print-tree-hash", () => {
  it("prints T, T8, the count and the commit; --list adds the hashed lines exactly", () => {
    const root = createRepo(baseFiles());
    const result = mustHash(root);
    const plain = captureIo();
    expect(checker.runCli(["--print-tree-hash"], { root, ...plain.io })).toBe(0);
    expect(plain.out()).toBe(`tree-sha256: ${result.treeSha256}\ntree-t8: ${result.t8}\ntree-files: 3\ncommit: ${result.commit}\n`);
    expect(plain.err()).toBe("");

    const listed = captureIo();
    expect(checker.runCli(["--print-tree-hash", "--list"], { root, ...listed.io })).toBe(0);
    expect(listed.out()).toBe(`${plain.out()}\n${result.lines.join("")}`);
  });

  it("exits 1 and prints each failure on stderr when a precondition fails", () => {
    const root = createRepo(baseFiles());
    writeRepoFile(root, "src/new.ts", "x\n");
    const run = captureIo();
    expect(checker.runCli(["--print-tree-hash"], { root, ...run.io })).toBe(1);
    expect(run.out()).toBe("");
    expect(run.err()).toContain("untracked-file");
    expect(run.err()).toContain("src/new.ts");
  });

  it("exits 2 for usage and environment errors: unknown option, no option, --list alone, a non-repository", () => {
    const root = createRepo(baseFiles());
    for (const argv of [["--bogus"], [], ["--list"], ["--print-tree-hash", "--bogus"], ["--print-tree-hash", "extra"]]) {
      const run = captureIo();
      expect(checker.runCli(argv, { root, ...run.io }), JSON.stringify(argv)).toBe(2);
      expect(run.out()).toBe("");
    }
    const run = captureIo();
    expect(checker.runCli(["--print-tree-hash"], { root: tempDir(), ...run.io })).toBe(2);
  });
});

describe("the real process", () => {
  it("exits 0 with T on a clean repository, 1 when dirty, 2 for an unknown option", () => {
    const root = createRepo(baseFiles());
    mkdirSync(join(root, "tools"));
    copyFileSync(CHECKER_PATH, join(root, "tools/check-guard-preconditions.mjs"));
    // Since 4.4c the checker imports the allowlist surface of ./hook-isolation.mjs; the real file needs esbuild and the
    // repository's option module, so this repository carries a stand-in with the two names the checker imports.
    writeFileSync(join(root, "tools/hook-isolation.mjs"), 'export const TOOL_TESTING_IMPORT_ALLOWLIST = [];\nexport const isToolTestingImportAllowed = () => false;\n');
    commitAll(root, "add the checker");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [join(root, "tools/check-guard-preconditions.mjs"), ...args], {
        cwd: tempDir(), // the working directory is not the repository: the checker finds its own repository
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        encoding: "utf8",
      });

    const clean = run(["--print-tree-hash"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain(`tree-sha256: ${mustHash(root).treeSha256}\n`);

    writeRepoFile(root, "src/new.ts", "x\n");
    const dirty = run(["--print-tree-hash"]);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toBe("");

    expect(run(["--bogus"]).status).toBe(2);
    // Since 4.3b a run with no option is the T and B check: the dirty tree fails T (1) before any build starts.
    expect(run([]).status).toBe(1);
  });
});

describe("the checker's own imports", () => {
  it("are Node built-ins and ./hook-isolation.mjs only (spec: a single file importing nothing else)", () => {
    const source = readFileSync(CHECKER_PATH, "utf8");
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((match) => match[1] as string);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith("node:") || specifier === "./hook-isolation.mjs", specifier).toBe(true);
    }
  });

  it("does not import the crypto testing modules or name their folder", () => {
    expect(readFileSync(CHECKER_PATH, "utf8")).not.toMatch(/crypto\/testing/);
  });
});
