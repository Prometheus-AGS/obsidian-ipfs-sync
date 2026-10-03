import { describe, expect, it } from "vitest";
import {
  decodeFloor,
  encodeFloor,
  FLOOR_VAULTS_MAX,
  mergeFloorBytes,
  mergeFloors,
  raiseFloor,
  readFloor,
  SEQUENCE_FLOOR_FILE,
  SequenceFloorError,
  type FloorEntry,
} from "../../src/sync/sequence-floor";
import { ABANDON_CONFIRMATION, abandonVault, rootDigest } from "../../src/sync/vault-keys";
import { createMemoryDeviceStore } from "../helpers/memory-device-store";
import { createMemoryHost } from "../helpers/memory-host";

const MFS_ROOT = "/obsidian-vault-sync/floor-test";
const VAULT = "a".repeat(32);
const OTHER = "b".repeat(32);
const ID_A = "1".repeat(64);
const ID_B = "2".repeat(64);

const entry = (sequence: number, identity = ID_A, at = 1000): FloorEntry => ({ sequence, identity, at });
const vaultIdOf = (index: number): string => index.toString(16).padStart(32, "0");

describe("sequence floor", () => {
  it("keeps the highest sequence per vaultId and ignores a lower write", async () => {
    const store = createMemoryDeviceStore();
    await raiseFloor(store, VAULT, entry(5));
    await raiseFloor(store, OTHER, entry(2, ID_B));
    expect(await raiseFloor(store, VAULT, entry(3, ID_B, 2000))).toEqual(entry(5));
    expect(await readFloor(store, VAULT)).toEqual(entry(5));
    expect(await readFloor(store, OTHER)).toEqual(entry(2, ID_B));
    await raiseFloor(store, VAULT, entry(7, ID_B, 3000));
    expect(await readFloor(store, VAULT)).toEqual(entry(7, ID_B, 3000));
  });

  it("keeps the stored identity at an equal sequence, except for a fork resolution", async () => {
    const store = createMemoryDeviceStore();
    await raiseFloor(store, VAULT, entry(5, ID_A));
    await raiseFloor(store, VAULT, entry(5, ID_B, 2000));
    expect((await readFloor(store, VAULT))?.identity).toBe(ID_A);
    await raiseFloor(store, VAULT, entry(5, ID_B, 2000), { forkResolution: true });
    expect(await readFloor(store, VAULT)).toEqual(entry(5, ID_B, 2000));
  });

  it("re-reads the stored file on every write (a value another writer stored is not lost)", async () => {
    const store = createMemoryDeviceStore();
    await raiseFloor(store, VAULT, entry(5));
    // Another process raised a different vault between this process's read and write: simulated by writing it first.
    const other = createMemoryDeviceStore();
    await raiseFloor(other, OTHER, entry(9, ID_B));
    store.entries.set(SEQUENCE_FLOOR_FILE, other.entries.get(SEQUENCE_FLOOR_FILE) ?? new Uint8Array());
    await raiseFloor(store, VAULT, entry(6));
    expect((await readFloor(store, OTHER))?.sequence).toBe(9);
  });

  it("caps at 64 vaults and drops the oldest by time", async () => {
    const store = createMemoryDeviceStore();
    for (let index = 0; index < FLOOR_VAULTS_MAX + 3; index += 1) await raiseFloor(store, vaultIdOf(index), entry(1, ID_A, 1000 + index));
    const floor = decodeFloor(store.entries.get(SEQUENCE_FLOOR_FILE) ?? new Uint8Array());
    expect(Object.keys(floor.floors)).toHaveLength(FLOOR_VAULTS_MAX);
    expect(floor.floors[vaultIdOf(0)]).toBeUndefined();
    expect(floor.floors[vaultIdOf(2)]).toBeUndefined();
    expect(floor.floors[vaultIdOf(3)]).toBeDefined();
    expect(floor.floors[vaultIdOf(FLOOR_VAULTS_MAX + 2)]).toBeDefined();
  });

  it("is unchanged by abandonVault and by deleting the .ipfs-sync/ folder", async () => {
    const store = createMemoryDeviceStore();
    await raiseFloor(store, VAULT, entry(5));
    const before = store.entries.get(SEQUENCE_FLOOR_FILE);
    const host = createMemoryHost();
    const digest = await rootDigest(MFS_ROOT);
    host.put(`.ipfs-sync/state.${digest}.json`, "{}");
    host.put(`.ipfs-sync/keyslots.${digest}.json`, "{}");
    expect((await abandonVault({ fs: host.fs, mfsRoot: MFS_ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1 })).moved).toHaveLength(2);
    for (const path of [...host.files.keys()]) host.drop(path);
    expect(host.files.size).toBe(0);
    expect(store.entries.get(SEQUENCE_FLOOR_FILE)).toBe(before);
    expect(store.writes).toEqual([SEQUENCE_FLOOR_FILE]);
    expect(await readFloor(store, VAULT)).toEqual(entry(5));
  });

  it("refuses a damaged file with the recovery in the message and never repairs it", async () => {
    const store = createMemoryDeviceStore();
    store.entries.set(SEQUENCE_FLOOR_FILE, new TextEncoder().encode("{not json"));
    const failure = await raiseFloor(store, VAULT, entry(1)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SequenceFloorError);
    expect((failure as Error).message).toContain("delete it");
    expect(store.writes).toEqual([]);
  });

  it.each([
    ["wrong version", { version: 2, floors: {} }],
    ["bad vault id", { version: 1, floors: { nope: entry(1) } }],
    ["bad identity", { version: 1, floors: { [VAULT]: { sequence: 1, identity: "x", at: 1 } } }],
    ["zero sequence", { version: 1, floors: { [VAULT]: entry(0) } }],
    ["fractional time", { version: 1, floors: { [VAULT]: { sequence: 1, identity: ID_A, at: 1.5 } } }],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeFloor(new TextEncoder().encode(JSON.stringify(value)))).toThrow(SequenceFloorError);
  });

  it("round trips through the encoder", () => {
    const floor = mergeFloors({ version: 1, floors: {} }, { version: 1, floors: { [VAULT]: entry(4) } });
    expect(decodeFloor(encodeFloor(floor))).toEqual(floor);
  });

  it("mergeFloorBytes prefers the side that decodes and never throws", () => {
    const good = encodeFloor({ version: 1, floors: { [VAULT]: entry(4) } });
    const bad = new TextEncoder().encode("garbage");
    expect(mergeFloorBytes(good, bad)).toBe(good);
    expect(mergeFloorBytes(bad, good)).toBe(good);
    expect(mergeFloorBytes(undefined, good)).toBe(good);
    expect(mergeFloorBytes(good, undefined)).toBe(good);
    expect(mergeFloorBytes(undefined, undefined)).toBeUndefined();
  });
});
