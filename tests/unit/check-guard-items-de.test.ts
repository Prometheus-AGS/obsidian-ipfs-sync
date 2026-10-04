import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, captureIo, git, removeRepos, tempDir, writeRepoFile } from "../helpers/guard-repo.ts";
import {
  CLEAN_AUDIT,
  EXPORT_DIR,
  MOMENT_ADVISORY,
  OFFLINE_AUDIT,
  auditWith,
  checklistHashes,
  checklistText,
  documentFiles,
  finalFixture,
  judgeInputs,
  loadFinalChecker,
  passingReport,
  ranTests,
  recommitRecord,
  withFile,
  NOW,
  type DistScan,
  type FinalChecker,
  type FinalFixture,
  type FinalFixtureOptions,
  type FindingLike,
  type HookIsolationLike,
  type ItemResult,
} from "../helpers/guard-final.ts";
import { commitAll } from "../helpers/guard-repo.ts";
import { sha256 } from "../helpers/guard-review.ts";

// mvp-07b task 4.4c: item D (distribution bundles and hooks), item E (the checklist held in the checker), and the exit
// codes (design 9 "Item D", "Item E", "Checker behaviour"; spec guard-evidence "Item D", "Item E", "Checker behaviour").
// The judges are pure functions and are tested directly; a few command-line cases run the whole checker over a temporary
// repository with a stub build, a stub test runner and a stub audit. Nothing builds, tests or audits the real repository.

let checker: FinalChecker;
beforeAll(async () => {
  checker = await loadFinalChecker();
});
afterAll(removeRepos);

const codes = (result: { failures: readonly { code: string }[] }): string[] => result.failures.map((failure) => failure.code);
const firstPath = (): string => checker.CHECKLIST_TESTS[0]?.path as string;

describe("constants held in the checker", () => {
  it("names the checklist test files by path with a minimum count, covering every area of the spec", () => {
    const paths = checker.CHECKLIST_TESTS.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const entry of checker.CHECKLIST_TESTS) {
      expect(entry.path, entry.path).toMatch(/^tests\/unit\/[a-z0-9-]+\.test\.ts$/);
      expect(Number.isInteger(entry.min) && entry.min >= 1, entry.path).toBe(true);
    }
    for (const area of ["removal-guard", "prune-history", "encrypted-transfer", "history-names", "guard-permissive", "plaintext-removal", "key-accept", "slot-acceptance", "crypto-key-slots-rewrap", "maintenance-journal"]) {
      expect(
        paths.some((path) => path.includes(area)),
        area,
      ).toBe(true);
    }
  });

  it("holds minimums that the files in this repository meet (guard-permissive.test.ts exists only on the release branch, task 6.2)", () => {
    const missing: string[] = [];
    for (const entry of checker.CHECKLIST_TESTS) {
      const file = join(REPO_ROOT, entry.path);
      if (!existsSync(file)) {
        missing.push(entry.path);
        continue;
      }
      const count = [...readFileSync(file, "utf8").matchAll(/^\s*(?:it|test)(?:\.each\([^)]*\))?\(/gm)].length;
      expect(count, entry.path).toBeGreaterThanOrEqual(entry.min);
    }
    expect(missing.filter((path) => !path.endsWith("guard-permissive.test.ts"))).toEqual([]);
  });

  it("holds the limit sentences of the spec as single-line exact strings, and the attestation sentence is a known answer", () => {
    expect(checker.LIMIT_SENTENCES.map((sentence) => sentence.id)).toEqual(["silent-corruption", "concurrent-publish", "attestations", "defect-loop", "floor-limits", "rewrap-no-revoke"]);
    for (const sentence of checker.LIMIT_SENTENCES) {
      expect(sentence.text, sentence.id).not.toMatch(/[\n\r\t]/);
      expect(sentence.text.length, sentence.id).toBeGreaterThan(30);
    }
    const attestations = checker.LIMIT_SENTENCES.find((sentence) => sentence.id === "attestations");
    expect(attestations?.text).toBe("The review record, the operator-run record and the phone-timing record are attestations, not proofs.");
    expect(checker.DOCUMENT_FILES).toEqual(["README.md", "CHANGELOG.md", "DESIGN.md", "docs/operator/encrypted-vault.md"]);
  });
});

