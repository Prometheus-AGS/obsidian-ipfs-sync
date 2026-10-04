import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { captureIo, head, removeRepos, stubCommands, tempDir } from "../helpers/guard-repo.ts";
import { commitReview, isolatedEnvironment, okTree, reviewFixture, sha256, type JsonRecord } from "../helpers/guard-review.ts";
import {
  DAY_MS,
  FAKE_BUILD_FILES,
  NOW,
  TRANSCRIPT_TEXT,
  loadOperatorChecker,
  operatorFixture,
  type OperatorChecker,
  type OperatorFixtureOptions,
  type OperatorResult,
} from "../helpers/guard-operator.ts";
import { phoneFixture, type PhoneChecker } from "../helpers/guard-phone.ts";

// mvp-07b task 4.4a: item B, the operator-run record (design 9 "Operator-run record (item B)", spec guard-evidence
// "Item B"). Every case runs over a temporary HOME holding the per-user feature-ops folder; the record, the transcript and
// the build hashes are fixtures. Nothing builds a real repository and nothing reads the real account. The six-environment
// agreement between `perUserStateDir` and the CLI's `deviceStoreDirectory` is pinned in check-guard-anchor.test.ts
// ("per-user state directory"), written with the function in task 4.3c; this file does not repeat it.

let checker: OperatorChecker;
beforeAll(async () => {
  checker = await loadOperatorChecker();
});
afterEach(() => vi.restoreAllMocks());
afterAll(removeRepos);

const codes = (result: OperatorResult): string[] => result.failures.map((failure) => failure.code);
const run = (options: OperatorFixtureOptions = {}) => operatorFixture(checker, options);
const withRecord = (change: (record: JsonRecord) => JsonRecord) => ({ mutate: change });
type Assertion = { id: string; kind: string; passed: boolean; detail: string };
const assertionsOf = (record: JsonRecord): Assertion[] => record.assertions as Assertion[];
const withAssertions = (change: (list: Assertion[]) => Assertion[]) => withRecord((record) => ({ ...record, assertions: change(assertionsOf(record)) }));
const vaultsOf = (record: JsonRecord): { name: string; files: Record<string, string> }[] => (record.installed as { vaults: { name: string; files: Record<string, string> }[] }).vaults;
const withInstalled = (change: (installed: { vaults: { name: string; files: Record<string, string> }[]; cli: string }) => unknown) =>
  withRecord((record) => ({ ...record, installed: change(record.installed as { vaults: { name: string; files: Record<string, string> }[]; cli: string }) }));

describe("REQUIRED_ASSERTIONS", () => {
  it("holds the ids of the release-2 spec with their kinds, in the checker (known-answer list)", () => {
    expect(checker.REQUIRED_ASSERTIONS.map(({ id }) => id)).toEqual([
      "ciphertext-only-on-node",
      "plaintext-restored-byte-equal",
      "wrong-passphrase-refused",
      "first-pull-confirm-shown",
      "sequence-recorded",
      "tamper-refused-nothing-written",
      "pull-no-node-mutation",
      "conflict-copy-kept",
      "multi-segment-blob-pulled-in-plugin",
      "older-root-by-name-refused",
      "restore-older-version",
      "fork-resolved",
      "rewrap-and-accept",
      "increase-cost",
      "prune-history",
      "mass-removal-stopped",
      "installed-files-hashed",
      "only-demo-root-and-owned-key-changed",
    ]);
    expect(checker.REQUIRED_ASSERTIONS.filter(({ kind }) => kind === "operator-observed").map(({ id }) => id)).toEqual(["first-pull-confirm-shown"]);
    expect(checker.REQUIRED_ASSERTIONS.every(({ kind }) => kind === "machine" || kind === "operator-observed")).toBe(true);
  });

  it("equals the ids named in the release-2 spec text (the list of the operator-run script is compared in task 4.6)", () => {
    const spec = readFileSync(join(import.meta.dirname, "../../openspec/changes/mvp-07b-keys-history-guard-release-2/specs/release-2/spec.md"), "utf8");
    const start = spec.indexOf("at least these assertion ids, each passed:");
    const end = spec.indexOf("A CLI-only or simulated result");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // The parenthetical notes carry other backticked words (the range outcomes), which are not ids.
    const sentence = spec.slice(start, end).replace(/\([^)]*\)/g, "");
    const ids = [...sentence.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]);
    expect(ids).toEqual(checker.REQUIRED_ASSERTIONS.map(({ id }) => id));
  });

  it("is frozen, so a caller cannot shorten it", () => {
    expect(Object.isFrozen(checker.REQUIRED_ASSERTIONS)).toBe(true);
    expect(checker.REQUIRED_ASSERTIONS.every((entry) => Object.isFrozen(entry))).toBe(true);
  });
});

