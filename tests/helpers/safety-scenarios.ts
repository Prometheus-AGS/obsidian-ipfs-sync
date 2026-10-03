import { expect } from "vitest";
import type { HostBridge } from "../../src/core/host-bridge";
import type { EncryptedPullOutcome } from "../../src/sync/encrypted-pull";
import type { PullStageResult } from "../../src/sync/encrypted-pull-stage";
import { createFilesMap, encodeManifestFile, serializeManifestV2 } from "../../src/sync/encrypted-manifest";
import { readJournal } from "../../src/sync/journal";
import { rootFileNames } from "../../src/sync/root-files";
import type { RootState } from "../../src/sync/root-state";
import { SEQUENCE_FLOOR_FILE, decodeFloor, type FloorEntry } from "../../src/sync/sequence-floor";
import { ABANDON_CONFIRMATION, abandonVault } from "../../src/sync/vault-keys";
import { entryFor, keysFrom, manifestFor } from "../vectors/manifest-helpers";
import { keyIdOf, pointNameAt, resetNodeTrace, servedRoot } from "./encrypted-pull-rig";
import { NodeKilled } from "./fake-kubo";
import { BINARY, DAILY, PLAN, blobReads, createDevices, editAndPublish, leftovers, mutatingCalls, type Device, type Devices } from "./integration-devices";
import { ROOT } from "./publish-rig";

/**
 * The six safety-critical integration scenarios of mvp-07a task 6.1 (forged manifest, flipped blob, replayed manifest, the
 * sequence floor after abandon, overlapping publishes, crash and resume), each as a DRIVER that runs the production path and
 * returns what it saw, and an ASSERTION that judges it. The guarded suites call both. The mutation witnesses
 * (`tests/integration/witness-*.test.ts`) call the same driver with one guard removed by an in-test module seam and require the
 * same assertion to throw, so each assertion is shown to fail when its guard is gone.
 */

/** Run `check` and require that it throws an assertion failure: the proof that a scenario can fail. Returns the failure's message. */
export function expectAssertionFailure(check: () => void): string {
  let failure: unknown;
  try {
    check();
  } catch (error) {
    failure = error;
  }
  expect(failure, "the scenario's assertions passed although the guard is disabled").toBeDefined();
  expect((failure as Error).name).toBe("AssertionError");
  return (failure as Error).message;
}

export interface PullObservation {
  readonly outcome: EncryptedPullOutcome<PullStageResult>;
  /** Blob reads and node mutations during this pull only. */
  readonly blobReads: readonly string[];
  readonly nodeMutations: readonly string[];
  /** Writes to the pulling directory and to its device store during this pull only. */
  readonly hostMutations: readonly string[];
  readonly storeWrites: readonly string[];
  /** The pulling directory's `publish.lock` is still there. */
  readonly lockLeft: boolean;
}

/** Pull `from`'s node into `device` and report what the pull did, counted from its first request. */
export async function observePull(devices: Devices, device: Device, options: Parameters<Device["pull"]>[0] = {}): Promise<PullObservation> {
  resetNodeTrace(devices.node);
  const hostBefore = device.host.mutations.length;
  const storeBefore = device.puller.store.writes.length;
  const outcome = await device.pull(options);
  return {
    outcome,
    blobReads: blobReads(devices.node),
    nodeMutations: mutatingCalls(devices.node),
    hostMutations: device.host.mutations.slice(hostBefore),
    storeWrites: device.puller.store.writes.slice(storeBefore),
    lockLeft: device.puller.locks.file.bytes !== undefined,
  };
}

export function stopOfObservation(observed: PullObservation): { readonly reason: string; readonly message: string } {
  if (observed.outcome.kind !== "stopped") throw new Error(`expected the pull to stop, it ${observed.outcome.kind}`);
  return observed.outcome.stop;
}

// ---- forged manifest -------------------------------------------------------------------------------------------------

export type Forgery = "plaintext" | "bit-flip" | "other-vault-key";

export interface ForgedObservation extends PullObservation {
  readonly forgery: Forgery;
  readonly directory: { readonly files: readonly string[]; readonly records: readonly string[] };
}