describe("item E: the checklist tests", () => {
  const judge = (change: { tests?: ReturnType<typeof ranTests>; hashes?: Record<string, string | null>; record?: { checklistTests: Record<string, string> } | undefined } = {}) => {
    const inputs = judgeInputs(checker);
    const record = "record" in change ? change.record : inputs.record;
    return checker.judgeChecklistRun({ tests: change.tests ?? inputs.tests, hashes: change.hashes ?? inputs.hashes, record, exportDir: EXPORT_DIR });
  };
  const report = () => passingReport(checker);

  it("passes when every named file ran at least its minimum, everything passed and the hashes equal the record's", () => {
    const result = judge();
    expect(result.failures).toEqual([]);
    expect(result.files.map((file) => file.path)).toEqual(checker.CHECKLIST_TESTS.map((entry) => entry.path));
    for (const file of result.files) expect(file.passed, file.path).toBe(checker.CHECKLIST_TESTS.find((entry) => entry.path === file.path)?.min);
  });

  it("accepts a file that ran more tests than its minimum", () => {
    const more = withFile(report(), firstPath(), (file) => ({ ...file, assertionResults: [...file.assertionResults, { title: "extra", status: "passed" }] }));
    expect(judge({ tests: ranTests(more) }).failures).toEqual([]);
  });

  it("fails a test file that differs from the hash in the review record, and names the file", () => {
    const hashes = { ...checklistHashes(checker), [firstPath()]: sha256("a weakened file") };
    const result = judge({ hashes });
    expect(codes(result)).toEqual(["checklist-hash-mismatch"]);
    expect(result.failures[0]?.path).toBe(firstPath());
  });

  it("fails a skipped test", () => {
    const skipped = withFile(report(), firstPath(), (file) => ({ ...file, assertionResults: [...file.assertionResults, { title: "skipped one", status: "skipped" }] }));
    const result = judge({ tests: ranTests({ ...skipped, numPendingTests: 1 }) });
    expect(codes(result)).toEqual(["tests-not-passed", "tests-todo-or-pending"]);
    expect(result.failures[0]?.path).toBe(firstPath());
  });

  it("fails a todo test", () => {
    const todo = withFile(report(), firstPath(), (file) => ({ ...file, assertionResults: [...file.assertionResults, { title: "todo one", status: "todo" }] }));
    expect(codes(judge({ tests: ranTests({ ...todo, numTodoTests: 1 }) }))).toEqual(["tests-not-passed", "tests-todo-or-pending"]);
  });

  it("fails an `only` test: its siblings are reported as skipped, so the file runs too few passing tests", () => {
    const only = withFile(report(), firstPath(), (file) => ({ ...file, assertionResults: file.assertionResults.map((test, index) => (index === 0 ? test : { ...test, status: "skipped" })) }));
    const result = judge({ tests: ranTests({ ...only, numPendingTests: 3 }) });
    expect(codes(result)).toContain("tests-not-passed");
    expect(codes(result)).toContain("checklist-too-few");
  });

  it("fails a failed test and a suite that failed to load", () => {
    const failed = withFile(report(), firstPath(), (file) => ({ ...file, assertionResults: file.assertionResults.map((test, index) => (index === 0 ? { ...test, status: "failed" } : test)) }));
    expect(codes(judge({ tests: ranTests({ ...failed, numFailedTests: 1 }) }))).toContain("tests-not-passed");
    const broken = withFile(report(), firstPath(), (file) => ({ ...file, status: "failed", assertionResults: [] }));
    expect(codes(judge({ tests: ranTests(broken) }))).toContain("tests-not-passed");
  });

  it("fails a file that ran fewer tests than its minimum, alone", () => {
    const fewer = withFile(report(), firstPath(), (file) => ({ ...file, assertionResults: file.assertionResults.slice(1) }));
    const result = judge({ tests: ranTests(fewer) });
    expect(codes(result)).toEqual(["checklist-too-few"]);
    expect(result.failures[0]?.path).toBe(firstPath());
  });

  it("fails a named path that is not in the report (the runner matched no file)", () => {
    const result = judge({ tests: ranTests(withFile(report(), firstPath(), () => undefined)) });
    expect(codes(result)).toEqual(["checklist-file-not-run"]);
  });

  it("fails a named path that is no file in the export, and says so once", () => {
    const hashes = { ...checklistHashes(checker), [firstPath()]: null };
    const result = judge({ hashes, tests: ranTests(withFile(report(), firstPath(), () => undefined)) });
    expect(codes(result)).toEqual(["checklist-file-missing"]);
  });

  it("fails a review record whose checklistTests omits a path the checker requires", () => {
    const { [firstPath()]: _omitted, ...rest } = checklistHashes(checker);
    expect(codes(judge({ record: { checklistTests: rest } }))).toEqual(["checklist-record-missing-path"]);
  });

  it("fails when there is no record to compare with, once", () => {
    expect(codes(judge({ record: undefined }))).toEqual(["checklist-record-unavailable"]);
  });

  it("fails when the runner exited non-zero even though the report reads clean", () => {
    expect(codes(judge({ tests: ranTests(report(), { status: 1, output: "1 failed" }) }))).toEqual(["tests-run-failed"]);
  });

  it("fails when no report was written or the report is not JSON", () => {
    expect(codes(judge({ tests: ranTests(undefined, { status: 1, output: "vitest: not found" }) }))).toContain("tests-no-report");
    expect(codes(judge({ tests: ranTests("not json") }))).toEqual(["tests-report-malformed"]);
    expect(codes(judge({ tests: ranTests({ numTotalTests: 1 } as never) }))).toEqual(["tests-report-malformed"]);
  });

  it("fails with tests-skipped when the run was skipped (--no-tests), whatever else is true", () => {
    expect(codes(judge({ tests: { skipped: true } }))).toEqual(["tests-skipped"]);
  });

  it("reads file names relative to the export directory", () => {
    const result = judge({ tests: ranTests(passingReport(checker, `${EXPORT_DIR}/`.replace(/\/$/, ""))) });
    expect(result.failures).toEqual([]);
    const elsewhere = passingReport(checker, "/somewhere/else");
    expect(codes(judge({ tests: ranTests(elsewhere) })).every((code) => code === "checklist-file-not-run")).toBe(true);
  });
});

