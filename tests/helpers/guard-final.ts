import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOW, operatorFixture } from "./guard-operator.ts";
import { loadPhoneChecker, phoneFixture, type PhoneChecker, type PhoneFixtureOptions } from "./guard-phone.ts";
import { commitAll, stubCommands, tempDir, type BuildCommands, type DistScan, type FileContent, type TreeFailure } from "./guard-repo.ts";
import { commitReview, isolatedEnvironment, okTree, reviewFixture, sha256, type JsonRecord, type OkTree } from "./guard-review.ts";

/**
 * Fixtures for items D and E and the exit codes (mvp-07b task 4.4c). The build, the test runner and the audit are stubs,
 * every repository is a temporary one from guard-repo.ts and every per-user directory is a temporary HOME: nothing here
 * builds, tests or audits the real repository.
 */
export interface ChecklistEntry {
  readonly path: string;
  readonly min: number;
}

export interface LimitSentence {
  readonly id: string;
  readonly text: string;
}

export interface ItemResult {
  readonly ok: boolean;
  readonly failures: readonly TreeFailure[];
  readonly evidence: Record<string, unknown>;
}

/** What the export-side runner hands to the judges (tools/check-guard-preconditions.mjs `collectExportChecks`). */
export interface TestsRun {
  readonly skipped: boolean;
  readonly status?: number | null;
  readonly output?: string;
  readonly report?: string;
}

export interface AuditRun {
  readonly stdout: string;
  readonly output?: string;
  readonly status?: number | null;
}

export interface HookIsolationLike {
  readonly TOOL_TESTING_IMPORT_ALLOWLIST: readonly string[];
  readonly isToolTestingImportAllowed: (path: string) => boolean;
}

export interface FindingLike {
  readonly id: string;
  readonly severity: string;
  readonly status: string;
  readonly advisory?: string;
  readonly acceptedAt?: string;
  readonly acceptedBecause?: string;
}

export interface FinalChecker extends PhoneChecker {
  readonly CHECKLIST_TESTS: readonly ChecklistEntry[];
  readonly LIMIT_SENTENCES: readonly LimitSentence[];
  readonly DOCUMENT_FILES: readonly string[];
  readonly judgeChecklistRun: (options: {
    tests: TestsRun;
    hashes: Readonly<Record<string, string | null>>;
    record: { checklistTests: Readonly<Record<string, string>> } | undefined;
    exportDir: string;
  }) => { failures: readonly TreeFailure[]; files: readonly { path: string; min: number; passed: number; total: number }[] };
  readonly judgeAudit: (options: { audit: AuditRun; findings: readonly FindingLike[]; now: number }) => { failures: readonly TreeFailure[]; advisories: number };
  readonly checkLimitSentences: (options: { readme: string; design: string }) => { failures: readonly TreeFailure[] };
  readonly checkItemD: (options: { distScan: DistScan; hookIsolation?: HookIsolationLike }) => ItemResult;
}

export async function loadFinalChecker(): Promise<FinalChecker> {
  return (await loadPhoneChecker()) as FinalChecker;
}

/* ---------- judges, unit level ---------- */

export const EXPORT_DIR = "/guard-export/export";
export const checklistText = (path: string): string => `// ${path}\nexport {};\n`;

/** Hashes of the checklist files as the export holds them, and the record's `checklistTests` that agrees with them. */
export function checklistHashes(checker: FinalChecker): Record<string, string> {
  return Object.fromEntries(checker.CHECKLIST_TESTS.map(({ path }) => [path, sha256(checklistText(path))]));
}

export interface ReportAssertion {
  title: string;
  status: string;
}
export interface ReportFile {
  name: string;
  status: string;
  assertionResults: ReportAssertion[];
}
export interface VitestReport {
  numTotalTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  success: boolean;
  testResults: ReportFile[];
}

/** A report in which every checklist file ran exactly its minimum number of passing tests. `prefix` is the directory the names carry. */
export function passingReport(checker: FinalChecker, prefix: string = EXPORT_DIR): VitestReport {
  const testResults = checker.CHECKLIST_TESTS.map(({ path, min }) => ({
    name: prefix === "" ? path : `${prefix}/${path}`,
    status: "passed",
    assertionResults: Array.from({ length: min }, (_, index) => ({ title: `case ${index + 1}`, status: "passed" })),
  }));
  return { numTotalTests: testResults.reduce((sum, file) => sum + file.assertionResults.length, 0), numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true, testResults };
}

/** A new report in which `change` replaced the entry of `path` (or removed it when the function returns undefined). */
export function withFile(report: VitestReport, path: string, change: (file: ReportFile) => ReportFile | undefined): VitestReport {
  const testResults = report.testResults.flatMap((file) => (file.name.endsWith(`/${path}`) || file.name === path ? (change(file) ?? []) : [file]));
  return { ...report, testResults };
}

