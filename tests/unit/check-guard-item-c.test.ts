import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { captureIo, head, removeRepos, stubCommands, tempDir } from "../helpers/guard-repo.ts";
import { commitReview, isolatedEnvironment, makeSigningKey, okTree, reviewFixture, signWith, writeTrust, type JsonRecord, type OkTree, type SigningKey } from "../helpers/guard-review.ts";
import { FAKE_BUILD_FILES, operatorFixture } from "../helpers/guard-operator.ts";
import {
  DAY_MS,
  NOW,
  featureOpsDirectory,
  loadPhoneChecker,
  mainPrefix,
  measuredRecord,
  phoneFixture,
  statementText,
  writeOwnerFile,
  type PhoneChecker,
  type PhoneFixtureOptions,
  type PhoneResult,
} from "../helpers/guard-phone.ts";

// mvp-07b task 4.4b: item C, phone timing or recorded acceptance (design 9 "Phone timing (item C)", spec guard-evidence
// "Item C"). One small repository is shared by the cases that only need a tree; every per-user directory is a temporary
// HOME. Nothing builds a real repository: the command-line cases use the stub build of the other checker tests.

let checker: PhoneChecker;
let root: string;
let tree: OkTree;
beforeAll(async () => {
  checker = await loadPhoneChecker();
  root = reviewFixture();
  tree = okTree(checker, root);
});
afterEach(() => vi.restoreAllMocks());
afterAll(removeRepos);

const codes = (result: PhoneResult): string[] => result.failures.map((failure) => failure.code);
const run = (options: PhoneFixtureOptions = {}) => phoneFixture(checker, root, tree, options);
const measured = (change: (record: JsonRecord) => JsonRecord) => run({ mutate: change });
const accepted = (change: (record: JsonRecord) => JsonRecord) => run({ kind: "acceptance", mutate: change });
const without = (record: JsonRecord, ...fields: string[]): JsonRecord => Object.fromEntries(Object.entries(record).filter(([name]) => !fields.includes(name)));
const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString();

describe("item C constants", () => {
  it("holds the parameters and thresholds of the spec in the checker (known answers)", () => {
    expect(checker.PHONE_TIMING_PARAMETERS).toBe("m=65536 KiB t=3 p=1");
    expect(checker.PHONE_TIMING_MAX_SECONDS).toBe(3);
    expect(checker.PHONE_TIMING_MAX_GAP_MS).toBe(100);
    expect(checker.PHONE_TIMING_RECORD_FILE).toBe("phone-timing.json");
    expect(checker.PHONE_TIMING_STATEMENT_FILE).toBe("phone-timing-statement.txt");
    expect(checker.PHONE_ACCEPTANCE_PHRASE.length).toBeGreaterThan(20);
  });
});