describe("item E: pnpm audit against the accepted findings of the record", () => {
  const accepted = (overrides: Partial<FindingLike> = {}): FindingLike => ({
    id: "F-9",
    severity: "medium",
    status: "accepted",
    acceptedBecause: "dev-only",
    advisory: "GHSA-4p3w-j4w9-5jqw",
    acceptedAt: "2026-09-30",
    ...overrides,
  });
  const audit = (stdout: string, status = 0) => ({ stdout, status, output: stdout });

  it("passes when the audit reports nothing", () => {
    expect(checker.judgeAudit({ audit: audit(CLEAN_AUDIT), findings: [], now: NOW })).toEqual({ failures: [], advisories: 0 });
  });

  it("fails a new advisory that no accepted finding names, and names the advisory", () => {
    const result = checker.judgeAudit({ audit: audit(auditWith(MOMENT_ADVISORY), 1), findings: [], now: NOW });
    expect(codes(result)).toEqual(["audit-unaccepted"]);
    expect(result.failures[0]?.detail).toContain("GHSA-4p3w-j4w9-5jqw");
    expect(result.failures[0]?.detail).toContain("moment");
  });

  it("passes an advisory that a dated accepted finding names, by its GHSA id (any case), its numeric id or its URL", () => {
    for (const advisory of ["GHSA-4p3w-j4w9-5jqw", "ghsa-4P3W-J4W9-5JQW", "1111111", "https://github.com/advisories/GHSA-4p3w-j4w9-5jqw", "CVE-2026-0001"]) {
      const result = checker.judgeAudit({ audit: audit(auditWith(MOMENT_ADVISORY), 1), findings: [accepted({ advisory })], now: NOW });
      expect(result, advisory).toEqual({ failures: [], advisories: 1 });
    }
  });

  it("does not count a finding that is fixed or open, or one that names another advisory", () => {
    for (const finding of [accepted({ status: "fixed" }), accepted({ status: "open" }), accepted({ advisory: "GHSA-0000-0000-0000" })]) {
      expect(codes(checker.judgeAudit({ audit: audit(auditWith(MOMENT_ADVISORY), 1), findings: [finding], now: NOW }))).toEqual(["audit-unaccepted"]);
    }
  });

  it("fails an acceptance without a valid date, or dated in the future", () => {
    for (const acceptedAt of [undefined, "", "not a date", "2027-01-01"]) {
      const finding = accepted(acceptedAt === undefined ? { acceptedAt: undefined } : { acceptedAt });
      expect(codes(checker.judgeAudit({ audit: audit(auditWith(MOMENT_ADVISORY), 1), findings: [finding], now: NOW })), String(acceptedAt)).toEqual(["audit-acceptance-undated"]);
    }
  });

  it("reports every unaccepted advisory", () => {
    const other = { ...MOMENT_ADVISORY, id: 2222222, github_advisory_id: "GHSA-aaaa-bbbb-cccc", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", cves: [] };
    const result = checker.judgeAudit({ audit: audit(auditWith(MOMENT_ADVISORY, other), 1), findings: [], now: NOW });
    expect(codes(result)).toEqual(["audit-unaccepted", "audit-unaccepted"]);
  });

  it("fails rather than passes when the registry cannot be reached, the output is not an audit document or it is empty", () => {
    for (const stdout of [OFFLINE_AUDIT, "", "{}", JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "offline" } }), JSON.stringify({ advisories: [] }), "[]"]) {
      expect(codes(checker.judgeAudit({ audit: audit(stdout, 1), findings: [accepted()], now: NOW })), stdout).toEqual(["audit-unavailable"]);
    }
  });
});

