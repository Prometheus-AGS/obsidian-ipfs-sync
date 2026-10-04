import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureIo, commitAll, git, head, loadChecker, removeRepos, stubCommands, tempDir, writeRepoFile, type CheckerModule, type ReviewCheckResult } from "../helpers/guard-repo.ts";
import {
  BUILD_SHA,
  FIXTURE_CHECKER,
  FIXTURE_TEST,
  baseRecord,
  commitReview,
  isolatedEnvironment,
  okTree,
  recordText,
  reviewFixture,
  type JsonRecord,
} from "../helpers/guard-review.ts";

// mvp-07b task 4.3c: item A, the review record (design 9 "Review record", spec guard-evidence "Item A"). Every case runs
// over a temporary repository; the record forms, the failures and the defect loop are exercised through
// `checkReviewRecord`, the wiring through `runCli`. No real repository is built: the build is a stub.

let checker: CheckerModule;
beforeAll(async () => {
  checker = await loadChecker();
});
afterAll(removeRepos);

const codes = (result: ReviewCheckResult): string[] => result.failures.map((failure) => failure.code);
const finding = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: "F-1", severity: "high", status: "fixed", summary: "s", ...extra });
const withFindings = (findings: Record<string, unknown>[], counts: Record<string, number>) => (record: JsonRecord): JsonRecord => ({
  ...record,
  findings,
  counts: { critical: 0, high: 0, medium: 0, low: 0, ...counts },
});

/** Commits a record for the current tree and checks it. */
function review(mutate?: (record: JsonRecord) => JsonRecord, root = reviewFixture()): { root: string; result: ReviewCheckResult; commit: string } {
  const committed = commitReview(checker, root, mutate ? { mutate } : {});
  const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
  return { root, result, commit: committed.commit };
}

describe("item A: a record that passes by the git-history form", () => {
  it("passes, names the form, the commit E and the number of commits that touched the record", () => {
    const { result, commit } = review();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.form).toBe("git-history");
    expect(result.evidence.commit).toBe(commit);
    expect(result.evidence.commitCount).toBe(1);
    expect(result.evidence.recordPath).toMatch(/review-final-[0-9a-f]{8}\.md$/);
    expect(result.unread).toEqual([]);
    expect(result.accepted).toEqual([]);
  });

  it("a record with two commits still passes and the count is printed as 2", () => {
    const root = reviewFixture();
    const first = commitReview(checker, root);
    writeFileSync(join(root, first.path), `${first.text}A disposition line added later.\n`);
    const second = commitAll(root, "disposition");
    const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(result.failures).toEqual([]);
    expect(result.evidence.commit).toBe(second);
    expect(result.evidence.commitCount).toBe(2);
  });

  it("a file declared unread passes and is listed", () => {
    const { result } = review((record) => ({
      ...record,
      coverage: (record.coverage as { path: string; read: boolean }[]).map((entry) => (entry.path === "src/main.ts" ? { ...entry, read: false } : entry)),
    }));
    expect(result.ok).toBe(true);
    expect(result.unread).toEqual(["src/main.ts"]);
  });

  it("an accepted medium finding with a reason passes and is listed", () => {
    const { result } = review(withFindings([finding({ id: "M-1", severity: "medium", status: "accepted", acceptedBecause: "needs a node writer" })], { medium: 1 }));
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual([{ id: "M-1", severity: "medium", because: "needs a node writer" }]);
  });

  it("the defect loop: a fix that changes T gets a new review-final file, the old file stays, and the new tree authenticates", () => {
    const root = reviewFixture();
    const old = commitReview(checker, root);
    writeRepoFile(root, "src/main.ts", "export const main = 2;\n");
    commitAll(root, "fix");
    const stale = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(codes(stale)).toEqual(["review-record-missing"]);
    const fresh = commitReview(checker, root);
    expect(fresh.path).not.toBe(old.path);
    const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(result.failures).toEqual([]);
    expect(result.evidence.recordPath).toBe(fresh.path);
    expect(existsSync(join(root, old.path))).toBe(true);
  });
});