describe("item C: the measured form", () => {
  it("passes a completed measurement bound to the build, and reports what was measured", () => {
    const fixture = run();
    const result = fixture.check();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.form).toBe("measured");
    expect(result.evidence).toMatchObject({ recordPath: fixture.recordPath, timingMeasured: true, device: "iPhone", os: "iOS 26.0", seconds: 1.14, longestGapMs: 21, finishedAt: fixture.record.finishedAt });
  });

  it("the thresholds are strict at the edges: 2.999 s and 99.9 ms pass, 13 days old passes", () => {
    expect(measured((record) => ({ ...record, seconds: 2.999, longestGapMs: 99.9, finishedAt: daysAgo(13) })).check().failures).toEqual([]);
  });

  it("is not bound to the tree: a measurement carrying no treeSha256 passes, one carrying another tree's passes too (B binds it)", () => {
    expect(measured((record) => ({ ...record, treeSha256: "0".repeat(64) })).check().ok).toBe(true);
  });

  it.each([
    ["a measurement for another build", (record: JsonRecord) => ({ ...record, pluginMainJsSha256: "e".repeat(64) }), "phone-build-mismatch"],
    ["a record without the build hash", (record: JsonRecord) => without(record, "pluginMainJsSha256"), "phone-build-mismatch"],
    ["completed false", (record: JsonRecord) => ({ ...record, completed: false }), "phone-not-completed"],
    ["completed missing", (record: JsonRecord) => without(record, "completed"), "phone-not-completed"],
    ["completed the string true", (record: JsonRecord) => ({ ...record, completed: "true" }), "phone-not-completed"],
    ["seconds of exactly 3", (record: JsonRecord) => ({ ...record, seconds: 3 }), "phone-seconds"],
    ["seconds of 3.5", (record: JsonRecord) => ({ ...record, seconds: 3.5 }), "phone-seconds"],
    ["seconds of 0", (record: JsonRecord) => ({ ...record, seconds: 0 }), "phone-seconds"],
    ["negative seconds", (record: JsonRecord) => ({ ...record, seconds: -1 }), "phone-seconds"],
    ["seconds as a string", (record: JsonRecord) => ({ ...record, seconds: "1.1" }), "phone-seconds"],
    ["seconds null (NaN serialised)", (record: JsonRecord) => ({ ...record, seconds: null }), "phone-seconds"],
    ["seconds missing", (record: JsonRecord) => without(record, "seconds"), "phone-seconds"],
    ["a longest gap of exactly 100 ms", (record: JsonRecord) => ({ ...record, longestGapMs: 100 }), "phone-gap"],
    ["a longest gap of 250 ms", (record: JsonRecord) => ({ ...record, longestGapMs: 250 }), "phone-gap"],
    ["a negative gap", (record: JsonRecord) => ({ ...record, longestGapMs: -1 }), "phone-gap"],
    ["a record without longestGapMs", (record: JsonRecord) => without(record, "longestGapMs"), "phone-gap"],
    ["other parameters", (record: JsonRecord) => ({ ...record, parameters: "m=32768 KiB t=3 p=1" }), "phone-parameters"],
    ["parameters missing", (record: JsonRecord) => without(record, "parameters"), "phone-parameters"],
    ["nonceVerified false", (record: JsonRecord) => ({ ...record, nonceVerified: false }), "phone-nonce"],
    ["nonceVerified missing", (record: JsonRecord) => without(record, "nonceVerified"), "phone-nonce"],
    ["no device", (record: JsonRecord) => without(record, "device"), "phone-device"],
    ["an empty OS", (record: JsonRecord) => ({ ...record, os: "" }), "phone-device"],
    ["a measurement older than 14 days", (record: JsonRecord) => ({ ...record, finishedAt: daysAgo(15) }), "phone-stale"],
    ["a finish time in the future", (record: JsonRecord) => ({ ...record, finishedAt: new Date(NOW + 60 * 60 * 1000).toISOString() }), "phone-finished-in-future"],
    ["a finish time that is not a date", (record: JsonRecord) => ({ ...record, finishedAt: "yesterday" }), "phone-record-malformed"],
    ["an unknown kind", (record: JsonRecord) => ({ ...record, kind: "estimated" }), "phone-kind"],
    ["no kind", (record: JsonRecord) => without(record, "kind"), "phone-kind"],
  ])("%s fails alone with %s", (_name, change, code) => {
    expect(codes(measured(change).check())).toEqual([code]);
  });

  it("a record that is not JSON, or not an object, is malformed", () => {
    const fixture = run();
    writeOwnerFile(fixture.recordPath, "{ not json");
    expect(codes(fixture.check())).toEqual(["phone-record-malformed"]);
    writeOwnerFile(fixture.recordPath, "[1,2]\n");
    expect(codes(fixture.check())).toEqual(["phone-record-malformed"]);
  });

  it("reports every problem of one record, not only the first", () => {
    const result = measured((record) => ({ ...record, seconds: 5, longestGapMs: 400, completed: false })).check();
    expect(codes(result)).toEqual(["phone-not-completed", "phone-seconds", "phone-gap"]);
  });
});