describe("item E: the limit sentences and the documentation hashes", () => {
  const docs = (options = {}) => documentFiles(checker, options);
  const check = (files: Record<string, string>) => checker.checkLimitSentences({ readme: files["README.md"] as string, design: files["DESIGN.md"] as string });

  it("passes when README and DESIGN section 8 hold every sentence", () => {
    expect(check(docs()).failures).toEqual([]);
  });

  it("finds a sentence that the document wraps over several lines or indents (whitespace is normalised, nothing else)", () => {
    const wrapped = checker.LIMIT_SENTENCES.map((sentence) => sentence.text.replace(/ (\w+) /, "\n   $1\n  "));
    expect(check(docs({ readme: wrapped, design: wrapped })).failures).toEqual([]);
    const changed = checker.LIMIT_SENTENCES.map((sentence) => sentence.text.replace("not", "never"));
    expect(codes(check(docs({ readme: changed }))).length).toBeGreaterThan(0);
  });

  it("fails a sentence missing from the README, naming the file and the sentence", () => {
    const [, ...rest] = checker.LIMIT_SENTENCES.map((sentence) => sentence.text);
    const result = check(docs({ readme: rest }));
    expect(codes(result)).toEqual(["limit-sentence-missing"]);
    expect(result.failures[0]?.path).toBe("README.md");
    expect(result.failures[0]?.detail).toContain("silent-corruption");
  });

  it("fails a sentence that is in DESIGN but outside section 8, and a DESIGN without a section 8", () => {
    expect(codes(check(docs({ designPlacement: "section-9" })))).toEqual(Array(checker.LIMIT_SENTENCES.length).fill("limit-sentence-missing"));
    expect(codes(check(docs({ designPlacement: "none" })))).toEqual(["design-section-8-missing"]);
  });
});

