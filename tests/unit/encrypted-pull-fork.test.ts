// mvp-07a task 4.7: fork resolution (design decision 9; spec rollback-detection "Fork resolution"). Two devices over the fake node:
// A and B both start from sequence 1 and each publish a sequence 2 to their own copy of the node; A then pulls B's node with
// --resolve-fork, through the whole production path (`pullEncryptedVault`).
import { describe, expect, it } from "vitest";
import { createSyncEventBus, type ConflictEvent, type PullCompleteEvent } from "../../src/core/events";
import { createFilesMap, encodeManifestFile } from "../../src/sync/encrypted-manifest";
import { sha256Hex } from "../../src/sync/hash";
import { parseHistoryName } from "../../src/sync/history-names";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { writeRootState } from "../../src/sync/root-state";
import { raiseFloor, readFloor } from "../../src/sync/sequence-floor";
import { expectOnlyReads, newPuller, pointNameAt, publishedOnce, resetNodeTrace, servedRoot, type Puller } from "../helpers/encrypted-pull-rig";
import { ROOT, SECRET_WORD, restoreRig, snapshotRig, type Rig } from "../helpers/publish-rig";
import { publishAsSecondDevice, pulledOf, runVaultPull, stateOf, vaultTexts } from "../helpers/pull-stage-rig";
import { manifestFor } from "../vectors/manifest-helpers";

const DAILY = "Daily/2026-09-30.md";
const PLAN = "Projects/Secret Merger/Quarterly plan.md";
const ORIGINAL_DAILY = `# Notes\nCall about ${SECRET_WORD}.\n`;
const ORIGINAL_PLAN = `The ${SECRET_WORD} merger closes in the third quarter.\n`;
const A_DAILY = "A wrote this daily note.\n";
const B_DAILY = "B wrote this daily note.\n";
const A_PLAN = "A rewrote the quarterly plan.\n";
const FORK = { flags: { resolveFork: true } };

interface Fork {
  /** The device that lost: it published sequence 2 (identity X) to its own node and holds the files. */
  readonly rigA: Rig;
  /** Device B's node: it serves B's sequence 2 (identity Y). */
  readonly rigB: Rig;
  readonly a: Puller;
  readonly x: string;
  readonly y: string;
}

/** A and B start from the same sequence 1; each edits and publishes a sequence 2; A's device then looks at B's node. */
async function fork(aEdits: Record<string, string>, bEdits: Record<string, string>): Promise<Fork> {
  const rigA = await publishedOnce();
  const rigB = restoreRig(snapshotRig(rigA));
  servedRoot(rigB.node);
  const b = newPuller();
  pulledOf(await runVaultPull(rigB, b));

  rigA.host.clock += 60_000;
  for (const [path, text] of Object.entries(aEdits)) rigA.host.put(path, text);
  expect((await rigA.publish()).sequence).toBe(2);

  for (const [path, text] of Object.entries(bEdits)) b.host.put(path, text);
  expect((await publishAsSecondDevice(rigB, b)).sequence).toBe(2);
  servedRoot(rigB.node); // registers the blocks of the root the name now serves, so they stay readable
  resetNodeTrace(rigB.node);

  const x = manifestIdentity(await rigA.manifest());
  const y = manifestIdentity(await rigB.manifest());
  expect(x).not.toBe(y);
  return { rigA, rigB, a: newPuller(rigA.host), x, y };
}

const historyKeys = (rig: Rig): string[] => [...rig.node.files.keys()].filter((key) => key.startsWith(`${ROOT}/manifests/`)).sort();

/** Rename every history file to the legacy `<cid>.enc` form an mvp-06 development build wrote. */
function useLegacyHistoryNames(rig: Rig): void {
  for (const key of historyKeys(rig)) {
    const parsed = parseHistoryName(key.slice(key.lastIndexOf("/") + 1));
    const bytes = rig.node.files.get(key);
    if (parsed === undefined || bytes === undefined) throw new Error("fixture changed");
    rig.node.files.delete(key);
    rig.node.files.set(`${ROOT}/manifests/${parsed.cid}.enc`, bytes);
  }
  pointNameAt(rig.node);
}

const historyKeyAt = (rig: Rig, sequence: number): string => {
  const prefix = `${ROOT}/manifests/${String(sequence).padStart(16, "0")}-`;
  const found = historyKeys(rig).filter((key) => key.startsWith(prefix));
  if (found.length !== 1 || found[0] === undefined) throw new Error("fixture changed");
  return found[0];
};

