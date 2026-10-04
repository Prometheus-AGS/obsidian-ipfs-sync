import { expect } from "vitest";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { newPuller, publishedOnce, resetNodeTrace, servedRoot, type Puller } from "./encrypted-pull-rig";
import { restoreRig, snapshotRig, type Rig } from "./publish-rig";
import { publishAsSecondDevice, pulledOf, runVaultPull, type StageOverrides } from "./pull-stage-rig";

/**
 * Kill-after-each-step rig for the pull stage (mvp-07b task 4.10). `arm` makes the process-equivalent die after the Nth mutation of
 * the device (host file write, mkdir, remove, rename, append; host record set or delete; device-store write): the call completes,
 * then every later call of the device throws `Killed`. Reads are free. The node is not armed: a pull only reads it, and the tests
 * assert that.
 */

export class Killed extends Error {
  constructor() {
    super("the process was killed");
    this.name = "Killed";
  }
}

export interface Arming {
  readonly state: { ops: number; dead: boolean; limit: number };
  disarm(): void;
}

/** After `limit` mutating steps have completed, the process is dead: every later call throws. `Infinity` only counts the steps. */
export function arm(puller: Puller, limit: number): Arming {
  const state = { ops: 0, dead: false, limit };
  const alive = (): void => {
    if (state.dead) throw new Killed();
  };
  const step = (): void => {
    state.ops += 1;
    if (state.ops >= state.limit) {
      state.dead = true;
      throw new Killed();
    }
  };
  const { fs, kv } = puller.host;
  const original = {
    list: fs.list.bind(fs),
    stat: fs.stat.bind(fs),
    read: fs.read.bind(fs),
    readRange: fs.readRange.bind(fs),
    lstat: fs.lstat.bind(fs),
    write: fs.write.bind(fs),
    mkdir: fs.mkdir.bind(fs),
    remove: fs.remove.bind(fs),
    rename: fs.rename.bind(fs),
    append: fs.append.bind(fs),
    get: kv.get.bind(kv),
    list_: kv.list.bind(kv),
    set: kv.set.bind(kv),
    delete: kv.delete.bind(kv),
    storeGet: puller.store.get.bind(puller.store),
    storeSet: puller.store.set.bind(puller.store),
  };
  fs.list = async (dir) => (alive(), original.list(dir));
  fs.stat = async (path) => (alive(), original.stat(path));
  fs.read = async (path) => (alive(), original.read(path));
  fs.readRange = async (path, offset, length) => (alive(), original.readRange(path, offset, length));
  fs.lstat = async (path) => (alive(), original.lstat(path));
  fs.write = async (path, data) => (alive(), await original.write(path, data), step());
  fs.mkdir = async (path) => (alive(), await original.mkdir(path), step());
  fs.remove = async (path) => (alive(), await original.remove(path), step());
  fs.rename = async (from, to) => (alive(), await original.rename(from, to), step());
  fs.append = async (path, data) => (alive(), await original.append(path, data), step());
  kv.get = async (key) => (alive(), original.get(key));
  kv.list = async (prefix) => (alive(), original.list_(prefix));
  kv.set = async (key, value) => (alive(), await original.set(key, value), step());
  kv.delete = async (key) => (alive(), await original.delete(key), step());
  puller.store.get = async (name) => (alive(), original.storeGet(name));
  puller.store.set = async (name, bytes) => (alive(), await original.storeSet(name, bytes), step());
  return {
    state,
    disarm: () => {
      state.limit = Number.POSITIVE_INFINITY;
      state.dead = false;
    },
  };
}

/** A copy of a device: its directory (files and mtimes), its host records and its device store. */
export interface Snapshot {
  readonly files: readonly (readonly [string, Uint8Array, number])[];
  readonly kv: readonly (readonly [string, Uint8Array])[];
  readonly store: readonly (readonly [string, Uint8Array])[];
}

export function snapshotOf(puller: Puller): Snapshot {
  return {
    files: [...puller.host.files].map(([path, file]) => [path, Uint8Array.from(file.data), file.mtimeMs] as const),
    kv: [...puller.host.kvStore].map(([key, value]) => [key, Uint8Array.from(value)] as const),
    store: [...puller.store.entries].map(([name, value]) => [name, Uint8Array.from(value)] as const),
  };
}

/** A new device holding exactly what the snapshot held. */
export function restoredFrom(snapshot: Snapshot): Puller {
  const puller = newPuller();
  for (const [path, data, mtimeMs] of snapshot.files) puller.host.put(path, Uint8Array.from(data), mtimeMs);
  for (const [key, value] of snapshot.kv) puller.host.kvStore.set(key, Uint8Array.from(value));
  for (const [name, value] of snapshot.store) puller.store.entries.set(name, Uint8Array.from(value));
  return puller;
}

/** The bytes of one device-store entry or host record in a snapshot. */
export const storedIn = (entries: Snapshot["kv"] | Snapshot["store"], name: string): Uint8Array | undefined => entries.find(([key]) => key === name)?.[1];

/** One pull of the armed device: `killed` when the kill point was reached, `completed` when the pull ran to its end (a kill point past the last step). */
export async function pullUntilKilled(rig: Rig, puller: Puller, overrides: StageOverrides): Promise<"killed" | "completed" | "stopped"> {
  try {
    const outcome = await runVaultPull(rig, puller, overrides);
    return outcome.kind === "completed" ? "completed" : "stopped";
  } catch (error: unknown) {
    if (error instanceof Killed) return "killed";
    throw error;
  }
}

/** Count the mutating steps of a pull on a copy of the device. */
export async function countSteps(rig: Rig, snapshot: Snapshot, overrides: StageOverrides): Promise<number> {
  const dry = restoredFrom(snapshot);
  const counter = arm(dry, Number.POSITIVE_INFINITY);
  pulledOf(await runVaultPull(rig, dry, overrides));
  return counter.state.ops;
}

export const FORK_FLAGS = { flags: { resolveFork: true } } as const;

export interface Fork {
  /** Device A's node: A published sequence 2 (identity X) to it. */
  readonly rigA: Rig;
  /** Device B's node: it serves B's sequence 2 (identity Y); the pulls read this one. */
  readonly rigB: Rig;
  readonly x: string;
  readonly y: string;
}

/** A and B start from the same sequence 1; each edits and publishes a sequence 2 to its own copy of the node. */
export async function makeFork(aEdits: Record<string, string>, bEdits: Record<string, string>): Promise<Fork> {
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
  servedRoot(rigB.node);
  resetNodeTrace(rigB.node);

  const x = manifestIdentity(await rigA.manifest());
  const y = manifestIdentity(await rigB.manifest());
  expect(x).not.toBe(y);
  return { rigA, rigB, x, y };
}