describe("item C: the acceptance form", () => {
  it("passes for the current tree and build, and says the timing was not measured", () => {
    const fixture = run({ kind: "acceptance" });
    const result = fixture.check();
    expect(result.failures).toEqual([]);
    expect(result.form).toBe("acceptance");
    expect(result.evidence).toMatchObject({ recordPath: fixture.recordPath, timingMeasured: false, finishedAt: fixture.record.acceptedAt });
  });

  it("passes at 13 days", () => {
    expect(accepted((record) => ({ ...record, acceptedAt: daysAgo(13) })).check().ok).toBe(true);
  });

  it.each([
    ["acceptance for another tree", (record: JsonRecord) => ({ ...record, treeSha256: "0".repeat(64) }), "phone-tree-mismatch"],
    ["acceptance without a tree", (record: JsonRecord) => without(record, "treeSha256"), "phone-tree-mismatch"],
    ["acceptance older than 14 days", (record: JsonRecord) => ({ ...record, acceptedAt: daysAgo(15) }), "phone-stale"],
    ["acceptance without the hash", (record: JsonRecord) => without(record, "pluginMainJsSha256"), "phone-build-mismatch"],
    ["acceptance for another build", (record: JsonRecord) => ({ ...record, pluginMainJsSha256: "e".repeat(64) }), "phone-build-mismatch"],
    ["a different phrase", (record: JsonRecord) => ({ ...record, phrase: "ok" }), "phone-phrase"],
    ["no phrase", (record: JsonRecord) => without(record, "phrase"), "phone-phrase"],
    ["nonceVerified false", (record: JsonRecord) => ({ ...record, nonceVerified: false }), "phone-nonce"],
    ["an empty statement", (record: JsonRecord) => ({ ...record, statement: "  " }), "phone-statement"],
    ["no statement", (record: JsonRecord) => without(record, "statement"), "phone-statement"],
    ["no date", (record: JsonRecord) => without(record, "acceptedAt"), "phone-record-malformed"],
    ["a date in the future", (record: JsonRecord) => ({ ...record, acceptedAt: new Date(NOW + 60 * 60 * 1000).toISOString() }), "phone-finished-in-future"],
  ])("%s fails alone with %s", (_name, change, code) => {
    expect(codes(accepted(change).check())).toEqual([code]);
  });

  it("an acceptance does not need the measurement fields, and a measurement does not satisfy it by carrying kind acceptance", () => {
    expect(codes(measured((record) => ({ ...record, kind: "acceptance" })).check())).toEqual(expect.arrayContaining(["phone-phrase", "phone-tree-mismatch"]));
  });
});