/** The node serves a `manifest.enc` that the vault key did not produce: a plain-text manifest, a flipped bit, or another vault's key. */
export async function runForgedManifest(forgery: Forgery): Promise<ForgedObservation> {
  const devices = await createDevices();
  const { rig, node, b } = devices;
  const real = await rig.manifest();
  let bytes: Uint8Array;
  if (forgery === "plaintext") {
    const keys = await rig.keys();
    const files = createFilesMap(Object.entries(real.files));
    files["Evil.md"] = await entryFor(keys, "Evil.md");
    bytes = serializeManifestV2({ ...real, files });
  } else if (forgery === "bit-flip") {
    bytes = Uint8Array.from(node.files.get(`${ROOT}/manifest.enc`) ?? new Uint8Array());
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  } else {
    const other = await keysFrom(0x31, 0x61);
    bytes = (await encodeManifestFile(other, await manifestFor(other, [DAILY]))).file;
  }
  node.files.set(`${ROOT}/manifest.enc`, bytes);
  pointNameAt(node);
  const observed = await observePull(devices, b);
  return { ...observed, forgery, directory: { files: [...b.host.files.keys()], records: [...b.host.kvStore.keys()] } };
}

/** Spec encrypted-pull "Forged manifest" and "Copy stored only after authentication": the pull aborts, requests no blob, writes nothing. */
export function assertForgedManifestRefused(observed: ForgedObservation): void {
  const stop = observed.outcome.kind === "stopped" ? observed.outcome.stop : undefined;
  expect(stop?.reason, `outcome ${observed.outcome.kind}`).toBe("manifest-not-authentic");
  expect(stop?.message).toContain("does not authenticate");
  expect(observed.blobReads).toEqual([]);
  expect(observed.nodeMutations).toEqual([]);
  expect(observed.hostMutations).toEqual([]);
  expect(observed.storeWrites).toEqual([]);
  expect(observed.directory).toEqual({ files: [], records: [] });
  expect(observed.lockLeft).toBe(false);
}

// ---- flipped blob ---------------------------------------------------------------------------------------------------

export interface FlippedObservation extends PullObservation {
  readonly flipped: string;
  readonly published: Record<string, string>;
  readonly texts: Record<string, string>;
  readonly leftovers: readonly string[];
  readonly state: RootState | undefined;
}

/** One bit of one blob differs from what the authenticated tree holds. */
export async function runFlippedBlob(): Promise<FlippedObservation> {
  const devices = await createDevices();
  const { rig, node, a, b } = devices;
  const manifest = await rig.manifest();
  const entry = manifest.files[PLAN];
  if (entry === undefined) throw new Error("the fixture changed");
  const blobCid = node.cidOf(`${ROOT}/current/${entry.blob.slice(0, 2)}/${entry.blob}`) as string;
  const original = node.bytesOf(blobCid) as Uint8Array;
  node.corruptRead = (cid) => {
    if (cid !== blobCid) return undefined;
    const flipped = Uint8Array.from(original);
    flipped[Math.floor(flipped.length / 2)] = (flipped[Math.floor(flipped.length / 2)] ?? 0) ^ 0x10;
    return flipped;
  };
  const observed = await observePull(devices, b);
  return { ...observed, flipped: PLAN, published: a.texts(), texts: b.texts(), leftovers: leftovers(b.host), state: await b.state() };
}

/** Spec encrypted-pull "Tampered blob": that file is `integrity-failed`, the destination is unchanged, no part file remains, the state is incomplete, the others arrive. */
export function assertFlippedBlobFailsAlone(observed: FlippedObservation): void {
  expect(observed.outcome.kind).toBe("completed");
  if (observed.outcome.kind !== "completed") return;
  const { settlement } = observed.outcome.result;
  expect(settlement.integrityFailed.map((problem) => problem.path)).toEqual([observed.flipped]);
  expect(settlement.fetched).not.toContain(observed.flipped);
  expect(settlement.complete).toBe(false);
  expect(settlement.needsAttention).toBe(true);
  expect(Object.keys(observed.texts).sort()).toEqual([BINARY, DAILY].sort());
  for (const path of [BINARY, DAILY]) expect(observed.texts[path]).toBe(observed.published[path]);
  expect(observed.leftovers).toEqual([]);
  expect(observed.state).toMatchObject({ complete: false, unmaterialized: [observed.flipped] });
  expect(observed.nodeMutations).toEqual([]);
}