describe("item D: distribution bundles and hooks", () => {
  const clean: DistScan = { sentinels: ["src/crypto/testing/a.ts", "src/crypto/testing/b.ts"], dist: { ok: true, checked: ["dist/plugin/main.js", "dist/cli/ipfs-sync.mjs"], missing: [], violations: [] } };
  const itemD = (distScan: DistScan, hookIsolation?: HookIsolationLike): ItemResult => checker.checkItemD({ distScan, ...(hookIsolation ? { hookIsolation } : {}) });

  it("passes when both bundles are clean, every testing module carries a sentinel and the allowlist entry is documented", () => {
    const result = itemD(clean);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.evidence).toMatchObject({ bundlesChecked: ["dist/plugin/main.js", "dist/cli/ipfs-sync.mjs"], sentinelModules: 2, allowlist: ["tools/feature-op-*.mjs"] });
  });

  it("fails a sentinel in a bundle, naming the bundle", () => {
    const result = itemD({ ...clean, dist: { ok: false, checked: ["dist/plugin/main.js", "dist/cli/ipfs-sync.mjs"], missing: [], violations: ["dist/plugin/main.js contains the sentinel of src/crypto/testing/a.ts"] } });
    expect(codes(result)).toEqual(["dist-bundle-violation"]);
    expect(result.failures[0]?.detail).toContain("dist/plugin/main.js");
  });

  it("fails a bundle that was not built", () => {
    expect(codes(itemD({ ...clean, dist: { ok: true, checked: ["dist/plugin/main.js"], missing: ["dist/cli/ipfs-sync.mjs"], violations: [] } }))).toEqual(["dist-bundle-missing"]);
  });

  it("fails a testing file without a sentinel, and does not claim the bundles were scanned", () => {
    const result = itemD({ sentinelError: "src/crypto/testing/raw.ts must declare exactly one sentinel string, found 0" });
    expect(codes(result)).toEqual(["sentinel-missing"]);
    expect(result.failures[0]?.detail).toContain("raw.ts");
  });

  it("fails when the allowlist entry for tools/feature-op-*.mjs is gone, or when it admits a tool that it should not", () => {
    const gone: HookIsolationLike = { TOOL_TESTING_IMPORT_ALLOWLIST: [], isToolTestingImportAllowed: () => false };
    expect(codes(itemD(clean, gone))).toEqual(["allowlist-entry-missing"]);
    const everything: HookIsolationLike = { TOOL_TESTING_IMPORT_ALLOWLIST: ["tools/feature-op-*.mjs"], isToolTestingImportAllowed: () => true };
    expect(codes(itemD(clean, everything))).toEqual(["allowlist-entry-missing"]);
  });
});

/* ---------- the whole checker over a temporary repository ---------- */

interface JsonDocument {
  readonly pass: boolean;
  readonly complete: boolean;
  readonly tree: { readonly sha256: string };
  readonly items: Record<string, { readonly status: string; readonly failures: readonly { readonly code: string }[]; readonly evidence: Record<string, unknown> }>;
}

const execute = (fixture: FinalFixture, argv: readonly string[] = [], context: Record<string, unknown> = {}) => {
  const io = captureIo();
  const code = fixture.checker.runCli(argv, { ...fixture.context, ...context, ...io.io } as never);
  return { code, out: io.out(), err: io.err() };
};
const executeJson = (fixture: FinalFixture, argv: readonly string[] = []) => {
  const run = execute(fixture, ["--json", ...argv]);
  return { ...run, document: JSON.parse(run.out) as JsonDocument };
};
const itemCodes = (document: JsonDocument, item: string): string[] => (document.items[item]?.failures ?? []).map((failure) => failure.code);
const fixtureOf = (options: FinalFixtureOptions = {}): FinalFixture => finalFixture(checker, options);