describe("item C: the per-user folder", () => {
  it("no record and no statement (the early run): phone-record-missing", () => {
    expect(codes(run({ writeRecord: false }).check())).toEqual(["phone-record-missing"]);
  });

  it("no feature-ops folder at all: phone-record-missing", () => {
    const env = isolatedEnvironment().env;
    expect(codes(checker.checkPhoneTiming({ root, tree, buildFiles: FAKE_BUILD_FILES, environment: env, now: NOW }))).toEqual(["phone-record-missing"]);
  });

  it("a group-writable folder: phone-mode", () => {
    const fixture = run();
    chmodSync(fixture.directory, 0o770);
    expect(codes(fixture.check())).toEqual(["phone-mode"]);
  });

  it("a record with mode 0644: phone-mode", () => {
    const fixture = run();
    chmodSync(fixture.recordPath, 0o644);
    expect(codes(fixture.check())).toEqual(["phone-mode"]);
  });

  it("a record that is a symbolic link is not read: phone-symlink", () => {
    const fixture = run({ writeRecord: false });
    const target = join(tempDir("guard-link-target-"), "real.json");
    writeOwnerFile(target, `${JSON.stringify(measuredRecord(checker))}\n`);
    symlinkSync(target, fixture.recordPath);
    expect(codes(fixture.check())).toEqual(["phone-symlink"]);
  });

  it("a folder that is a symbolic link is not read: phone-symlink", () => {
    const env = isolatedEnvironment().env;
    const real = featureOpsDirectory(checker, isolatedEnvironment().env);
    writeOwnerFile(join(real, checker.PHONE_TIMING_RECORD_FILE), `${JSON.stringify(measuredRecord(checker))}\n`);
    mkdirSync(checker.perUserStateDir(env), { recursive: true });
    symlinkSync(real, join(checker.perUserStateDir(env), "feature-ops"));
    expect(codes(checker.checkPhoneTiming({ root, tree, buildFiles: FAKE_BUILD_FILES, environment: env, now: NOW }))).toEqual(["phone-symlink"]);
  });

  it("writes nothing: the listing and the bytes are the same after the check", () => {
    const fixture = run();
    const before = { entries: readdirSync(fixture.directory).sort(), record: readFileSync(fixture.recordPath, "utf8"), mtime: statSync(fixture.recordPath).mtimeMs };
    fixture.check();
    expect({ entries: readdirSync(fixture.directory).sort(), record: readFileSync(fixture.recordPath, "utf8"), mtime: statSync(fixture.recordPath).mtimeMs }).toEqual(before);
  });
});