/** An authenticating sequence-1 manifest of the vault's own key that lists `PLAN` with the given content: what a hostile node holding the key could plant. */
async function genuineSequenceOne(rig: Rig, planText: string): Promise<Uint8Array> {
  const keys = await rig.keys();
  const manifest = await manifestFor(keys, [PLAN], { sequence: 1 });
  const entry = manifest.files[PLAN];
  if (entry === undefined) throw new Error("fixture changed");
  const files = createFilesMap([[PLAN, { ...entry, sha256: await sha256Hex(new TextEncoder().encode(planText)) }]]);
  return (await encodeManifestFile(keys, { ...manifest, files })).file;
}

const copyText = (host: Puller["host"], conflictPath: string): string | undefined => vaultTexts(host)[conflictPath];

describe("both devices edited the same note", () => {
  it("the node's text is at the path and this device's text is in the dated copy", async () => {
    const { rigA, rigB, a, y } = await fork({ [DAILY]: A_DAILY }, { [DAILY]: B_DAILY });
    const bus = createSyncEventBus();
    const conflicts: ConflictEvent[] = [];
    const completed: PullCompleteEvent[] = [];
    bus.on("conflict", (event) => void conflicts.push(event));
    bus.on("pull.complete", (event) => void completed.push(event));

    const { verified, result } = pulledOf(await runVaultPull(rigB, a, { deps: { bus }, options: FORK }));

    expect(verified.verdict.kind).toBe("fork-resolution");
    expect(result.verdict).toBe("fork-resolution");
    expect(result.sequence).toBe(2);
    expect(result.settlement.conflicts).toHaveLength(1);
    const [conflict] = result.settlement.conflicts;
    expect(conflict?.path).toBe(DAILY);
    expect(vaultTexts(rigA.host)[DAILY]).toBe(B_DAILY);
    expect(copyText(rigA.host, conflict?.conflictPath ?? "")).toBe(A_DAILY);
    expect(result.settlement.needsAttention).toBe(false);
    expect(result.forkResolution).toEqual({ ancestorUsed: true, note: undefined });
    expect(result.journalSetAside).toBeUndefined();
    expectOnlyReads(rigB.node);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ path: DAILY, conflictPath: conflict?.conflictPath });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ sequence: 2, conflicted: 1, complete: true });
    expect(y).toBe(verified.identity);
  });

  it("the state and the floor carry the node manifest's identity, previousIdentity is null and the sequence stays", async () => {
    const { rigA, rigB, a, x, y } = await fork({ [DAILY]: A_DAILY }, { [DAILY]: B_DAILY });
    const before = await stateOf(rigA.host);
    expect(before).toMatchObject({ manifestIdentity: x, highestIdentity: x });
    expect(before?.previousIdentity).not.toBeNull();

    pulledOf(await runVaultPull(rigB, a, { options: FORK }));

    const after = await stateOf(rigA.host);
    expect(after).toMatchObject({ sequence: 2, highestSequence: 2, manifestIdentity: y, highestIdentity: y, previousIdentity: null, complete: true, unmaterialized: [] });
    expect(after?.manifest.sequence).toBe(2);
    expect(await readFloor(a.store, after?.vaultId ?? "")).toMatchObject({ sequence: 2, identity: y });
  });

  it("a floor that holds this device's own identity at that sequence is replaced by the node's", async () => {
    const { rigA, rigB, x, y } = await fork({ [DAILY]: A_DAILY }, { [DAILY]: B_DAILY });
    const a = newPuller(rigA.host);
    const vaultId = (await stateOf(rigA.host))?.vaultId ?? "";
    await raiseFloor(a.store, vaultId, { sequence: 2, identity: x, at: 1 });

    const { verified } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));
    expect(verified.verdict.kind).toBe("fork-resolution");
    expect(await readFloor(a.store, vaultId)).toMatchObject({ sequence: 2, identity: y });

    // The fork is over: the same node again is the same manifest, not a fork.
    const again = pulledOf(await runVaultPull(rigB, a));
    expect(again.result.verdict).toBe("same");
  });

  it("the next publish is one sequence above and carries this device's copy", async () => {
    const { rigA, rigB, a } = await fork({ [DAILY]: A_DAILY }, { [DAILY]: B_DAILY });
    const { result } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));
    const copyPath = result.settlement.conflicts[0]?.conflictPath ?? "";

    const published = await publishAsSecondDevice(rigB, a);
    expect(published.published).toBe(true);
    expect(published.sequence).toBe(3);

    const c = newPuller();
    const pulled = pulledOf(await runVaultPull(rigB, c));
    expect(pulled.result.sequence).toBe(3);
    expect(vaultTexts(c.host)[DAILY]).toBe(B_DAILY);
    expect(vaultTexts(c.host)[copyPath]).toBe(A_DAILY);
    expect(vaultTexts(rigA.host)[DAILY]).toBe(B_DAILY);
  });
});