export const ranTests = (report: VitestReport | string | undefined, extra: Partial<TestsRun> = {}): TestsRun => ({
  skipped: false,
  status: 0,
  output: "",
  ...(report === undefined ? {} : { report: typeof report === "string" ? report : JSON.stringify(report) }),
  ...extra,
});

/** Item E's inputs for the pure judges: the very hashes the record names, and a passing run. */
export function judgeInputs(checker: FinalChecker): { hashes: Record<string, string>; record: { checklistTests: Record<string, string> }; tests: TestsRun } {
  const hashes = checklistHashes(checker);
  return { hashes, record: { checklistTests: { ...hashes } }, tests: ranTests(passingReport(checker)) };
}

/* ---------- documents ---------- */

export interface DocumentOptions {
  /** The sentences each file holds (default: all of them). */
  readonly readme?: readonly string[];
  readonly design?: readonly string[];
  /** Where the design sentences sit: inside section 8 (default), after it, or no section 8 at all. */
  readonly designPlacement?: "section-8" | "section-9" | "none";
}

/** README, CHANGELOG, DESIGN and the runbook for a repository, holding the required sentences as the options say. */
export function documentFiles(checker: FinalChecker, options: DocumentOptions = {}): Record<string, string> {
  const all = checker.LIMIT_SENTENCES.map((sentence) => sentence.text);
  const readme = options.readme ?? all;
  const design = (options.design ?? all).join("\n\n");
  const placement = options.designPlacement ?? "section-8";
  const sections =
    placement === "none"
      ? `## 7. Earlier\n\n${design}\n`
      : placement === "section-9"
        ? `## 7. Earlier\n\nnothing\n\n## 8. Encrypted vault: limits\n\nnothing here\n\n## 9. Later\n\n${design}\n`
        : `## 7. Earlier\n\nnothing\n\n## 8. Encrypted vault: limits\n\n${design}\n\n## 9. Later\n\nnothing\n`;
  return {
    "README.md": `# Fixture\n\n${readme.join("\n\n")}\n`,
    "CHANGELOG.md": "# Changelog\n\n- 0.3.0\n",
    "DESIGN.md": `# Design\n\n${sections}`,
    "docs/operator/encrypted-vault.md": "# Runbook\n\nsteps\n",
  };
}

/* ---------- stub runners ---------- */

export interface StubTestSpec {
  /** The report the stub writes (names relative to the working directory; the stub makes them absolute like vitest does). */
  readonly report?: VitestReport;
  readonly exit?: number;
  /** Where the stub records its arguments and the names of its environment (so a case can look at both). */
  readonly echo?: string;
}