describe("item B: a correct manual run", () => {
  it("passes and reports the record, the finish time and the assertion count", () => {
    const fixture = run();
    const result = fixture.check();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.evidence.recordPath).toBe(fixture.recordPath);
    expect(result.evidence.finishedAt).toBe(fixture.record.finishedAt);
    expect(result.evidence.assertionCount).toBe(checker.REQUIRED_ASSERTIONS.length);
  });

  it("a build without styles.css passes when no vault carries one", () => {
    const { "dist/plugin/styles.css": _omitted, ...withoutStyles } = FAKE_BUILD_FILES;
    expect(run({ buildFiles: withoutStyles }).check().failures).toEqual([]);
  });

  it("extra assertions beyond the required list do not fail the record", () => {
    const fixture = run(withAssertions((list) => [...list, { id: "extra-note", kind: "machine", passed: true, detail: "x" }]));
    expect(fixture.check().ok).toBe(true);
  });

  it("writes nothing: the folder listing and the file bytes are the same after the check", () => {
    const fixture = run();
    const before = { entries: readdirSync(fixture.directory).sort(), record: readFileSync(fixture.recordPath, "utf8"), mtime: statSync(fixture.recordPath).mtimeMs };
    fixture.check();
    expect({ entries: readdirSync(fixture.directory).sort(), record: readFileSync(fixture.recordPath, "utf8"), mtime: statSync(fixture.recordPath).mtimeMs }).toEqual(before);
  });
});