describe("only this device edited a note", () => {
  it("it stays as this device's text and is published in the next sequence; the note only the node changed is replaced", async () => {
    const { rigA, rigB, a } = await fork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });

    const { result } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));

    expect(result.forkResolution?.ancestorUsed).toBe(true);
    expect(result.settlement.conflicts).toEqual([]);
    expect(result.settlement.locallyModified).toEqual([PLAN]);
    expect(result.settlement.fetched).toEqual([DAILY]);
    expect(vaultTexts(rigA.host)[PLAN]).toBe(A_PLAN);
    expect(vaultTexts(rigA.host)[DAILY]).toBe(B_DAILY);

    expect((await publishAsSecondDevice(rigB, a)).sequence).toBe(3);
    const c = newPuller();
    pulledOf(await runVaultPull(rigB, c));
    expect(vaultTexts(c.host)[PLAN]).toBe(A_PLAN);
    expect(vaultTexts(c.host)[DAILY]).toBe(B_DAILY);
  });
});

describe("the common ancestor is unavailable", () => {
  it("legacy history names: every file that differs from the node's gets a copy, and the message says why", async () => {
    const { rigA, rigB, a } = await fork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    useLegacyHistoryNames(rigB);

    const { result } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));

    expect(result.forkResolution?.ancestorUsed).toBe(false);
    expect(result.forkResolution?.note).toMatch(/no history entry carries the sequence prefix 1/);
    expect(result.settlement.conflicts.map((conflict) => conflict.path).sort()).toEqual([DAILY, PLAN].sort());
    // The node's text takes each path, and no local text is lost.
    expect(vaultTexts(rigA.host)[PLAN]).toBe(ORIGINAL_PLAN);
    expect(vaultTexts(rigA.host)[DAILY]).toBe(B_DAILY);
    const copies = Object.fromEntries(result.settlement.conflicts.map((conflict) => [conflict.path, copyText(rigA.host, conflict.conflictPath)]));
    expect(copies[PLAN]).toBe(A_PLAN);
    expect(copies[DAILY]).toBe(ORIGINAL_DAILY);
  });

  it("previousIdentity null: no ancestor, and the message says this device has no record of what it built on", async () => {
    const { rigA, rigB, a } = await fork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    const state = await stateOf(rigA.host);
    if (state === undefined) throw new Error("fixture changed");
    await writeRootState(rigA.host.kv, { ...state, previousIdentity: null });

    const { result } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));

    expect(result.forkResolution?.ancestorUsed).toBe(false);
    expect(result.forkResolution?.note).toMatch(/no record of the manifest it built on/);
    expect(result.settlement.conflicts.map((conflict) => conflict.path).sort()).toEqual([DAILY, PLAN].sort());
    expect(vaultTexts(rigA.host)[PLAN]).toBe(ORIGINAL_PLAN);
    expect(copyText(rigA.host, result.settlement.conflicts.find((conflict) => conflict.path === PLAN)?.conflictPath ?? "")).toBe(A_PLAN);
  });

  it("a history entry that does not authenticate is no ancestor", async () => {
    const { rigA, rigB, a } = await fork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    rigB.node.files.set(historyKeyAt(rigB, 1), new TextEncoder().encode("not a manifest"));
    pointNameAt(rigB.node);

    const { result } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));

    expect(result.forkResolution?.ancestorUsed).toBe(false);
    expect(result.forkResolution?.note).toMatch(/do not identify the manifest this device built on/);
    expect(vaultTexts(rigA.host)[PLAN]).toBe(ORIGINAL_PLAN);
    expect(result.settlement.conflicts.map((conflict) => conflict.path)).toContain(PLAN);
  });
});