describe("item C: the signed statement", () => {
  let key: SigningKey;
  let good: { text: string; sig: string };
  let otherTree: { text: string; sig: string };
  let otherBuild: { text: string; sig: string };
  let otherNamespace: { text: string; sig: string };

  const sign = (text: string, namespace?: string): { text: string; sig: string } => {
    const file = join(tempDir("guard-statement-"), "statement.txt");
    writeFileSync(file, text);
    return { text, sig: signWith(key, file, namespace) };
  };

  beforeAll(() => {
    key = makeSigningKey("phone");
    good = sign(statementText(tree.t8, mainPrefix()));
    otherTree = sign(statementText("deadbeef", mainPrefix()));
    otherBuild = sign(statementText(tree.t8, "0123456789abcdef"));
    otherNamespace = sign(good.text, "somewhere-else");
  });

  /** An enrolled signer and a statement with its signature in a fresh feature-ops folder. */
  const signed = (statement: { text: string; sig: string } | undefined = good, options: { enrol?: boolean; signature?: string | null } = {}) => {
    const fixture = run({ writeRecord: false });
    if (options.enrol !== false) writeTrust(checker, fixture.env, key);
    if (statement !== undefined) {
      writeOwnerFile(join(fixture.directory, checker.PHONE_TIMING_STATEMENT_FILE), statement.text);
      if (options.signature !== null) writeOwnerFile(join(fixture.directory, `${checker.PHONE_TIMING_STATEMENT_FILE}.sig`), options.signature ?? statement.sig);
    }
    return fixture;
  };

  it("passes a statement naming T8 and the main.js hash prefix, signed by the enrolled key; the signer is reported and the timing is not measured", () => {
    const result = signed().check();
    expect(result.failures).toEqual([]);
    expect(result.form).toBe("signed");
    expect(result.evidence.timingMeasured).toBe(false);
    expect(result.evidence.signerFingerprint).toMatch(/^SHA256:/);
  });

  it.each([
    ["a statement for another tree", () => otherTree, "phone-statement-mismatch"],
    ["a statement for another build", () => otherBuild, "phone-statement-mismatch"],
    ["a signature in another namespace", () => otherNamespace, "phone-signature-invalid"],
  ])("%s fails alone with %s", (_name, pick, code) => {
    expect(codes(signed(pick()).check())).toEqual([code]);
  });

  it("a statement edited after it was signed: phone-signature-invalid", () => {
    expect(codes(signed({ text: `${good.text}Also fine.\n`, sig: good.sig }).check())).toEqual(["phone-signature-invalid"]);
  });

  it("a signature by a key that is not the enrolled one: phone-signature-invalid", () => {
    const stranger = makeSigningKey("stranger");
    const file = join(tempDir("guard-statement-"), "statement.txt");
    writeFileSync(file, good.text);
    expect(codes(signed({ text: good.text, sig: signWith(stranger, file) }).check())).toEqual(["phone-signature-invalid"]);
  });

  it("no enrolled signer: a trust failure, not a pass", () => {
    const result = signed(good, { enrol: false }).check();
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["trust-missing"]);
  });

  it("a statement without its signature file: phone-signature-missing", () => {
    expect(codes(signed(good, { signature: null }).check())).toEqual(["phone-signature-missing"]);
  });

  it("the signature file alone, without the statement, is not a record", () => {
    const lone = run({ writeRecord: false });
    writeTrust(checker, lone.env, key);
    writeOwnerFile(join(lone.directory, `${checker.PHONE_TIMING_STATEMENT_FILE}.sig`), good.sig);
    expect(codes(lone.check())).toEqual(["phone-record-missing"]);
  });

  it("the T8 and the prefix are matched as whole tokens: a longer hex string containing them does not name them", () => {
    const padded = sign(`Phone timing for tree ${tree.t8}0, plugin build ${mainPrefix()}0.\n`);
    expect(codes(signed(padded).check())).toEqual(["phone-statement-mismatch", "phone-statement-mismatch"]);
  });

  it("a statement with a loose mode is refused: phone-mode", () => {
    const fixture = signed();
    chmodSync(join(fixture.directory, checker.PHONE_TIMING_STATEMENT_FILE), 0o644);
    expect(codes(fixture.check())).toEqual(["phone-mode"]);
  });

  it("IPFS_SYNC_ALLOWED_SIGNERS set: the checker stops (environment error), it does not pass", () => {
    const fixture = signed();
    const env = { ...fixture.env, IPFS_SYNC_ALLOWED_SIGNERS: "/tmp/x" };
    expect(() => checker.checkPhoneTiming({ root, tree, buildFiles: FAKE_BUILD_FILES, environment: env, now: NOW })).toThrow(/IPFS_SYNC_ALLOWED_SIGNERS/);
  });

  it("a stale or failing measured record does not block a valid signed statement, and the failures of a failing form are not hidden when none passes", () => {
    const fixture = signed();
    writeOwnerFile(fixture.recordPath, `${JSON.stringify({ ...measuredRecord(checker), finishedAt: daysAgo(30) })}\n`);
    const result = fixture.check();
    expect(result.ok).toBe(true);
    expect(result.form).toBe("signed");

    const both = signed(otherTree);
    writeOwnerFile(both.recordPath, `${JSON.stringify({ ...measuredRecord(checker), finishedAt: daysAgo(30) })}\n`);
    expect(codes(both.check())).toEqual(["phone-stale", "phone-statement-mismatch"]);
  });
});