describe("item B: each failure alone", () => {
  it("no record at all (the early run): operator-record-missing", () => {
    const fixture = run({ writeRecord: false, writeTranscript: false });
    expect(codes(fixture.check())).toEqual(["operator-record-missing"]);
  });

  it("no feature-ops folder at all: operator-record-missing", () => {
    const env = isolatedEnvironment().env;
    const tree = okTree(checker, reviewFixture());
    expect(codes(checker.checkOperatorRecord({ tree, buildFiles: FAKE_BUILD_FILES, environment: env, now: NOW }))).toEqual(["operator-record-missing"]);
  });

  it.each([
    ["a record written by --verify-only (mode)", (record: JsonRecord) => ({ ...record, mode: "verify-only" })],
    ["a record flagged verifyOnly with mode manual", (record: JsonRecord) => ({ ...record, verifyOnly: true })],
    ["the unattended script-only run (phases)", (record: JsonRecord) => ({ ...record, phases: "script-only" })],
  ])("a simulated run, %s: operator-simulated", (_name, change) => {
    expect(codes(run(withRecord(change)).check())).toEqual(["operator-simulated"]);
  });

  it("a mode other than manual: operator-not-manual", () => {
    expect(codes(run(withRecord((record) => ({ ...record, mode: "scheduled" }))).check())).toEqual(["operator-not-manual"]);
  });

  it.each([
    ["passed false", (record: JsonRecord) => ({ ...record, passed: false })],
    ["passed the string true", (record: JsonRecord) => ({ ...record, passed: "true" })],
  ])("%s: the shape or operator-not-passed fails the record", (_name, change) => {
    const result = run(withRecord(change)).check();
    expect(result.ok).toBe(false);
    expect(codes(result).length).toBe(1);
  });

  it("another tree: operator-tree-mismatch", () => {
    const result = run(withRecord((record) => ({ ...record, treeSha256: "0".repeat(64) }))).check();
    expect(codes(result)).toEqual(["operator-tree-mismatch"]);
  });

  it("a stale run, finished 14 days and a second ago: operator-stale; exactly 14 days passes", () => {
    const finishedAt = (age: number) => withRecord((record) => ({ ...record, finishedAt: new Date(NOW - age).toISOString() }));
    expect(codes(run(finishedAt(14 * DAY_MS + 1000)).check())).toEqual(["operator-stale"]);
    expect(run(finishedAt(14 * DAY_MS)).check().failures).toEqual([]);
  });

  it("a finish time in the future cannot keep a record fresh forever: operator-finished-in-future", () => {
    const result = run(withRecord((record) => ({ ...record, finishedAt: new Date(NOW + 365 * DAY_MS).toISOString() }))).check();
    expect(codes(result)).toEqual(["operator-finished-in-future"]);
  });

  it("a finish time that is not a date: operator-record-malformed", () => {
    expect(codes(run(withRecord((record) => ({ ...record, finishedAt: "yesterday-ish" }))).check())).toEqual(["operator-record-malformed"]);
  });

  it("a directory that is group-writable: operator-mode (the directory only)", () => {
    const fixture = run();
    chmodSync(fixture.directory, 0o770);
    const result = fixture.check();
    expect(codes(result)).toEqual(["operator-mode"]);
    expect(result.failures[0]?.path).toBe(fixture.directory);
  });

  it("a record file readable by others: operator-mode (the file only)", () => {
    const fixture = run();
    chmodSync(fixture.recordPath, 0o644);
    const result = fixture.check();
    expect(codes(result)).toEqual(["operator-mode"]);
    expect(result.failures[0]?.path).toBe(fixture.recordPath);
  });

  it("a directory, a record and a transcript owned by another user: operator-owner for each", () => {
    const fixture = run();
    const uid = process.getuid?.();
    if (uid === undefined) return;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    const result = fixture.check();
    expect(codes(result).sort()).toEqual(["operator-owner", "operator-owner", "operator-owner"]);
    expect(result.failures.map((failure) => failure.path).sort()).toEqual([fixture.directory, fixture.recordPath, fixture.transcriptPath].sort());
  });

  it("the feature-ops folder is a symbolic link: operator-symlink, and nothing behind it is read", () => {
    const fixture = run();
    const moved = `${fixture.directory}.real`;
    renameSync(fixture.directory, moved);
    symlinkSync(moved, fixture.directory);
    expect(codes(fixture.check())).toEqual(["operator-symlink"]);
  });

  it("the record is a symbolic link: operator-symlink", () => {
    const fixture = run();
    renameSync(fixture.recordPath, `${fixture.recordPath}.orig`);
    symlinkSync(`${fixture.recordPath}.orig`, fixture.recordPath);
    expect(codes(fixture.check())).toEqual(["operator-symlink"]);
  });

  it("the transcript is a symbolic link: operator-symlink", () => {
    const fixture = run();
    renameSync(fixture.transcriptPath, `${fixture.transcriptPath}.orig`);
    symlinkSync(`${fixture.transcriptPath}.orig`, fixture.transcriptPath);
    expect(codes(fixture.check())).toEqual(["operator-symlink"]);
  });

  it("the record is a folder, not a file: operator-not-file", () => {
    const fixture = run({ writeRecord: false });
    mkdirSync(fixture.recordPath, { mode: 0o600 });
    expect(codes(fixture.check())).toContain("operator-not-file");
  });

  it.each([
    ["not JSON", "this is not json"],
    ["a JSON array", "[]"],
    ["an empty object", "{}"],
  ])("a record that is %s: operator-record-malformed", (_name, text) => {
    const fixture = run();
    writeFileSync(fixture.recordPath, text, { mode: 0o600 });
    expect(codes(fixture.check())).toEqual(["operator-record-malformed"]);
  });
});

