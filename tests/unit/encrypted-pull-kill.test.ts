// mvp-07a task 4.6b: kill after each step of a pull that replaces, conflicts and fetches. At every kill point no vault path
// holds a partial file, a local edit is never lost, the state is the old one or the complete new one, and the next pull
// finishes the job.
import { describe, expect, it } from "vitest";
import { decodeRootState } from "../../src/sync/root-state";
import { rootFileNames } from "../../src/sync/root-files";
import { localDateStamp } from "../../src/sync/conflict-name";
import { NOW, newPuller, publishedOnce, resetNodeTrace, servedRoot, type Puller } from "../helpers/encrypted-pull-rig";
import { decodeText, ROOT, type Rig } from "../helpers/publish-rig";
import { partFiles, pulledOf, runVaultPull, vaultTexts } from "../helpers/pull-stage-rig";

const DAILY = "Daily/2026-09-30.md";
const PLAN = "Projects/Secret Merger/Quarterly plan.md";
const BINARY = "attachment.bin";
const NEW_FILE = "New/arrival.md";

const A_DAILY = "A edited the daily note, much longer than before.\n";
const A_PLAN = "A rewrote the plan.\n";
const A_NEW = "A added a note.\n";
const B_DAILY = "B edited it too.\n";

class Killed extends Error {
  constructor() {
    super("the process was killed");
    this.name = "Killed";
  }
}

interface Arming {
  readonly state: { ops: number; dead: boolean; limit: number };
  disarm(): void;
}