// ---- replayed older manifest by name ----------------------------------------------------------------------------------

export interface ReplayObservation extends PullObservation {
  readonly devices: Devices;
  readonly olderRoot: string;
  readonly before: { readonly texts: Record<string, string>; readonly state: RootState | undefined; readonly floor: FloorEntry | undefined };
  readonly after: { readonly texts: Record<string, string>; readonly state: RootState | undefined; readonly floor: FloorEntry | undefined };
}

/** The floor entry in the device store, decoded directly (not through `readFloor`, so a witness that blinds the pull's floor read cannot blind the observer). */
function floorOf(device: Device, state: RootState | undefined): FloorEntry | undefined {
  const bytes = device.puller.store.entries.get(SEQUENCE_FLOOR_FILE);
  return bytes === undefined || state === undefined ? undefined : decodeFloor(bytes).floors[state.vaultId];
}

/** A published sequence 1 and 2; B pulled sequence 2; then the node's name is set back to the sequence 1 root. */
export async function runReplayByName(): Promise<ReplayObservation> {
  const devices = await createDevices();
  const { rig, node, a, b } = devices;
  const olderRoot = servedRoot(node);
  await editAndPublish(rig, a, { [DAILY]: "A's second edition of the daily note.\n" });
  pointNameAt(node);
  const first = await b.pull();
  if (first.kind !== "completed") throw new Error(`the baseline pull stopped: ${first.stop.message}`);
  const stateBefore = await b.state();
  const before = { texts: b.texts(), state: stateBefore, floor: floorOf(b, stateBefore) };
  pointNameAt(node, olderRoot);
  const observed = await observePull(devices, b);
  const stateAfter = await b.state();
  return { ...observed, devices, olderRoot, before, after: { texts: b.texts(), state: stateAfter, floor: floorOf(b, stateAfter) } };
}

/** Spec rollback-detection "Older root served by name": refused without the rollback flag in the message, vault, state and floor unchanged. */
export function assertReplayRefused(observed: ReplayObservation): void {
  const stop = observed.outcome.kind === "stopped" ? observed.outcome.stop : undefined;
  expect(stop?.reason, `outcome ${observed.outcome.kind}`).toBe("older");
  expect(stop?.message).toContain("sequence 1");
  expect(stop?.message).toContain("recorded sequence 2");
  expect(stop?.message).not.toMatch(/--allow-rollback|rollback/i);
  expect(observed.after.texts).toEqual(observed.before.texts);
  expect(observed.after.state).toEqual(observed.before.state);
  expect(observed.after.floor).toEqual(observed.before.floor);
  expect(observed.blobReads).toEqual([]);
  expect(observed.hostMutations).toEqual([]);
  expect(observed.storeWrites).toEqual([]);
  expect(observed.lockLeft).toBe(false);
}

// ---- the floor after abandon ------------------------------------------------------------------------------------------

export interface FloorObservation extends PullObservation {
  readonly floorBefore: FloorEntry | undefined;
  readonly floorAfter: FloorEntry | undefined;
  readonly texts: Record<string, string>;
  readonly expectedTexts: Record<string, string>;
  readonly stateFile: boolean;
  readonly abandoned: { readonly moved: number; readonly floor: string };
}

/**
 * B reached sequence 2, abandons the directory, and the node then serves sequence 1 to a pull into it. `beforeAttack` runs right
 * before that last pull: where a mutation witness arms its seam, so that only the pull's own floor read is affected.
 */