describe("exit code 0 only when T, B and items A to E pass", () => {
  it("passes a complete repository, prints every item, writes the documentation hashes into the evidence, runs the tests in the export under the scrubbed environment, and writes nothing in the repository", () => {
    const fixture = fixtureOf();
    const perUser = fixture.context.environment.HOME as string;
    const snapshot = () => readdirSync(perUser, { recursive: true }).map(String).sort();
    const before = { status: git(fixture.context.root, ["status", "--porcelain", "--ignored"]), perUser: snapshot() };
    const run = execute(fixture, [], { environment: { ...fixture.context.environment, NODE_OPTIONS: "--max-old-space-size=64", OBSIDIAN_PLUGIN_DIR: "/tmp/elsewhere", ESBUILD_BINARY_PATH: "/tmp/x" } });
    expect(run.code, run.err).toBe(0);
    for (const item of ["a", "b", "c", "d", "e"]) expect(run.out, item).toContain(`item-${item}: pass`);
    expect(run.out).toContain("result: pass");
    for (const path of checker.DOCUMENT_FILES) {
      const text = readFileSync(join(fixture.context.root, path), "utf8");
      expect(run.out).toContain(`item-e-document: ${path} ${createHash("sha256").update(text).digest("hex")}`);
    }
    expect(run.out).toContain("item-d-bundles: dist/plugin/main.js, dist/cli/ipfs-sync.mjs");
    expect(run.err).toBe("");

    // The tests ran in the clean export with the JSON report in a temporary file outside the repository and the export.
    const echo = JSON.parse(readFileSync(fixture.echoPath, "utf8")) as { args: string[]; cwd: string; env: string[] };
    const output = echo.args.find((argument) => argument.startsWith("--outputFile="))?.slice("--outputFile=".length) as string;
    expect(echo.args.slice(0, 1 + checker.CHECKLIST_TESTS.length)).toEqual(["run", ...checker.CHECKLIST_TESTS.map((entry) => entry.path)]);
    expect(echo.args).toContain("--reporter=json");
    expect(output.startsWith(`${echo.cwd}/`)).toBe(false);
    expect(output.startsWith(`${fixture.context.root}/`)).toBe(false);
    expect(output.startsWith(fixture.context.tmpRoot)).toBe(true);
    expect(echo.cwd.startsWith(fixture.context.tmpRoot)).toBe(true);
    for (const name of ["NODE_OPTIONS", "OBSIDIAN_PLUGIN_DIR", "ESBUILD_BINARY_PATH"]) expect(echo.env, name).not.toContain(name);
    expect(echo.env).toContain("CI");

    // A default run writes nothing in the repository, leaves no export behind and changes nothing in the per-user folder.
    expect(before.status).toBe("");
    expect(git(fixture.context.root, ["status", "--porcelain", "--ignored"])).toBe("");
    expect(existsSync(join(fixture.context.root, "dist"))).toBe(false);
    expect(snapshot()).toEqual(before.perUser);
    expect(readdirSync(fixture.context.tmpRoot)).toEqual([]);
  });

  it("--json reports pass and complete, and the evidence of items D and E", () => {
    const fixture = fixtureOf({ files: { "src/crypto/testing/hook.ts": 'export const raw = "TEST_ONLY_SENTINEL_HOOK";\n' } });
    const { code, document } = executeJson(fixture);
    expect(code).toBe(0);
    expect(document.pass).toBe(true);
    expect(document.complete).toBe(true);
    for (const item of ["A", "B", "C", "D", "E"]) expect(document.items[item]?.status, item).toBe("pass");
    expect(document.items.D?.evidence).toMatchObject({ bundlesChecked: ["dist/plugin/main.js", "dist/cli/ipfs-sync.mjs"], sentinelModules: 1 });
    const evidence = document.items.E?.evidence as { documents: Record<string, string>; tests: { path: string; min: number; passed: number }[]; advisories: number; testsRun: boolean };
    expect(Object.keys(evidence.documents)).toEqual([...checker.DOCUMENT_FILES]);
    expect(evidence.documents["README.md"]).toBe(sha256(readFileSync(join(fixture.context.root, "README.md"), "utf8")));
    expect(evidence.tests.map((entry) => entry.path)).toEqual(checker.CHECKLIST_TESTS.map((entry) => entry.path));
    expect(evidence.testsRun).toBe(true);
    expect(evidence.advisories).toBe(0);
  });
});