/** After `limit` mutating steps (host files, host records, device store) have completed, the process is dead: every later call throws. */
function arm(puller: Puller, limit: number): Arming {
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

interface Snapshot {
  readonly files: readonly (readonly [string, Uint8Array, number])[];
  readonly kv: readonly (readonly [string, Uint8Array])[];
  readonly store: readonly (readonly [string, Uint8Array])[];
}

function snapshotOf(puller: Puller): Snapshot {
  return {
    files: [...puller.host.files].map(([path, file]) => [path, Uint8Array.from(file.data), file.mtimeMs] as const),
    kv: [...puller.host.kvStore].map(([key, value]) => [key, Uint8Array.from(value)] as const),
    store: [...puller.store.entries].map(([name, value]) => [name, Uint8Array.from(value)] as const),
  };
}

function restoredFrom(snapshot: Snapshot): Puller {
  const puller = newPuller();
  for (const [path, data, mtimeMs] of snapshot.files) puller.host.put(path, Uint8Array.from(data), mtimeMs);
  for (const [key, value] of snapshot.kv) puller.host.kvStore.set(key, Uint8Array.from(value));
  for (const [name, value] of snapshot.store) puller.store.entries.set(name, Uint8Array.from(value));
  return puller;
}

async function publishEdits(rig: Rig, edits: Record<string, string>): Promise<void> {
  rig.host.clock += 60_000;
  for (const [path, text] of Object.entries(edits)) rig.host.put(path, text);
  await rig.publish();
  servedRoot(rig.node);
  resetNodeTrace(rig.node);
}

const COPY_PREFIX = `Daily/2026-09-30 (ipfs conflict ${localDateStamp(NOW)}`;

/** Device A at sequence 2; device B at sequence 1 with its own edit of the daily note. */
async function scenario(): Promise<{ rig: Rig; base: Snapshot; original: Record<string, string> }> {
  const rig = await publishedOnce();
  const first = newPuller();
  pulledOf(await runVaultPull(rig, first));
  const original = vaultTexts(first.host);
  const base = snapshotOf(first);
  await publishEdits(rig, { [DAILY]: A_DAILY, [PLAN]: A_PLAN, [NEW_FILE]: A_NEW });
  return { rig, base, original };
}

function deviceB(base: Snapshot): Puller {
  const puller = restoredFrom(base);
  puller.host.put(DAILY, B_DAILY, 5_000);
  return puller;
}

function expectNoPartialFile(puller: Puller, original: Record<string, string>): void {
  const texts = vaultTexts(puller.host);
  const copies = Object.keys(texts).filter((path) => path.startsWith(COPY_PREFIX));
  const expected = new Set([DAILY, PLAN, BINARY, NEW_FILE, ...copies]);
  expect(Object.keys(texts).filter((path) => !expected.has(path))).toEqual([]);
  expect([A_DAILY, B_DAILY]).toContain(texts[DAILY]);
  expect([original[PLAN], A_PLAN]).toContain(texts[PLAN]);
  expect(texts[BINARY]).toBe(original[BINARY]);
  if (NEW_FILE in texts) expect(texts[NEW_FILE]).toBe(A_NEW);
  for (const copy of copies) expect(texts[copy]).toBe(B_DAILY);
  // The local edit is never lost: if the node's text is in place, the edit is in a whole copy.
  if (texts[DAILY] === A_DAILY) expect(copies.length).toBeGreaterThan(0);
}

function expectOldOrCompleteState(puller: Puller, base: Snapshot): void {
  const bytes = puller.host.kvStore.get(rootFileNames(ROOT).state);
  expect(bytes).toBeDefined();
  const state = decodeRootState(bytes as Uint8Array<ArrayBuffer>);
  if (state.sequence === 1) {
    expect(bytes).toEqual(base.kv.find(([key]) => key === rootFileNames(ROOT).state)?.[1]); // untouched
    return;
  }
  // The new state exists only after every file is in place.
  const texts = vaultTexts(puller.host);
  expect(state).toMatchObject({ sequence: 2, complete: true, unmaterialized: [] });
  expect(texts[DAILY]).toBe(A_DAILY);
  expect(texts[PLAN]).toBe(A_PLAN);
  expect(texts[NEW_FILE]).toBe(A_NEW);
}

describe("a pull that replaces, conflicts and fetches, killed after each step", () => {
  it("leaves no partial file, loses no local edit, writes the state last, and the next pull finishes", async () => {
    const { rig, base, original } = await scenario();

    const dry = deviceB(base);
    const counter = arm(dry, Number.POSITIVE_INFINITY);
    pulledOf(await runVaultPull(rig, dry));
    const steps = counter.state.ops;
    expect(steps).toBeGreaterThanOrEqual(10);

    for (let kill = 1; kill <= steps + 1; kill++) {
      const puller = deviceB(base);
      const armed = arm(puller, kill);
      const outcome = await runVaultPull(rig, puller).then(
        () => "completed" as const,
        (error: unknown) => {
          if (!(error instanceof Killed)) throw error;
          return "killed" as const;
        },
      );
      if (kill <= steps) expect(outcome, `kill after step ${kill}`).toBe("killed");

      expectNoPartialFile(puller, original);
      expectOldOrCompleteState(puller, base);
      expect(puller.locks.file.bytes, `kill after step ${kill}`).toBeUndefined();

      armed.disarm();
      const resumed = pulledOf(await runVaultPull(rig, puller));
      expect(resumed.result.settlement.complete).toBe(true);
      const texts = vaultTexts(puller.host);
      expect(texts[DAILY], `resume after kill ${kill}`).toBe(A_DAILY);
      expect(texts[PLAN]).toBe(A_PLAN);
      expect(texts[NEW_FILE]).toBe(A_NEW);
      expect(texts[BINARY]).toBe(original[BINARY]);
      const copies = Object.keys(texts).filter((path) => path.startsWith(COPY_PREFIX));
      expect(copies.length).toBeGreaterThan(0);
      for (const copy of copies) expect(texts[copy]).toBe(B_DAILY);
      expect(partFiles(puller.host)).toEqual([]);
      const finalState = decodeRootState(puller.host.kvStore.get(rootFileNames(ROOT).state) as Uint8Array<ArrayBuffer>);
      expect(finalState).toMatchObject({ sequence: 2, highestSequence: 2, complete: true, unmaterialized: [] });
      expect(decodeText(puller.host.files.get(DAILY)?.data)).toBe(A_DAILY);
    }
  });

  it("a first pull into an empty directory killed after each step leaves only whole files, and the marker lets the next pull in", async () => {
    const rig = await publishedOnce();
    const probe = newPuller();
    const counter = arm(probe, Number.POSITIVE_INFINITY);
    pulledOf(await runVaultPull(rig, probe));
    const steps = counter.state.ops;
    const expected = vaultTexts(probe.host);

    for (let kill = 1; kill <= steps; kill++) {
      const puller = newPuller();
      const armed = arm(puller, kill);
      await expect(runVaultPull(rig, puller), `kill after step ${kill}`).rejects.toBeInstanceOf(Killed);
      for (const [path, text] of Object.entries(vaultTexts(puller.host))) expect(text, `${path} after kill ${kill}`).toBe(expected[path]);
      // The state is the last write: if it exists, every file is in place.
      if (puller.host.kvStore.has(rootFileNames(ROOT).state)) expect(vaultTexts(puller.host), `state after kill ${kill}`).toEqual(expected);
      armed.disarm();
      const resumed = pulledOf(await runVaultPull(rig, puller));
      expect(resumed.result.settlement.complete).toBe(true);
      expect(vaultTexts(puller.host)).toEqual(expected);
      expect(partFiles(puller.host)).toEqual([]);
    }
  });
});