export async function runFloorAfterAbandon(beforeAttack: () => void = () => undefined): Promise<FloorObservation> {
  const devices = await createDevices({ bRecordsInFiles: true });
  const { rig, node, a, b } = devices;
  const olderRoot = servedRoot(node);
  await editAndPublish(rig, a, { [DAILY]: "A's second edition of the daily note.\n" });
  pointNameAt(node);
  const first = await b.pull();
  if (first.kind !== "completed") throw new Error(`the baseline pull stopped: ${first.stop.message}`);
  const state = await b.state();
  const floorBefore = floorOf(b, state);
  const expectedTexts = b.texts();
  const abandoned = await abandonVault({ fs: b.host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1_800_000_000_000, deviceStore: b.puller.store });
  pointNameAt(node, olderRoot);
  beforeAttack();
  const observed = await observePull(devices, b);
  return {
    ...observed,
    floorBefore,
    floorAfter: floorOf(b, state),
    texts: b.texts(),
    expectedTexts,
    stateFile: b.host.files.has(`.ipfs-sync/${rootFileNames(ROOT).state}`),
    abandoned: { moved: abandoned.moved.length, floor: abandoned.floor.status },
  };
}

/** Spec rollback-detection "Abandon then pull older": the floor makes the pull refuse the older state and name the recorded sequence; nothing is written. */
export function assertFloorRefusesOlderAfterAbandon(observed: FloorObservation): void {
  // This directory holds a key-slot copy and a state (no journal): abandon moves both and keeps the floor.
  expect(observed.abandoned).toEqual({ moved: 2, floor: "kept" });
  expect(observed.floorBefore?.sequence).toBe(2);
  const stop = observed.outcome.kind === "stopped" ? observed.outcome.stop : undefined;
  expect(stop?.reason, `outcome ${observed.outcome.kind}`).toBe("older");
  expect(stop?.message).toContain("recorded sequence 2");
  expect(observed.floorAfter).toEqual(observed.floorBefore);
  expect(observed.texts).toEqual(observed.expectedTexts);
  expect(observed.stateFile).toBe(false);
  expect(observed.blobReads).toEqual([]);
  expect(observed.hostMutations).toEqual([]);
  expect(observed.storeWrites).toEqual([]);
}

// ---- overlapping publishes -------------------------------------------------------------------------------------------

export interface OverlapObservation {
  readonly devices: Devices;
  /** How the loser's publish ended: a refusal code, an error name, or `published`. */
  readonly loserEnded: string;
  readonly loserMessage: string;
  /** The immutable root the winner's completed publish made the name serve. */
  readonly rootOfWinner: string;
  readonly nameAfter: string | undefined;
  /** Name publications requested after the winner's publish was complete. */
  readonly publishesAfterWinner: readonly string[];
  readonly loserState: RootState | undefined;
  readonly loserJournal: string;
}

export type WinnerEdit = "adds-a-file" | "replaces-a-file";

/**
 * Two processes publish at once. The loser (device B, which pulled sequence 1) has read the node and the name and is held at
 * its first write; the winner (device A) then publishes a complete sequence 2; the loser goes on. An added file leaves the
 * tree consistent with the loser's manifest, so only the name re-check can stop it; a replaced file removes a blob the loser
 * names, so the read-back stops it first.
 */
export async function runOverlappingPublishes(winnerEdit: WinnerEdit = "adds-a-file"): Promise<OverlapObservation> {
  const devices = await createDevices();
  const { rig, node, a, b } = devices;
  const first = await b.pull();
  if (first.kind !== "completed") throw new Error(`the loser's first pull stopped: ${first.stop.message}`);
  b.allowPublish();

  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  let held = false;
  const client = {
    ...node.client,
    filesWrite: async (...args: Parameters<typeof node.client.filesWrite>) => {
      if (!held) {
        held = true;
        reached();
        await gate;
      }
      return node.client.filesWrite(...args);
    },
  };
  b.host.clock += 60_000;
  b.host.put(PLAN, "B's edition, still being written.\n");
  const loserRun = b.publish({}, { client }).then(
    () => ({ ended: "published", message: "" }),
    (error: unknown) => ({ ended: (error as { code?: string }).code ?? (error as Error).name, message: (error as Error).message }),
  );
  await atGate;
  const edits: Record<string, string> = winnerEdit === "adds-a-file" ? { "Inbox/from-the-winner.md": "A added this note.\n" } : { [DAILY]: "A's edition of the daily note.\n" };
  const won = await editAndPublish(rig, a, edits);
  if (!won.published) throw new Error("the winner's publish did not go through");
  const rootOfWinner = servedRoot(node);
  const afterWinner = node.calls.length;
  release();
  const loser = await loserRun;
  return {
    devices,
    loserEnded: loser.ended,
    loserMessage: loser.message,
    rootOfWinner,
    nameAfter: node.published.get(keyIdOf(node)),
    publishesAfterWinner: node.calls.slice(afterWinner).filter((line) => line.startsWith("publish ")),
    loserState: await b.state(),
    loserJournal: (await readJournal(b.host.kv, ROOT)).kind,
  };
}

