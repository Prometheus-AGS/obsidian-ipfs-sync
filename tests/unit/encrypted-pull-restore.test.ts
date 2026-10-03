// mvp-07a task 4.6c: restore semantics (design decision 8) and the pull events with their additive counts. A recording node
// serves a vault device A published twice; device B pulls sequence 2, then restores sequence 1 by its root CID with the
// rollback flag, through the whole production path (`pullEncryptedVault`).
import { describe, expect, it } from "vitest";
import { createSyncEventBus, type ConflictEvent, type PullCompleteEvent } from "../../src/core/events";
import { sha256Hex } from "../../src/sync/hash";
import type { EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { localDateStamp } from "../../src/sync/conflict-name";
import { readFloor } from "../../src/sync/sequence-floor";
import { currentRoot, expectOnlyReads, newPuller, NOW, publishAgain, publishedOnce, resetNodeTrace, type Puller } from "../helpers/encrypted-pull-rig";
import { SECRET_WORD, type Rig } from "../helpers/publish-rig";
import { partFiles, publishAsSecondDevice, pulledOf, runVaultPull, sourceTexts, stateOf, streamingSources, vaultTexts } from "../helpers/pull-stage-rig";

const DAILY = "Daily/2026-09-30.md";
const PLAN = "Projects/Secret Merger/Quarterly plan.md";
const BINARY = "attachment.bin";
const OLD_DAILY = `# Notes\nCall about ${SECRET_WORD}.\n`;
const NEW_DAILY = "A second edition of the daily note.\n";
const ALL = [BINARY, DAILY, PLAN].sort();

interface Scenario {
  readonly rig: Rig;
  /** Device B, holding sequence 2. */
  readonly b: Puller;
  /** The root CID and manifest of sequence 1. */
  readonly olderRoot: string;
  readonly older: EncryptedManifest;
}

async function scenario(): Promise<Scenario> {
  const rig = await publishedOnce();
  const olderRoot = currentRoot(rig.node);
  const older = await rig.manifest();
  await publishAgain(rig);
  const b = newPuller();
  pulledOf(await runVaultPull(rig, b));
  resetNodeTrace(rig.node);
  return { rig, b, olderRoot, older };
}

const restoreOptions = (olderRoot: string) => ({ target: { kind: "root-cid" as const, cid: olderRoot }, flags: { allowRollback: true } });

describe("a restore leaves the record alone", () => {
  it("manifest, sequence, highest*, complete and unmaterialized stay; restoredFrom is set; the mtimes of restored paths are dropped", async () => {
    const { rig, b, olderRoot } = await scenario();
    const before = await stateOf(b.host);
    const floorBefore = await readFloor(b.store, before?.vaultId ?? "");
    const floorWrites = b.store.writes.length;
    expect(vaultTexts(b.host)[DAILY]).toBe(NEW_DAILY);

    const { result, verified } = pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot) }));

    expect(verified.verdict.kind).toBe("restore");
    expect(result.verdict).toBe("restore");
    expect(result.settlement.fetched).toEqual([DAILY]);
    expect(result.settlement.needsAttention).toBe(false);
    expect(vaultTexts(b.host)[DAILY]).toBe(OLD_DAILY);
    expect(partFiles(b.host)).toEqual([]);
    expectOnlyReads(rig.node);

    const after = await stateOf(b.host);
    expect(after).toBeDefined();
    expect(after?.manifest).toEqual(before?.manifest);
    expect(after).toMatchObject({
      sequence: 2,
      manifestIdentity: before?.manifestIdentity,
      previousIdentity: before?.previousIdentity,
      highestSequence: 2,
      highestIdentity: before?.highestIdentity,
      complete: true,
      unmaterialized: [],
      rootCid: before?.rootCid,
      keyslotsSha256: before?.keyslotsSha256,
      restoredFrom: 1,
    });
    expect(after?.devicesSeen).toEqual(before?.devicesSeen);
    expect(Object.keys(after?.mtimes ?? {}).sort()).toEqual([BINARY, PLAN].sort());
    expect(after?.mtimes[PLAN]).toBe(before?.mtimes[PLAN]);
    // The sequence floor is never lowered or rewritten by a restore.
    expect(b.store.writes.length).toBe(floorWrites);
    expect(await readFloor(b.store, before?.vaultId ?? "")).toEqual(floorBefore);
    expect(result.journalSetAside).toBeUndefined();
  });

  it("the next publish is sequence + 1 and carries the restored contents", async () => {
    const { rig, b, olderRoot } = await scenario();
    pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot) }));
    resetNodeTrace(rig.node);

    const published = await publishAsSecondDevice(rig, b);
    expect(published.published).toBe(true);
    expect(published.sequence).toBe(3);
    expect(vaultTexts(b.host)[DAILY]).toBe(OLD_DAILY);

    const c = newPuller();
    const { result } = pulledOf(await runVaultPull(rig, c));
    expect(result.sequence).toBe(3);
    expect(vaultTexts(c.host)[DAILY]).toBe(OLD_DAILY);
    expect(await stateOf(b.host)).toMatchObject({ sequence: 3, highestSequence: 3 });
    expect((await stateOf(b.host))?.restoredFrom).toBeUndefined();
  });

  it("a plain pull after the restore leaves the restored files (they are local edits against the baseline)", async () => {
    const { rig, b, olderRoot } = await scenario();
    pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot) }));

    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(result.verdict).toBe("same");
    expect(result.settlement.locallyModified).toEqual([DAILY]);
    expect(result.settlement.fetched).toEqual([]);
    expect(result.settlement.conflicts).toEqual([]);
    expect(vaultTexts(b.host)[DAILY]).toBe(OLD_DAILY);
    expect((await stateOf(b.host))?.restoredFrom).toBeUndefined();
  });

  it("restore never deletes: a file the older version did not have stays", async () => {
    const { rig, b, olderRoot } = await scenario();
    b.host.put("Later/added-after.md", "added after the older version\n", 7_000);
    const { result } = pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot) }));
    expect(vaultTexts(b.host)["Later/added-after.md"]).toBe("added after the older version\n");
    expect(result.settlement.fetched).toEqual([DAILY]);
  });
});