describe("item B: the required assertions", () => {
  const required = () => [...checker.REQUIRED_ASSERTIONS];

  it.each(Array.from({ length: 18 }, (_, index) => index))("a record missing required assertion %i fails alone: operator-assertion-missing", (index) => {
    const dropped = required()[index];
    expect(dropped).toBeDefined();
    const result = run(withAssertions((list) => list.filter((entry) => entry.id !== dropped?.id))).check();
    expect(codes(result)).toEqual(["operator-assertion-missing"]);
    expect(result.failures[0]?.path).toBe(dropped?.id);
  });

  it.each(Array.from({ length: 18 }, (_, index) => index))("a record with the wrong kind for required assertion %i fails alone: operator-assertion-kind", (index) => {
    const changed = required()[index];
    expect(changed).toBeDefined();
    const flip = changed?.kind === "machine" ? "operator-observed" : "machine";
    const result = run(withAssertions((list) => list.map((entry) => (entry.id === changed?.id ? { ...entry, kind: flip } : entry)))).check();
    expect(codes(result)).toEqual(["operator-assertion-kind"]);
    expect(result.failures[0]?.path).toBe(changed?.id);
  });

  it("first-pull-confirm-shown recorded as a machine assertion is refused (it must be operator-observed)", () => {
    const result = run(withAssertions((list) => list.map((entry) => (entry.id === "first-pull-confirm-shown" ? { ...entry, kind: "machine" } : entry)))).check();
    expect(codes(result)).toEqual(["operator-assertion-kind"]);
  });

  it("a required assertion that did not pass: operator-assertion-failed", () => {
    const result = run(withAssertions((list) => list.map((entry) => (entry.id === "prune-history" ? { ...entry, passed: false } : entry)))).check();
    expect(codes(result)).toEqual(["operator-assertion-failed"]);
    expect(result.failures[0]?.path).toBe("prune-history");
  });

  it("a required id listed twice, once passed and once failed: operator-assertion-duplicate", () => {
    const result = run(withAssertions((list) => [...list, { id: "increase-cost", kind: "machine", passed: false, detail: "second" }])).check();
    expect(codes(result)).toEqual(["operator-assertion-duplicate"]);
  });

  it("an empty list fails every required id, not silently", () => {
    const result = run(withAssertions(() => [])).check();
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(checker.REQUIRED_ASSERTIONS.map(() => "operator-assertion-missing"));
  });

  it("the required list comes from the checker: a record cannot lower the bar by carrying its own list", () => {
    const result = run(withRecord((record) => ({ ...record, requiredAssertions: [], assertions: [] }))).check();
    expect(result.ok).toBe(false);
  });
});

describe("item B: the transcript", () => {
  it("a transcript that differs from the recorded hash: operator-transcript-mismatch", () => {
    const fixture = run();
    writeFileSync(fixture.transcriptPath, `${TRANSCRIPT_TEXT}an extra line\n`, { mode: 0o600 });
    expect(codes(fixture.check())).toEqual(["operator-transcript-mismatch"]);
  });

  it("a record whose transcriptSha256 is wrong: operator-transcript-mismatch", () => {
    const result = run(withRecord((record) => ({ ...record, transcriptSha256: sha256("another transcript") }))).check();
    expect(codes(result)).toEqual(["operator-transcript-mismatch"]);
  });

  it("no transcript beside the record: operator-transcript-missing", () => {
    expect(codes(run({ writeTranscript: false }).check())).toEqual(["operator-transcript-missing"]);
  });
});