/** Nothing the loser did moved the name off the winner's root, and its own record is still sequence 1. */
function assertLoserDidNotPublish(observed: OverlapObservation): void {
  expect(observed.rootOfWinner).not.toBe("");
  expect(observed.publishesAfterWinner).toEqual([]);
  expect(observed.nameAfter).toBe(`/ipfs/${observed.rootOfWinner}`);
  expect(observed.loserState?.sequence).toBe(1);
}

/** Spec second-device-publish "Name moved during the publish": the loser does not publish, says an overlapping publish happened, leaves its journal; the name stays on the winner's root. */
export function assertOverlapRefused(observed: OverlapObservation): void {
  expect(observed.loserEnded).toBe("overlapping-publish");
  expect(observed.loserMessage).toContain("pull first");
  assertLoserDidNotPublish(observed);
  expect(observed.loserJournal).toBe("ok");
}

// ---- crash, foreign publish, resume ----------------------------------------------------------------------------------

export interface CrashObservation {
  readonly devices: Devices;
  /** A's first run died after its journal was written; this is how its rerun ended. */
  readonly rerunEnded: string;
  readonly rerunMessage: string;
  readonly rerunMutations: readonly string[];
  readonly rootOfB: string;
  readonly nameAfterRerun: string | undefined;
  readonly journalAfterRerun: string;
}

/** A host that dies right after the publish journal is written: the process is gone before `manifest.enc` is. */
export function dyingAfterJournal(host: HostBridge): HostBridge {
  return {
    ...host,
    kv: {
      ...host.kv,
      set: async (key, value) => {
        await host.kv.set(key, value);
        if (key.startsWith("journal.")) throw new NodeKilled(0);
      },
    },
  };
}

/** A crashes after writing its pending manifest to the journal (sequence 2); B publishes sequence 2; A reruns its publish. */
export async function runCrashForeignPublishResume(): Promise<CrashObservation> {
  const devices = await createDevices();
  const { rig, node, a, b } = devices;
  const first = await b.pull();
  if (first.kind !== "completed") throw new Error(`B's first pull stopped: ${first.stop.message}`);
  b.allowPublish();
  a.host.clock += 60_000;
  a.host.put(DAILY, "A's edition, written before the crash.\n");
  await expect(a.publish({}, { host: dyingAfterJournal(a.publishHost), dies: true })).rejects.toBeInstanceOf(NodeKilled);
  expect((await readJournal(a.host.kv, ROOT)).kind).toBe("ok");

  const published = await editAndPublish(rig, b, { [PLAN]: "B published sequence 2 while A was down.\n" });
  expect(published.sequence).toBe(2);
  const rootOfB = servedRoot(node);
  resetNodeTrace(node);

  let rerunEnded = "published";
  let rerunMessage = "";
  try {
    await a.publish();
  } catch (error) {
    rerunEnded = (error as { code?: string }).code ?? (error as Error).name;
    rerunMessage = (error as Error).message;
  }
  return {
    devices,
    rerunEnded,
    rerunMessage,
    rerunMutations: mutatingCalls(node),
    rootOfB,
    nameAfterRerun: node.published.get(keyIdOf(node)),
    journalAfterRerun: (await readJournal(a.host.kv, ROOT)).kind,
  };
}

/** Spec second-device-publish "Crash, foreign publish, resume": A neither publishes nor adopts over B's manifest, the refusal names an overlapping publish, the journal stays. */
export function assertCrashResumeRefused(observed: CrashObservation): void {
  expect(observed.rerunEnded).toBe("overlapping-publish");
  expect(observed.rerunMessage).toContain("pull first");
  expect(observed.rerunMutations).toEqual([]);
  expect(observed.nameAfterRerun).toBe(`/ipfs/${observed.rootOfB}`);
  expect(observed.journalAfterRerun).toBe("ok");
}