describe("two authenticating entries at the ancestor prefix", () => {
  it.each([
    ["sorts before", "a".repeat(30)],
    ["sorts after", "z".repeat(30)],
  ])("only the one matching previousIdentity is the base (the other %s)", async (_label, decoyCid) => {
    const { rigA, rigB, a } = await fork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    // A second genuine sequence-1 manifest, whose PLAN equals this device's edit: used as the base it would make PLAN a silent replace.
    rigB.node.files.set(`${ROOT}/manifests/0000000000000001-${decoyCid}.enc`, await genuineSequenceOne(rigB, A_PLAN));
    pointNameAt(rigB.node);

    const { result } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));

    expect(result.forkResolution).toEqual({ ancestorUsed: true, note: undefined });
    expect(result.settlement.conflicts).toEqual([]);
    expect(result.settlement.locallyModified).toEqual([PLAN]);
    expect(vaultTexts(rigA.host)[PLAN]).toBe(A_PLAN);
  });

  it("neither matching previousIdentity: there is no ancestor", async () => {
    const { rigA, rigB, a } = await fork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    rigB.node.files.set(historyKeyAt(rigB, 1), await genuineSequenceOne(rigB, ORIGINAL_PLAN));
    rigB.node.files.set(`${ROOT}/manifests/0000000000000001-${"c".repeat(30)}.enc`, await genuineSequenceOne(rigB, A_PLAN));
    pointNameAt(rigB.node);

    const { result } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));

    expect(result.forkResolution?.ancestorUsed).toBe(false);
    expect(vaultTexts(rigA.host)[PLAN]).toBe(ORIGINAL_PLAN);
    expect(copyText(rigA.host, result.settlement.conflicts.find((conflict) => conflict.path === PLAN)?.conflictPath ?? "")).toBe(A_PLAN);
  });
});

describe("a genuine sequence-N manifest that is not the one this device built on", () => {
  it("is not used as the base: the local text equal to it becomes a conflict copy, not a silent replace", async () => {
    const { rigA, rigB, a } = await fork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    rigB.node.files.set(historyKeyAt(rigB, 1), await genuineSequenceOne(rigB, A_PLAN));
    pointNameAt(rigB.node);

    const { result } = pulledOf(await runVaultPull(rigB, a, { options: FORK }));

    expect(result.forkResolution?.ancestorUsed).toBe(false);
    const planConflict = result.settlement.conflicts.find((conflict) => conflict.path === PLAN);
    expect(planConflict).toBeDefined();
    expect(copyText(rigA.host, planConflict?.conflictPath ?? "")).toBe(A_PLAN);
    expect(vaultTexts(rigA.host)[PLAN]).toBe(ORIGINAL_PLAN);
  });
});

describe("a fork cannot be accepted any other way", () => {
  it("--allow-rollback with an explicit target still refuses as a fork and writes nothing", async () => {
    const { rigA, rigB, a } = await fork({ [DAILY]: A_DAILY }, { [DAILY]: B_DAILY });
    const root = pointNameAt(rigB.node);
    const stateBefore = await stateOf(rigA.host);
    const writes = a.store.writes.length;

    const outcome = await runVaultPull(rigB, a, { options: { target: { kind: "root-cid", cid: root }, flags: { allowRollback: true } } });

    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") expect(outcome.stop.reason).toBe("fork");
    expect(vaultTexts(rigA.host)[DAILY]).toBe(A_DAILY);
    expect(await stateOf(rigA.host)).toEqual(stateBefore);
    expect(a.store.writes.length).toBe(writes);
  });

  it("--resolve-fork with an explicit target or with --allow-rollback is refused before any request", async () => {
    const { rigA, rigB, a } = await fork({ [DAILY]: A_DAILY }, { [DAILY]: B_DAILY });
    const root = pointNameAt(rigB.node);
    const cases = [
      { target: { kind: "root-cid" as const, cid: root }, flags: { resolveFork: true } },
      { target: { kind: "name" as const }, flags: { resolveFork: true, allowRollback: true } },
    ];
    for (const options of cases) {
      const outcome = await runVaultPull(rigB, a, { options });
      expect(outcome.kind).toBe("stopped");
      if (outcome.kind === "stopped") expect(outcome.stop.reason).toBe("flag-combination");
    }
    expect(vaultTexts(rigA.host)[DAILY]).toBe(A_DAILY);
  });

  it("a name pull without --resolve-fork refuses as a fork and names the flag", async () => {
    const { rigA, rigB, a } = await fork({ [DAILY]: A_DAILY }, { [DAILY]: B_DAILY });
    const outcome = await runVaultPull(rigB, a);
    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") {
      expect(outcome.stop.reason).toBe("fork");
      expect(outcome.stop.message).toContain("--resolve-fork");
    }
    expect(vaultTexts(rigA.host)[DAILY]).toBe(A_DAILY);
  });
});