const STUB_VITEST = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [specPath, ...rest] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const target = rest.find((argument) => argument.startsWith("--outputFile="));
if (spec.report !== undefined && target !== undefined) {
  const report = { ...spec.report, testResults: spec.report.testResults.map((file) => ({ ...file, name: join(process.cwd(), file.name) })) };
  writeFileSync(target.slice("--outputFile=".length), JSON.stringify(report));
}
if (spec.echo !== undefined) writeFileSync(spec.echo, JSON.stringify({ args: rest, cwd: process.cwd(), env: Object.keys(process.env) }));
process.exit(spec.exit ?? 0);
`;

let stubDirectory: string | undefined;
let stubCount = 0;
const stubPath = (name: string): string => {
  stubDirectory ??= tempDir("guard-stubs-");
  return join(stubDirectory, name);
};

/** A test-runner command that behaves as `spec` says. The stub script lives in a temporary directory outside every repository. */
export function stubTests(spec: StubTestSpec): string[] {
  const script = stubPath("stub-vitest.mjs");
  writeFileSync(script, STUB_VITEST);
  stubCount += 1;
  const specFile = stubPath(`spec-${stubCount}.json`);
  writeFileSync(specFile, JSON.stringify(spec));
  return [process.execPath, script, specFile];
}

/** An audit command that prints `text` and exits with `status`. */
export const stubAudit = (text: string, status = 0): string[] => [process.execPath, "-e", "process.stdout.write(process.argv[1]); process.exit(Number(process.argv[2]));", text, String(status)];

export const CLEAN_AUDIT = JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } });
export const OFFLINE_AUDIT = "Error: ERR_PNPM_AUDIT_BAD_RESPONSE\n\n  x Failed to request the audit endpoint\n";

/** The audit document of `pnpm audit --prod --json` with one advisory per entry of `advisories`. */
export const auditWith = (...advisories: readonly Record<string, unknown>[]): string =>
  JSON.stringify({ advisories: Object.fromEntries(advisories.map((advisory, index) => [String(1000 + index), advisory])), metadata: {} });

export const MOMENT_ADVISORY = { id: 1111111, github_advisory_id: "GHSA-4p3w-j4w9-5jqw", module_name: "moment", severity: "high", title: "path traversal", url: "https://github.com/advisories/GHSA-4p3w-j4w9-5jqw", cves: ["CVE-2026-0001"] };

/* ---------- the complete repository ---------- */

export interface FinalFixtureOptions {
  /** Files added to or (null) removed from the repository before the first commit; the checklist files and documents are already there. */
  readonly files?: Readonly<Record<string, FileContent | null>>;
  readonly documents?: DocumentOptions;
  /** What the stub test runner writes: the passing report unless changed. */
  readonly report?: (report: VitestReport) => VitestReport;
  readonly testsExit?: number;
  readonly audit?: string;
  readonly auditStatus?: number;
  readonly mutateRecord?: (record: JsonRecord) => JsonRecord;
  readonly phone?: PhoneFixtureOptions | false;
  /** False leaves the operator-run record out (an early run). */
  readonly operator?: boolean;
}

export interface FinalContext {
  readonly root: string;
  readonly tmpRoot: string;
  readonly commands: BuildCommands;
  readonly environment: Record<string, string | undefined>;
  readonly now: number;
}

export interface FinalFixture {
  readonly checker: FinalChecker;
  readonly context: FinalContext;
  readonly tree: OkTree;
  readonly buildFiles: Readonly<Record<string, string>>;
  readonly buildSha256: string;
  readonly echoPath: string;
  readonly reviewPath: string;
}

/**
 * A repository whose items A, B and C pass for the stub build, with the checklist test files, the documents, a stub test
 * runner that writes a passing report and a stub audit that finds nothing: the default run exits 0. Each option breaks
 * one thing.
 */
export function finalFixture(checker: FinalChecker, options: FinalFixtureOptions = {}): FinalFixture {
  const hashes = checklistHashes(checker);
  const checklistFiles = Object.fromEntries(checker.CHECKLIST_TESTS.map(({ path }) => [path, checklistText(path)]));
  const root = reviewFixture({ ...documentFiles(checker, options.documents), ...checklistFiles, ...options.files });
  const environment = isolatedEnvironment().env;
  const tmpRoot = tempDir("guard-export-parent-");
  const echoPath = join(tempDir("guard-echo-"), "echo.json");
  const report = (options.report ?? ((value: VitestReport) => value))(passingReport(checker, ""));
  const commands = stubCommands({
    tests: stubTests({ report, exit: options.testsExit ?? 0, echo: echoPath }),
    audit: stubAudit(options.audit ?? CLEAN_AUDIT, options.auditStatus ?? 0),
  });
  // B of the stub build, computed from the sources instead of by a build (a build per fixture would double the cost of every
  // case): the fixture's build.mjs copies src/main.ts, manifest.json and cli/main.ts (behind a shebang). The first
  // command-line case would fail item A with review-build-mismatch if this knowledge drifted from guard-repo.ts.
  const source = (path: string, fallback: string): string => {
    const given = options.files?.[path];
    return typeof given === "string" ? given : fallback;
  };
  const files: Record<string, string> = {
    "dist/plugin/main.js": sha256(source("src/main.ts", "export const main = 1;\n")),
    "dist/plugin/manifest.json": sha256(source("manifest.json", '{"id":"fixture","version":"1.0.0"}\n')),
    "dist/cli/ipfs-sync.mjs": sha256(`#!/usr/bin/env node\n${source("cli/main.ts", "export const cli = 1;\n")}`),
  };
  const buildSha256 = checker.hashBuildLines(files).buildSha256;
  const committed = commitReview(checker, root, {
    mutate: (record) => (options.mutateRecord ?? ((value: JsonRecord) => value))({ ...record, buildSha256, checklistTests: { ...(record.checklistTests as Record<string, string>), ...hashes } }),
  });
  if (options.operator !== false) operatorFixture(checker, { tree: committed.tree, env: environment, buildFiles: files });
  if (options.phone !== false) phoneFixture(checker, root, committed.tree, { env: environment, buildFiles: files, ...(options.phone ?? {}) });
  return { checker, context: { root, tmpRoot, commands, environment, now: NOW }, tree: committed.tree, buildFiles: files, buildSha256, echoPath, reviewPath: committed.path };
}

/** Replaces the record file of a fixture with `record` and commits it. The record is outside the scope, so T does not change. */
export function recommitRecord(fixture: FinalFixture, change: (record: JsonRecord) => JsonRecord, note = "Disposition: updated."): string {
  const { root } = fixture.context;
  const path = join(root, fixture.reviewPath);
  const text = readFileSync(path, "utf8");
  const open = "<!-- guard-review:v1 -->";
  const close = "<!-- /guard-review -->";
  const record = JSON.parse(text.slice(text.indexOf(open) + open.length, text.indexOf(close))) as JsonRecord;
  writeFileSync(path, `# Review of the final tree\n\n${open}\n${JSON.stringify(change(record), null, 2)}\n${close}\n\n${note}\n`);
  return commitAll(root, "update record");
}

export { NOW, commitAll };
export type { DistScan };