describe("item B: installed files are the build B", () => {
  it.each([
    ["main.js of the first vault", (installed: ReturnType<typeof vaultsOf>) => [{ ...installed[0]!, files: { ...installed[0]!.files, "main.js": sha256("other") } }, installed[1]!]],
    ["manifest.json of the second vault", (installed: ReturnType<typeof vaultsOf>) => [installed[0]!, { ...installed[1]!, files: { ...installed[1]!.files, "manifest.json": sha256("other") } }]],
    ["styles.css of the first vault", (installed: ReturnType<typeof vaultsOf>) => [{ ...installed[0]!, files: { ...installed[0]!.files, "styles.css": sha256("other") } }, installed[1]!]],
  ])("%s differs from B: operator-install-mismatch", (_name, change) => {
    const result = run(withInstalled((installed) => ({ ...installed, vaults: change(installed.vaults) }))).check();
    expect(codes(result)).toEqual(["operator-install-mismatch"]);
  });

  it("the CLI bundle differs from B: operator-install-mismatch", () => {
    const result = run(withInstalled((installed) => ({ ...installed, cli: sha256("other cli") }))).check();
    expect(codes(result)).toEqual(["operator-install-mismatch"]);
  });

  it("a vault that lacks main.js: operator-install-mismatch", () => {
    const result = run(
      withInstalled((installed) => {
        const { "main.js": _dropped, ...rest } = installed.vaults[0]!.files;
        return { ...installed, vaults: [{ ...installed.vaults[0]!, files: rest }, installed.vaults[1]!] };
      }),
    ).check();
    expect(codes(result)).toEqual(["operator-install-mismatch"]);
  });

  it("B has styles.css and a vault carries none: operator-install-mismatch", () => {
    const result = run(
      withInstalled((installed) => {
        const { "styles.css": _dropped, ...rest } = installed.vaults[1]!.files;
        return { ...installed, vaults: [installed.vaults[0]!, { ...installed.vaults[1]!, files: rest }] };
      }),
    ).check();
    expect(codes(result)).toEqual(["operator-install-mismatch"]);
  });

  it("B has no styles.css and one vault carries one: operator-install-mismatch", () => {
    const { "dist/plugin/styles.css": _omitted, ...withoutStyles } = FAKE_BUILD_FILES;
    const result = run({
      buildFiles: withoutStyles,
      mutate: (record) => ({
        ...record,
        installed: { ...(record.installed as object), vaults: vaultsOf(record).map((vault, index) => (index === 0 ? { ...vault, files: { ...vault.files, "styles.css": sha256("x") } } : vault)) },
      }),
    }).check();
    expect(codes(result)).toEqual(["operator-install-mismatch"]);
  });

  it.each([0, 1])("%i throwaway vaults recorded instead of two: operator-vaults", (count) => {
    const result = run(withInstalled((installed) => ({ ...installed, vaults: installed.vaults.slice(0, count) }))).check();
    expect(codes(result)).toEqual(["operator-vaults"]);
  });

  it("every mismatch is reported, not only the first", () => {
    const result = run(
      withInstalled((installed) => ({
        cli: sha256("other cli"),
        vaults: installed.vaults.map((vault) => ({ ...vault, files: { ...vault.files, "main.js": sha256("other") } })),
      })),
    ).check();
    expect(codes(result)).toEqual(["operator-install-mismatch", "operator-install-mismatch", "operator-install-mismatch"]);
  });
});