describe("item A: each failure alone", () => {
  it("fails when no record is committed for the tree's T8 (a record that is only in the working tree does not count)", () => {
    const root = reviewFixture();
    const tree = okTree(checker, root);
    writeRepoFile(root, `${checker.REVIEW_RECORD_DIR}/review-final-${tree.t8}.md`, recordText(baseRecord(tree, head(root))));
    const result = checker.checkReviewRecord({ root, tree, buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(codes(result)).toEqual(["review-record-missing"]);
  });

  it("fails when the record's file name carries another tree's T8", () => {
    const root = reviewFixture();
    commitReview(checker, root, { nameT8: "deadbeef" });
    const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(codes(result)).toEqual(["review-record-missing"]);
  });

  it("fails when the file under the right name records another tree (code changed after review)", () => {
    const root = reviewFixture();
    const old = commitReview(checker, root);
    writeRepoFile(root, "src/main.ts", "export const main = 2;\n");
    commitAll(root, "change after review");
    const tree = okTree(checker, root);
    writeRepoFile(root, `${checker.REVIEW_RECORD_DIR}/review-final-${tree.t8}.md`, old.text);
    commitAll(root, "old record under the new name");
    const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(codes(result)).toEqual(expect.arrayContaining(["review-tree-mismatch", "review-name-mismatch"]));
    expect(result.ok).toBe(false);
  });

  it.each([
    ["the wrong reviewer", (record: JsonRecord) => ({ ...record, reviewer: "lead" }), "review-reviewer"],
    ["a blocked verdict", (record: JsonRecord) => ({ ...record, verdict: "blocked" }), "review-verdict"],
    ["a wrong file count", (record: JsonRecord) => ({ ...record, treeFileCount: 99 }), "review-file-count"],
    ["a build hash for another build", (record: JsonRecord) => ({ ...record, buildSha256: "c".repeat(64) }), "review-build-mismatch"],
    ["a checker hash for another checker", (record: JsonRecord) => ({ ...record, checkerSha256: "d".repeat(64) }), "review-checker-mismatch"],
    ["a checklist test hash that differs", (record: JsonRecord) => ({ ...record, checklistTests: { [FIXTURE_TEST]: "e".repeat(64) } }), "review-checklist-mismatch"],
    ["a checklist test that does not exist", (record: JsonRecord) => ({ ...record, checklistTests: { "tests/unit/absent.test.ts": "e".repeat(64) } }), "review-checklist-missing"],
    ["a checklist path that leaves the repository", (record: JsonRecord) => ({ ...record, checklistTests: { "../outside.test.ts": "e".repeat(64) } }), "review-checklist-path"],
  ])("fails for %s", (_name, mutate, code) => {
    const { result } = review(mutate);
    expect(codes(result)).toEqual([code]);
  });

  it("fails for an open high finding, even when the counts are right", () => {
    const { result } = review(withFindings([finding({ status: "open" })], { high: 1 }));
    expect(codes(result)).toEqual(["review-open-finding"]);
    expect(result.failures[0]?.detail).toContain("F-1");
  });

  it("fails for an accepted critical finding (critical and high must be fixed)", () => {
    const { result } = review(withFindings([finding({ severity: "critical", status: "accepted", acceptedBecause: "x" })], { critical: 1 }));
    expect(codes(result)).toEqual(["review-open-finding"]);
  });

  it("fails when the counts contradict the findings (counts.high 0 with a high finding listed)", () => {
    const { result } = review(withFindings([finding({})], { high: 0 }));
    expect(codes(result)).toEqual(["review-counts-mismatch"]);
  });

  it("fails for an open medium finding and for an accepted one without a reason", () => {
    expect(codes(review(withFindings([finding({ severity: "medium", status: "open" })], { medium: 1 })).result)).toEqual(["review-open-finding"]);
    expect(codes(review(withFindings([finding({ severity: "low", status: "accepted" })], { low: 1 })).result)).toEqual(["review-accepted-without-reason"]);
  });

  it("fails when coverage lacks a file, names the file", () => {
    const { result } = review((record) => ({ ...record, coverage: (record.coverage as { path: string }[]).filter((entry) => entry.path !== "cli/main.ts") }));
    expect(codes(result)).toEqual(["review-coverage-missing"]);
    expect(result.failures[0]?.path).toBe("cli/main.ts");
  });

  it("fails when coverage repeats a file", () => {
    const { result } = review((record) => ({ ...record, coverage: [...(record.coverage as unknown[]), { path: "src/main.ts", read: true }] }));
    expect(codes(result)).toEqual(["review-coverage-repeated"]);
  });

  it("fails when coverage names a file outside the list", () => {
    const { result } = review((record) => ({ ...record, coverage: [...(record.coverage as unknown[]), { path: "src/ghost.ts", read: true }] }));
    expect(codes(result)).toEqual(["review-coverage-extra"]);
  });

  it("fails when an entry's read is not a boolean", () => {
    const { result } = review((record) => ({ ...record, coverage: (record.coverage as object[]).map((entry, index) => (index === 0 ? { ...entry, read: "yes" } : entry)) }));
    expect(codes(result)).toEqual(["review-record-malformed"]);
  });

  it("fails for a record without the machine-readable block, with two blocks, or with broken JSON", () => {
    for (const text of ["# prose only\n", `${recordText({})}${recordText({})}`, "<!-- guard-review:v1 -->\n{not json\n<!-- /guard-review -->\n"]) {
      const root = reviewFixture();
      const tree = okTree(checker, root);
      writeRepoFile(root, `${checker.REVIEW_RECORD_DIR}/review-final-${tree.t8}.md`, text);
      commitAll(root, "record");
      const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
      expect(codes(result), JSON.stringify(text.slice(0, 30))).toEqual(["review-record-malformed"]);
    }
  });

  it("fails when T computed from the objects of reviewedCommit differs from the recorded tree", () => {
    const root = reviewFixture();
    const reviewed = head(root);
    writeRepoFile(root, "src/main.ts", "export const main = 2;\n");
    commitAll(root, "change after the reviewed commit");
    const committed = commitReview(checker, root, { reviewedCommit: reviewed });
    const result = checker.checkReviewRecord({ root, tree: committed.tree, buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(codes(result)).toEqual(["review-reviewed-tree-differs"]);
  });

  it("fails when reviewedCommit is not a commit, is not a full id, or is not an ancestor of the record's commit", () => {
    const unknown = review((record) => ({ ...record, reviewedCommit: "0".repeat(40) }));
    expect(codes(unknown.result)).toEqual(["review-commit-unknown"]);
    const short = review((record) => ({ ...record, reviewedCommit: "abc1234" }));
    expect(codes(short.result)).toEqual(["review-commit-invalid"]);

    const root = reviewFixture();
    git(root, ["checkout", "-q", "-b", "side"]);
    git(root, ["commit", "-q", "--allow-empty", "-m", "side"]);
    const side = head(root);
    git(root, ["checkout", "-q", "main"]);
    const committed = commitReview(checker, root, { reviewedCommit: side });
    const result = checker.checkReviewRecord({ root, tree: committed.tree, buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(codes(result)).toEqual(["review-commit-not-ancestor"]);
  });

  it("fails when the record's last commit also changed another file", () => {
    const root = reviewFixture();
    const tree = okTree(checker, root);
    writeRepoFile(root, `${checker.REVIEW_RECORD_DIR}/review-final-${tree.t8}.md`, recordText(baseRecord(tree, head(root))));
    writeRepoFile(root, "notes.txt", "also changed\n");
    commitAll(root, "record and another file");
    const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(codes(result)).toEqual(["review-commit-extra-files"]);
  });

  it("fails when the checker file is not in the tree", () => {
    const root = reviewFixture({ [FIXTURE_CHECKER]: null });
    const committed = commitReview(checker, root, { mutate: (record) => ({ ...record, checkerSha256: "d".repeat(64) }) });
    const result = checker.checkReviewRecord({ root, tree: committed.tree, buildSha256: BUILD_SHA, environment: isolatedEnvironment().env });
    expect(codes(result)).toEqual(["review-checker-mismatch"]);
  });
});

describe("item A in the command line", () => {
  const prepare = () => {
    const root = reviewFixture();
    return { root, tmpRoot: tempDir("guard-export-parent-"), commands: stubCommands(), environment: isolatedEnvironment().env };
  };
  const bOf = (run: ReturnType<typeof prepare>): string => {
    const built = checker.buildCleanExport({ root: run.root, commit: head(run.root), commands: run.commands, tmpRoot: run.tmpRoot });
    if (!built.ok) throw new Error(JSON.stringify(built.failures));
    return built.buildSha256;
  };

  it("a default run without a record exits 1 and names the missing record (items D and E are judged too since task 4.4c)", () => {
    const run = prepare();
    const io = captureIo();
    expect(checker.runCli([], { ...run, ...io.io })).toBe(1);
    expect(io.err()).toContain("review-record-missing");
    expect(io.err()).toContain("result: fail (A, B, C, E)");
    expect(io.out()).toContain("item-a: fail");
    expect(io.out()).toContain("item-d: pass");
  });

  it("a default run with a passing record prints item A; item B has no operator record here (exit 1), so the run is not a pass", () => {
    const run = prepare();
    const b = bOf(run);
    const committed = commitReview(checker, run.root, { mutate: (record) => ({ ...record, buildSha256: b }) });
    const io = captureIo();
    expect(checker.runCli([], { ...run, ...io.io }), io.err()).toBe(1);
    expect(io.out()).toContain("item-a: pass");
    expect(io.out()).toContain("item-a-form: git-history");
    expect(io.out()).toContain(`item-a-commit: ${committed.commit}`);
    expect(io.out()).toContain("item-a-commit-count: 1");
    expect(io.out()).toContain("item-b: fail");
    expect(io.err()).toContain("operator-record-missing");
    expect(io.err()).toContain("result: fail (B, C, E)");
  });

  it("a record whose buildSha256 is not B fails item A in a default run (exit 1)", () => {
    const run = prepare();
    commitReview(checker, run.root);
    const io = captureIo();
    expect(checker.runCli([], { ...run, ...io.io })).toBe(1);
    expect(io.err()).toContain("review-build-mismatch");
  });

  it("--json prints one JSON document with T, B and the item states and does not claim a pass (item B: record missing here)", () => {
    const run = prepare();
    const b = bOf(run);
    commitReview(checker, run.root, { mutate: (record) => ({ ...record, buildSha256: b }) });
    const io = captureIo();
    expect(checker.runCli(["--json"], { ...run, ...io.io })).toBe(1);
    const document = JSON.parse(io.out());
    expect(document.pass).toBe(false);
    expect(document.tree.t8).toBe(okTree(checker, run.root).t8);
    expect(document.build.sha256).toBe(b);
    expect(document.items.A.status).toBe("pass");
    expect(document.items.A.form).toBe("git-history");
    expect(document.items.B.status).toBe("fail");
    expect(document.items.B.failures[0].code).toBe("operator-record-missing");
    expect(document.items.C.status).toBe("fail");
    expect(document.items.C.failures[0].code).toBe("phone-record-missing");
    expect(document.items.D.status).toBe("pass");
    expect(document.items.E.status).toBe("fail");
  });

  it("--json with a failing item A exits 1 and lists the failure", () => {
    const run = prepare();
    const io = captureIo();
    expect(checker.runCli(["--json"], { ...run, ...io.io })).toBe(1);
    const document = JSON.parse(io.out());
    expect(document.items.A.status).toBe("fail");
    expect(document.items.A.failures[0].code).toBe("review-record-missing");
  });

  it("exits 2 without building when IPFS_SYNC_ALLOWED_SIGNERS is set, for a default run and for --build", () => {
    const run = prepare();
    for (const argv of [[], ["--build"], ["--json"]]) {
      const io = captureIo();
      const code = checker.runCli(argv, { ...run, ...io.io, environment: { ...run.environment, IPFS_SYNC_ALLOWED_SIGNERS: "/tmp/anything" } });
      expect(code, argv.join(" ")).toBe(2);
      expect(io.err()).toContain("IPFS_SYNC_ALLOWED_SIGNERS");
      expect(io.out()).not.toContain("build-sha256");
    }
  });

  it("--build builds the record's reviewedCommit when its scoped tree equals HEAD's, and HEAD otherwise", () => {
    const run = prepare();
    const reviewed = head(run.root);
    const committed = commitReview(checker, run.root);
    const state = () => JSON.parse(readFileSync(join(run.root, checker.GUARD_BUILD_FILE), "utf8")) as { commit: string; treeSha256: string };
    expect(checker.runCli(["--build"], { ...run, ...captureIo().io })).toBe(0);
    expect(state().commit).toBe(reviewed);
    expect(state().treeSha256).toBe(committed.tree.treeSha256);

    const other = prepare();
    const first = head(other.root);
    writeRepoFile(other.root, "src/main.ts", "export const main = 2;\n");
    commitAll(other.root, "scoped change");
    commitReview(checker, other.root, { reviewedCommit: first });
    expect(checker.runCli(["--build"], { ...other, ...captureIo().io })).toBe(0);
    const otherState = JSON.parse(readFileSync(join(other.root, checker.GUARD_BUILD_FILE), "utf8")) as { commit: string };
    expect(otherState.commit).toBe(head(other.root));
  });
});