describe("exit code 1: each item failing alone", () => {
  it.each([
    ["a sentinel in a bundle", { files: { "src/main.ts": "export const x = 'TEST_ONLY_SENTINEL_X';\n" } }, "dist-bundle-violation"],
    ["a testing file without a sentinel", { files: { "src/crypto/testing/raw.ts": "export const raw = 1;\n" } }, "sentinel-missing"],
  ] as const)("item D: %s", (_label, options, code) => {
    const fixture = fixtureOf(options);
    const { code: exit, document } = executeJson(fixture);
    expect(exit).toBe(1);
    expect(document.pass).toBe(false);
    expect(itemCodes(document, "D")).toEqual([code]);
    for (const item of ["A", "B", "C", "E"]) expect(document.items[item]?.status, item).toBe("pass");
  });

  it.each([
    ["a skipped test", { report: (r: ReturnType<typeof passingReport>) => ({ ...withFile(r, firstPathOf(), (f) => ({ ...f, assertionResults: [...f.assertionResults, { title: "s", status: "skipped" }] })), numPendingTests: 1 }) }, ["tests-not-passed", "tests-todo-or-pending"]],
    ["an offline audit", { audit: OFFLINE_AUDIT, auditStatus: 1 }, ["audit-unavailable"]],
    ["a sentence missing from the README", { documents: { readme: ["only one sentence"] } }, Array(6).fill("limit-sentence-missing")],
    [
      "a record whose checklistTests omits a required path",
      { mutateRecord: (record: Record<string, unknown>) => ({ ...record, checklistTests: Object.fromEntries(Object.entries(record.checklistTests as object).filter(([path]) => path !== firstPathOf())) }) },
      ["checklist-record-missing-path"],
    ],
  ] as const)("item E: %s", (_label, options, expected) => {
    const fixture = fixtureOf(options as FinalFixtureOptions);
    const { code, document } = executeJson(fixture);
    expect(code).toBe(1);
    expect(document.pass).toBe(false);
    expect(itemCodes(document, "E")).toEqual(expected);
    for (const item of ["A", "B", "C", "D"]) expect(document.items[item]?.status, item).toBe("pass");
  });

  it("item E: a test file changed after the reviewed commit fails against the record (the export holds the reviewed bytes)", () => {
    const fixture = fixtureOf();
    const path = firstPathOf();
    writeRepoFile(fixture.context.root, path, `${checklistText(path)}// weakened\n`);
    commitAll(fixture.context.root, "change a test file");
    recommitRecord(fixture, (record) => ({ ...record, checklistTests: { ...(record.checklistTests as object), [path]: sha256(`${checklistText(path)}// weakened\n`) } }));
    const { code, document } = executeJson(fixture);
    expect(code).toBe(1);
    expect(document.items.A?.status).toBe("pass");
    expect(itemCodes(document, "E")).toEqual(["checklist-hash-mismatch"]);
  });

  it("an advisory accepted by a later commit of the record passes item E with T unchanged", () => {
    const fixture = fixtureOf({ audit: auditWith(MOMENT_ADVISORY), auditStatus: 1 });
    // The "unaccepted" half is proved without a second full run by the judgeAudit cases above ("fails a new advisory that no
    // accepted finding names"); every full run costs two builds, so this test runs the whole checker once, after the commit.
    const treeBefore = fixture.tree.treeSha256;
    recommitRecord(fixture, (record) => ({
      ...record,
      counts: { critical: 0, high: 0, medium: 1, low: 0 },
      findings: [{ id: "F-ADV", severity: "medium", status: "accepted", acceptedBecause: "dev-only path", advisory: "GHSA-4p3w-j4w9-5jqw", acceptedAt: "2026-09-30", summary: "moment" }],
    }));
    const second = executeJson(fixture);
    expect(second.code, second.err).toBe(0);
    expect(second.document.tree.sha256).toBe(treeBefore);
    expect(second.document.items.E?.status).toBe("pass");
    expect(second.document.items.E?.evidence).toMatchObject({ advisories: 1 });
  });

  it("an early run reports items D and E on their own merits when the operator record and the phone record are not there", () => {
    const fixture = fixtureOf({ operator: false, phone: false });
    const { code, document } = executeJson(fixture);
    expect(code).toBe(1);
    expect(document.items.A?.status).toBe("pass");
    expect(itemCodes(document, "B")).toEqual(["operator-record-missing"]);
    expect(itemCodes(document, "C")).toEqual(["phone-record-missing"]);
    expect(document.items.D?.status).toBe("pass");
    expect(document.items.E?.status).toBe("pass");
  });
});

