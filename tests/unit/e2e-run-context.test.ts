import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRunLock, BASE_PATH, createRunContext, isValidRunId, removeRunDir, RUN_ID_PATTERN, runRootFor, SUITE_KEY, SuiteRefusal, writePassphraseFile, type RunContext } from "../e2e/harness/run-context";
import { loadTools07a } from "../e2e/harness/tools-07a";

/**
 * Offline unit tests of the e2e run context (task 1.2): run identity and root derivation, the per-run temp directory and
 * passphrase file permissions, and the per-machine lock. Nothing here talks to a node; the temp directories live in the
 * OS tmpdir and are removed after each test.
 */
describe("run identity and run root", () => {
  it("accepts only ^[a-z0-9-]{8,}$ and matches the 07a pattern exactly", async () => {
    const tools = await loadTools07a();
    expect(RUN_ID_PATTERN.source).toBe(tools.runIdPattern.source);
    for (const good of ["abcd1234", "mfvx0k1a-0badf00d"]) {
      expect(isValidRunId(good)).toBe(true);
      expect(tools.isValidRunId(good)).toBe(true);
    }
    for (const bad of ["short", "ABCDEFGH", "abcd 1234", "abcd/1234", "../../etc", "", undefined, 12345678]) {
      expect(isValidRunId(bad)).toBe(false);
    }
  });

  it("derives the run root directly under the base and refuses invalid identifiers", () => {
    expect(BASE_PATH).toBe("/obsidian-vault-sync");
    expect(SUITE_KEY).toBe("obsidian-vault-e2e");
    expect(runRootFor("unittest-0001abcd")).toBe("/obsidian-vault-sync/e2e-unittest-0001abcd");
    expect(() => runRootFor("../x")).toThrow(SuiteRefusal);
    expect(() => runRootFor("short")).toThrow(/does not match/);
  });

  it("generates run identifiers that satisfy the pattern", async () => {
    const tools = await loadTools07a();
    for (let i = 0; i < 5; i += 1) expect(isValidRunId(tools.newRunId())).toBe(true);
  });
});

describe("per-run temp directory and passphrase file", () => {
  it("creates the run directory outside the repository with a 0700 secrets subdirectory", async () => {
    const tools = await loadTools07a();
    const context = await createRunContext();
    try {
      expect(isValidRunId(context.runId)).toBe(true);
      expect(context.runRoot).toBe(`/obsidian-vault-sync/e2e-${context.runId}`);
      expect(tools.isOutsideRepo(context.tempDir)).toBe(true);
      expect(tools.isOutsideRepo(context.passphraseFile)).toBe(true);
      expect(context.passphraseFile).toBe(join(context.secretsDir, "passphrase.txt"));
      expect((await stat(context.secretsDir)).mode & 0o777).toBe(0o700);
      expect(context.ownedKeysConfigFile).toBe(tools.ownedKeysConfigFile);
      expect(context.lockFile).toBe(tools.lockFile);
    } finally {
      await removeRunDir(context);
    }
  });

  it("writes the passphrase file 0600; removeRunDir wipes the whole run directory", async () => {
    const tools = await loadTools07a();
    const context = await createRunContext();
    await writePassphraseFile(context, "alpha-bravo-charlie-delta-echo");
    expect((await stat(context.passphraseFile)).mode & 0o777).toBe(0o600);
    await removeRunDir(context);
    await expect(stat(context.tempDir)).rejects.toThrow();
    expect(tools.isOutsideRepo(context.tempDir)).toBe(true);
  });

  it("refuses a passphrase file path inside the repository", async () => {
    const tools = await loadTools07a();
    const inside: RunContext = {
      runId: "unittest-0001abcd",
      runRoot: "/obsidian-vault-sync/e2e-unittest-0001abcd",
      tempDir: join(tools.repoRoot, "tmp-e2e-should-not-exist"),
      secretsDir: join(tools.repoRoot, "tmp-e2e-should-not-exist", "secrets"),
      passphraseFile: join(tools.repoRoot, "tmp-e2e-should-not-exist", "secrets", "passphrase.txt"),
      ownedKeysConfigFile: tools.ownedKeysConfigFile,
      lockFile: tools.lockFile,
    };
    await expect(writePassphraseFile(inside, "x-y-z")).rejects.toThrow(/inside the repository/);
  });
});

describe("per-machine lock", () => {
  it("refuses a second acquisition while the first holder lives", async () => {
    // 07a acquireLock registers an exit hook that unlinks the lock file when this test process ends; a stale lock of a
    // dead pid is replaced by 07a itself.
    await acquireRunLock();
    await expect(acquireRunLock()).rejects.toThrow(/in progress/);
  });
});