describe("a failed file during a restore", () => {
  it("is reported with the exit-1 flag and leaves complete, unmaterialized and the baseline as they were", async () => {
    const { rig, b, olderRoot, older } = await scenario();
    const dailyBlob = older.files[DAILY]?.blob;
    if (dailyBlob === undefined) throw new Error("fixture changed");
    rig.node.sizeLie = (name) => (name === dailyBlob ? 99_999 : undefined);
    const before = await stateOf(b.host);

    const { result } = pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot) }));

    expect(result.settlement.integrityFailed.map((problem) => problem.path)).toEqual([DAILY]);
    expect(result.settlement.needsAttention).toBe(true);
    expect(vaultTexts(b.host)[DAILY]).toBe(NEW_DAILY);
    expect(partFiles(b.host)).toEqual([]);

    const after = await stateOf(b.host);
    expect(after?.complete).toBe(true);
    expect(after?.unmaterialized).toEqual([]);
    expect(after?.manifest).toEqual(before?.manifest);
    expect(after?.mtimes).toEqual(before?.mtimes);
    expect(result.state).toEqual(after);
  });

  it("a restore of a directory with a state that is incomplete leaves it incomplete; the paths the restore wrote leave unmaterialized (A-06)", async () => {
    const rig = await publishedOnce();
    const olderRoot = currentRoot(rig.node);
    await publishAgain(rig);
    const b = newPuller();
    // The sequence 2 pull is declined for size: every file is unfetched, so the state is incomplete and carries all three.
    pulledOf(await runVaultPull(rig, b, { options: { confirmAboveBytes: 1 } }));
    const before = await stateOf(b.host);
    expect(before).toMatchObject({ complete: false, unmaterialized: ALL });

    const { result } = pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot) }));
    expect(result.settlement.complete).toBe(true);
    expect([...result.settlement.fetched].sort()).toEqual(ALL);
    const after = await stateOf(b.host);
    expect(after).toMatchObject({ complete: false, unmaterialized: [], restoredFrom: 1, sequence: 2 });
    expect(after?.manifest).toEqual(before?.manifest);
    expect(result.state).toEqual(after);
  });

  it("a restore that fails a file keeps that path unmaterialized and drops only the paths it wrote (A-06)", async () => {
    const rig = await publishedOnce();
    const olderRoot = currentRoot(rig.node);
    const older = await rig.manifest();
    await publishAgain(rig);
    const b = newPuller();
    pulledOf(await runVaultPull(rig, b, { options: { confirmAboveBytes: 1 } }));
    const dailyBlob = older.files[DAILY]?.blob;
    if (dailyBlob === undefined) throw new Error("fixture changed");
    rig.node.sizeLie = (name) => (name === dailyBlob ? 99_999 : undefined);

    const { result } = pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot) }));
    expect(result.settlement.integrityFailed.map((problem) => problem.path)).toEqual([DAILY]);
    const after = await stateOf(b.host);
    expect(after?.unmaterialized).toEqual([DAILY]);
  });

  it("the publish after a restore of an unmaterialized path carries the restored contents, not the node's entry (A-06)", async () => {
    const rig = await publishedOnce();
    const olderRoot = currentRoot(rig.node);
    await publishAgain(rig);
    const b = newPuller();
    pulledOf(await runVaultPull(rig, b, { options: { confirmAboveBytes: 1 } }));
    pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot) }));
    expect(vaultTexts(b.host)[DAILY]).toBe(OLD_DAILY);

    const published = await publishAsSecondDevice(rig, b);

    expect(published.published).toBe(true);
    expect(published.carried).toEqual([]);
    const manifest = await rig.manifest();
    expect(manifest.files[DAILY]?.sha256).toBe(await sha256Hex(new TextEncoder().encode(OLD_DAILY)));
  });
});