describe("--no-tests is never a pass", () => {
  it("fails item E with tests-skipped, does not start the test runner, and still judges everything else", () => {
    const fixture = fixtureOf();
    // One full run, in the JSON form the release tool reads (a second run for the human form doubled the cost of this case;
    // the human form of a failing item is covered by the other "exit code 1" cases).
    const { code, document } = executeJson(fixture, ["--no-tests"]);
    expect(code).toBe(1);
    expect(document.pass).toBe(false);
    expect(itemCodes(document, "E")).toEqual(["tests-skipped"]);
    for (const item of ["A", "B", "C", "D"]) expect(document.items[item]?.status, item).toBe("pass");
    expect(existsSync(fixture.echoPath)).toBe(false);
    expect(document.items.E?.evidence).toMatchObject({ testsRun: false });
  });
});

describe("exit code 2 and the options", () => {
  // No repository is needed: the options are judged before anything is read.
  const bare = (argv: readonly string[], environment: Record<string, string | undefined> = { HOME: tempDir("guard-home-") }) => {
    const io = captureIo();
    const code = checker.runCli(argv, { root: tempDir(), environment, ...io.io });
    return { code, out: io.out(), err: io.err() };
  };

  it.each([["--skip-e"], ["--skip"], ["--no-audit"], ["--only=A"], ["--items=A,B"], ["--force"], ["--no-tests", "--build"], ["--no-tests", "--print-tree-hash"], ["--json", "--build"], ["--no-tests", "--no-tests"], ["--bogus"]])(
    "%s is a usage error: exit 2, nothing printed on standard output, and the usage lists no option that skips an item",
    (...argv) => {
      const run = bare(argv);
      expect(run.code).toBe(2);
      expect(run.out).toBe("");
      expect(run.err).toContain("usage:");
      const usage = run.err.slice(run.err.indexOf("usage:"));
      expect(usage).toContain("--no-tests");
      expect(usage).not.toMatch(/--skip|--no-audit|--only|--force/);
    },
  );

  it("exits 2 when IPFS_SYNC_ALLOWED_SIGNERS is set, and when the directory is not a repository", () => {
    const override = bare([], { HOME: tempDir("guard-home-"), IPFS_SYNC_ALLOWED_SIGNERS: "/tmp/anything" });
    expect(override.code).toBe(2);
    expect(override.err).toContain("IPFS_SYNC_ALLOWED_SIGNERS");
    const elsewhere = bare([]);
    expect(elsewhere.code).toBe(2);
    expect(elsewhere.err).toContain("checker error");
  });
});

describe("--build keeps its meaning", () => {
  it("installs the verified outputs without running the tests or the audit", () => {
    const fixture = fixtureOf();
    const run = execute(fixture, ["--build"]);
    expect(run.code, run.err).toBe(0);
    expect(existsSync(join(fixture.context.root, "dist", "plugin", "main.js"))).toBe(true);
    expect(existsSync(fixture.echoPath)).toBe(false);
  });

  it("refuses to install a bundle that holds a sentinel (item D), and writes no dist/", () => {
    const fixture = fixtureOf({ files: { "src/main.ts": "export const x = 'TEST_ONLY_SENTINEL_X';\n" } });
    const run = execute(fixture, ["--build"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("dist-bundle-violation");
    expect(existsSync(join(fixture.context.root, "dist"))).toBe(false);
  });
});

describe("the checker file", () => {
  it("imports tools/hook-isolation.mjs (the allowlist surface item D checks) and its other imports stay Node built-ins", () => {
    const source = readFileSync(join(REPO_ROOT, "tools/check-guard-preconditions.mjs"), "utf8");
    expect(source).toMatch(/from "\.\/hook-isolation\.mjs"/);
    expect(source).not.toMatch(/crypto\/testing/);
  });
});

function firstPathOf(): string {
  return checker.CHECKLIST_TESTS[0]?.path as string;
}