describe("item C in the command line", () => {
  const prepare = () => ({ root: reviewFixture(), tmpRoot: tempDir("guard-export-parent-"), commands: stubCommands(), environment: isolatedEnvironment().env });
  const builtFiles = (context: ReturnType<typeof prepare>): { b: string; files: Record<string, string> } => {
    const built = checker.buildCleanExport({ root: context.root, commit: head(context.root), commands: context.commands, tmpRoot: context.tmpRoot });
    if (!built.ok) throw new Error(JSON.stringify(built.failures));
    return { b: built.buildSha256, files: { ...built.files } };
  };
  /** Items A, B and (unless `phone` is false) C passing for the stub build of the repository. */
  const withRecords = (context: ReturnType<typeof prepare>, phone: PhoneFixtureOptions | false = {}) => {
    const { b, files } = builtFiles(context);
    commitReview(checker, context.root, { mutate: (record) => ({ ...record, buildSha256: b }) });
    const committed = okTree(checker, context.root);
    operatorFixture(checker, { tree: committed, env: context.environment, buildFiles: files });
    if (phone !== false) phoneFixture(checker, context.root, committed, { env: context.environment, buildFiles: files, ...phone });
    return { committed, files };
  };

  // Items D and E exist since task 4.4c; the stub test runner and audit of stubCommands() do nothing, so item E fails in
  // these cases. They are about item C; the passing runs are in check-guard-items-de.test.ts.
  it("A, B and C passing do not make a pass while item E fails; the output says what C found and names only E", () => {
    const context = prepare();
    withRecords(context);
    const io = captureIo();
    expect(checker.runCli([], { ...context, ...io.io, now: NOW }), io.err()).toBe(1);
    expect(io.out()).toContain("item-c: pass");
    expect(io.out()).toContain("item-c-form: measured");
    expect(io.out()).toContain("item-c-timing: measured");
    expect(io.out()).toContain("item-c-device: iPhone");
    expect(io.out()).toContain("item-c-seconds: 1.14");
    expect(io.out()).toContain("item-c-longest-gap-ms: 21");
    expect(io.err()).toContain("result: fail (E)");
  });

  it("an acceptance is printed as unverified timing", () => {
    const context = prepare();
    withRecords(context, { kind: "acceptance" });
    const io = captureIo();
    expect(checker.runCli([], { ...context, ...io.io, now: NOW }), io.err()).toBe(1);
    expect(io.out()).toContain("item-c: pass");
    expect(io.out()).toContain("item-c-form: acceptance");
    expect(io.out()).toContain("item-c-timing: unverified");
  });

  it("A and B passing with no phone record exit 1 and name the missing record", () => {
    const context = prepare();
    withRecords(context, false);
    const io = captureIo();
    expect(checker.runCli([], { ...context, ...io.io, now: NOW })).toBe(1);
    expect(io.out()).toContain("item-b: pass");
    expect(io.out()).toContain("item-c: fail");
    expect(io.err()).toContain("phone-record-missing");
    expect(io.err()).toContain("result: fail (C, E)");
  });

  it("--json reports item C as pass or fail with its form, evidence and failures, and D and E with theirs; pass is false while any item fails", () => {
    const context = prepare();
    withRecords(context);
    const io = captureIo();
    expect(checker.runCli(["--json"], { ...context, ...io.io, now: NOW })).toBe(1);
    const document = JSON.parse(io.out());
    expect(document.pass).toBe(false);
    expect(document.items.C.status).toBe("pass");
    expect(document.items.C.form).toBe("measured");
    expect(document.items.C.failures).toEqual([]);
    expect(document.items.C.evidence).toMatchObject({ timingMeasured: true, seconds: 1.14 });
    expect(document.items.D.status).toBe("pass");
    expect(document.items.E.status).toBe("fail");
  });

  it("--json reports a failing item C with its failure code", () => {
    const failing = prepare();
    withRecords(failing, { mutate: (record) => ({ ...record, seconds: 4 }) });
    const failed = captureIo();
    expect(checker.runCli(["--json"], { ...failing, ...failed.io, now: NOW })).toBe(1);
    const failedDocument = JSON.parse(failed.out());
    expect(failedDocument.items.C.status).toBe("fail");
    expect(failedDocument.items.C.failures[0].code).toBe("phone-seconds");
  });

  it("a default run leaves the per-user folder unchanged", () => {
    const context = prepare();
    withRecords(context);
    const directory = join(checker.perUserStateDir(context.environment), "feature-ops");
    const snapshot = () => readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name), "utf8")]);
    const before = snapshot();
    checker.runCli([], { ...context, ...captureIo().io, now: NOW });
    expect(snapshot()).toEqual(before);
  });
});