describe("a restore into a directory with no state", () => {
  it("the floor is the record: the state is created with the older manifest as its baseline and the floor stays", async () => {
    const { rig, b, olderRoot, older } = await scenario();
    const fresh = newPuller(undefined, b.store);
    const floorWrites = b.store.writes.length;

    const { result } = pulledOf(await runVaultPull(rig, fresh, { options: restoreOptions(olderRoot) }));

    expect(result.verdict).toBe("restore");
    expect(Object.keys(older.files).sort()).toEqual(ALL);
    expect(vaultTexts(fresh.host)).toEqual({ ...sourceTexts(rig), [DAILY]: OLD_DAILY });
    const state = await stateOf(fresh.host);
    expect(state).toMatchObject({ sequence: 1, highestSequence: 2, restoredFrom: 1, complete: true, unmaterialized: [] });
    expect(state?.manifest.files).toEqual(older.files);
    expect(b.store.writes.length).toBe(floorWrites);
  });
});

describe("pull events carry additive counts and no secret", () => {
  function listen(): { bus: ReturnType<typeof createSyncEventBus>; pulls: PullCompleteEvent[]; conflicts: ConflictEvent[] } {
    const bus = createSyncEventBus();
    const pulls: PullCompleteEvent[] = [];
    const conflicts: ConflictEvent[] = [];
    bus.on("pull.complete", (event) => void pulls.push(event));
    bus.on("conflict", (event) => void conflicts.push(event));
    return { bus, pulls, conflicts };
  }

  it("a first pull emits one pull.complete with the counts and nothing about any path", async () => {
    const rig = await publishedOnce();
    const { bus, pulls, conflicts } = listen();
    const { verified } = pulledOf(await runVaultPull(rig, newPuller(), { deps: { bus } }));

    expect(conflicts).toEqual([]);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      rootCid: verified.target.rootCid,
      manifestCid: verified.manifest.rootCID,
      sequence: 1,
      complete: true,
      fetched: 3,
      unchanged: 0,
      conflicted: 0,
      failed: 0,
      integrityFailed: 0,
      unfetched: 0,
      policySkipped: 0,
      remoteDeleted: 0,
      locallyModified: 0,
      restored: 0,
      forcedReverify: false,
    });
    expect(pulls[0]?.durationMs).toBe(0);
    const text = JSON.stringify(pulls);
    for (const path of ALL) expect(text).not.toContain(path);
  });

  it("restored counts the unmaterialized paths a pull materialized; failures count failed", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    pulledOf(await runVaultPull(rig, b, { options: { confirmAboveBytes: 1 } }));
    const { bus, pulls } = listen();
    pulledOf(await runVaultPull(rig, b, { deps: { bus } }));
    expect(pulls[0]).toMatchObject({ fetched: 3, restored: 3, complete: true, failed: 0 });

    const declined = listen();
    pulledOf(await runVaultPull(rig, newPuller(), { options: { confirmAboveBytes: 1 }, deps: { bus: declined.bus } }));
    expect(declined.pulls[0]).toMatchObject({ fetched: 0, unfetched: 3, failed: 3, complete: false, restored: 0 });
  });

  it("a restore over a local edit emits the conflict with both hashes, and pull.complete reports the state's own completeness", async () => {
    const { rig, b, olderRoot, older } = await scenario();
    b.host.put(DAILY, "B edited the daily note.\n", 9_000);
    const { bus, pulls, conflicts } = listen();

    const { result } = pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot), deps: { bus } }));

    const copy = `Daily/2026-09-30 (ipfs conflict ${localDateStamp(NOW)}).md`;
    expect(result.settlement.conflicts).toEqual([{ path: DAILY, conflictPath: copy }]);
    expect(conflicts).toEqual([
      {
        path: DAILY,
        conflictPath: copy,
        localSha256: await sha256Hex(new TextEncoder().encode("B edited the daily note.\n")),
        remoteSha256: older.files[DAILY]?.sha256,
      },
    ]);
    expect(vaultTexts(b.host)[copy]).toBe("B edited the daily note.\n");
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ sequence: 1, fetched: 1, conflicted: 1, complete: true, integrityFailed: 0 });
  });

  it("a conflict made while the file was being fetched still reports the local hash", async () => {
    const { rig, b, olderRoot, older } = await scenario();
    const { bus, conflicts } = listen();
    const edited = "typed while the restore ran\n";
    const dailyBlob = older.files[DAILY]?.blob as string;
    const sources = {
      source: (location: Parameters<ReturnType<typeof streamingSources>["source"]>[0]) => {
        const inner = streamingSources(rig.node.client).source(location);
        return {
          totalLength: inner.totalLength,
          chunks: {
            async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
              if (location.path.endsWith(dailyBlob)) b.host.put(DAILY, edited, 9_500);
              yield* inner.chunks;
            },
          },
        };
      },
    };
    pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot), deps: { bus, sources } }));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.localSha256).toBe(await sha256Hex(new TextEncoder().encode(edited)));
  });

  it("no event carries a passphrase or file text", async () => {
    const { rig, b, olderRoot } = await scenario();
    b.host.put(DAILY, "B edited the daily note.\n", 9_000);
    const { bus, pulls, conflicts } = listen();
    pulledOf(await runVaultPull(rig, b, { options: restoreOptions(olderRoot), deps: { bus } }));
    const text = JSON.stringify([pulls, conflicts]);
    expect(text).not.toContain(String(rig.passphrase));
    expect(text).not.toContain(SECRET_WORD);
    expect(text).not.toContain("B edited");
  });
});