describe("item B in the command line", () => {
  const prepare = () => {
    const root = reviewFixture();
    const environment = isolatedEnvironment().env;
    return { root, tmpRoot: tempDir("guard-export-parent-"), commands: stubCommands(), environment };
  };
  const builtFiles = (context: ReturnType<typeof prepare>): { b: string; files: Record<string, string> } => {
    const built = checker.buildCleanExport({ root: context.root, commit: head(context.root), commands: context.commands, tmpRoot: context.tmpRoot });
    if (!built.ok) throw new Error(JSON.stringify(built.failures));
    return { b: built.buildSha256, files: { ...built.files } };
  };
  /** A passing item A for the current tree and a record for item B written from the same build. */
  const withBothRecords = (context: ReturnType<typeof prepare>, operator: Partial<OperatorFixtureOptions> = {}) => {
    const { b, files } = builtFiles(context);
    commitReview(checker, context.root, { mutate: (record) => ({ ...record, buildSha256: b }) });
    const tree = okTree(checker, context.root);
    // Item C (task 4.4b) is part of every default run now: a passing phone-timing record keeps these cases about item B.
    phoneFixture(checker as PhoneChecker, context.root, tree, { env: context.environment, buildFiles: files });
    return operatorFixture(checker, { tree, env: context.environment, buildFiles: files, ...operator });
  };

  // Items D and E exist since task 4.4c. The stub test runner and audit of stubCommands() do nothing, so item E fails in
  // these cases (no report, no audit document): they are about item B, and the passing runs are in check-guard-items-de.test.ts.
  it("a default run with item A passing and no operator record exits 1, names the missing record and the failing items", () => {
    const context = prepare();
    const { b } = builtFiles(context);
    commitReview(checker, context.root, { mutate: (record) => ({ ...record, buildSha256: b }) });
    const io = captureIo();
    expect(checker.runCli([], { ...context, ...io.io })).toBe(1);
    expect(io.out()).toContain("item-a: pass");
    expect(io.out()).toContain("item-b: fail");
    expect(io.err()).toContain("operator-record-missing");
    expect(io.err()).toContain("result: fail (B, C, E)");
  });

  it("items A, B and C passing do not make a pass while item E fails, and the output says what B found", () => {
    const context = prepare();
    const fixture = withBothRecords(context);
    const io = captureIo();
    expect(checker.runCli([], { ...context, ...io.io, now: NOW }), io.err()).toBe(1);
    expect(io.out()).toContain("item-a: pass");
    expect(io.out()).toContain("item-b: pass");
    expect(io.out()).toContain(`item-b-record: ${fixture.recordPath}`);
    expect(io.out()).toContain(`item-b-finished-at: ${fixture.record.finishedAt as string}`);
    expect(io.out()).toContain(`item-b-assertions: ${checker.REQUIRED_ASSERTIONS.length}`);
    expect(io.err()).toContain("result: fail (E)");
  });

  it("a stale record found by a default run exits 1 and prints the reason", () => {
    const context = prepare();
    withBothRecords(context, { mutate: (record) => ({ ...record, finishedAt: new Date(NOW - 30 * DAY_MS).toISOString() }) });
    const io = captureIo();
    expect(checker.runCli([], { ...context, ...io.io, now: NOW })).toBe(1);
    expect(io.err()).toContain("operator-stale");
  });

  it("--json reports item B as pass or fail with its failures, and D and E with theirs; pass is false while any item fails", () => {
    const context = prepare();
    withBothRecords(context);
    const passing = captureIo();
    expect(checker.runCli(["--json"], { ...context, ...passing.io, now: NOW })).toBe(1);
    const document = JSON.parse(passing.out());
    expect(document.pass).toBe(false);
    expect(document.complete).toBe(true);
    expect(document.items.A.status).toBe("pass");
    expect(document.items.B.status).toBe("pass");
    expect(document.items.B.failures).toEqual([]);
    expect(document.items.B.evidence.recordPath).toMatch(/feature-op-mvp-07\.json$/);
    expect(document.items.C.status).toBe("pass");
    expect(document.items.D.status).toBe("pass");
    expect(document.items.E.status).toBe("fail");
  });

  it("--json reports a failing item B with its failure code", () => {
    const failing = captureIo();
    const other = prepare();
    const { b } = builtFiles(other);
    commitReview(checker, other.root, { mutate: (record) => ({ ...record, buildSha256: b }) });
    expect(checker.runCli(["--json"], { ...other, ...failing.io, now: NOW })).toBe(1);
    const failed = JSON.parse(failing.out());
    expect(failed.items.B.status).toBe("fail");
    expect(failed.items.B.failures[0].code).toBe("operator-record-missing");
  });

  it("a default run leaves the per-user folder unchanged", () => {
    const context = prepare();
    const fixture = withBothRecords(context);
    const before = readdirSync(dirname(fixture.recordPath)).sort().map((name) => [name, readFileSync(join(fixture.directory, name), "utf8")]);
    checker.runCli([], { ...context, ...captureIo().io, now: NOW });
    expect(readdirSync(dirname(fixture.recordPath)).sort().map((name) => [name, readFileSync(join(fixture.directory, name), "utf8")])).toEqual(before);
  });
});
