// mvp-07b task 4.10: kill after each step of a restore (`pull --root-cid` / `--manifest` with the rollback flag) and of a fork
// resolution (`pull --resolve-fork`), through the whole production path (`pullEncryptedVault`). 07a reasoned these matrices and
// did not run them. At every kill point: no vault path holds a partial file, a local edit is never lost (it is at its path or in
// a whole conflict copy), the state is the old one or the complete new one and is written last, the sequence floor is never
// lowered, and the next run finishes the job or refuses with a specific stop.
import { describe, expect, it } from "vitest";
import { decodeRootState, writeRootState, type RootState } from "../../src/sync/root-state";
import { rootFileNames } from "../../src/sync/root-files";
import { localDateStamp } from "../../src/sync/conflict-name";
import { decodeFloor, raiseFloor, readFloor, type FloorEntry } from "../../src/sync/sequence-floor";
import { NOW, currentRoot, expectOnlyReads, newPuller, publishAgain, publishedOnce, type Puller } from "../helpers/encrypted-pull-rig";
import { FORK_FLAGS, arm, countSteps, makeFork, pullUntilKilled, restoredFrom, snapshotOf, storedIn, type Fork, type Snapshot } from "../helpers/pull-kill-rig";
import { ROOT, SECRET_WORD, type Rig } from "../helpers/publish-rig";
import { partFiles, pulledOf, runVaultPull, stateOf, vaultTexts } from "../helpers/pull-stage-rig";
import { createMemoryDeviceStore } from "../helpers/memory-device-store";

const DAILY = "Daily/2026-09-30.md";
const PLAN = "Projects/Secret Merger/Quarterly plan.md";
const BINARY = "attachment.bin";
const OLD_DAILY = `# Notes\nCall about ${SECRET_WORD}.\n`;
const ORIGINAL_PLAN = `The ${SECRET_WORD} merger closes in the third quarter.\n`;
const LATER = "Later/added-after.md";
const LATER_TEXT = "a note only this device has\n";
const STATE_KEY = rootFileNames(ROOT).state;
const FLOOR_FILE = "sequence-floor.json";
const COPY_PREFIX = `Daily/2026-09-30 (ipfs conflict ${localDateStamp(NOW)}`;

const copiesOf = (texts: Record<string, string>): string[] => Object.keys(texts).filter((path) => path.startsWith(COPY_PREFIX));
const rootStateOf = (puller: Puller): RootState => decodeRootState(puller.host.kvStore.get(STATE_KEY) as Uint8Array<ArrayBuffer>);

function expectOnly(texts: Record<string, string>, allowed: readonly string[], context: string): void {
  const expected = new Set([...allowed, ...copiesOf(texts)]);
  expect(Object.keys(texts).filter((path) => !expected.has(path)), `unexpected path ${context}`).toEqual([]);
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Files only the publishing device (A) has; a pull never touches them. */
const PUBLISHER_ONLY = [".trash/old.md", ".obsidian/workspace.json"];

/** The floor entry read from the store's bytes: `readFloor` would throw `Killed` on a dead device. */
function floorOf(puller: Puller, vaultId: string): FloorEntry | undefined {
  const bytes = puller.store.entries.get(FLOOR_FILE);
  return bytes === undefined ? undefined : decodeFloor(bytes).floors[vaultId];
}

function expectFloorBytes(puller: Puller, base: Snapshot, context: string): void {
  expect(puller.store.entries.get(FLOOR_FILE), `floor ${context}`).toEqual(storedIn(base.store, FLOOR_FILE));
}

describe("a restore by root CID over a local edit, killed after each step", () => {
  /** Device B at sequence 2; the node has sequence 1 (the older root) and 2. */
  async function scenario(): Promise<{ rig: Rig; base: Snapshot; olderRoot: string }> {
    const rig = await publishedOnce();
    const olderRoot = currentRoot(rig.node);
    await publishAgain(rig);
    const b = newPuller();
    pulledOf(await runVaultPull(rig, b));
    b.host.put(LATER, LATER_TEXT, 6_000);
    return { rig, base: snapshotOf(b), olderRoot };
  }

  it("leaves no partial file, loses no edit, writes the state last, never touches the floor, and the rerun finishes", async () => {
    const { rig, base, olderRoot } = await scenario();
    const options = { target: { kind: "root-cid" as const, cid: olderRoot }, flags: { allowRollback: true } };
    const EDIT = "B edited the daily note before restoring.\n";
    const withEdit = (): Puller => {
      const puller = restoredFrom(base);
      puller.host.put(DAILY, EDIT, 9_000);
      return puller;
    };
    const dry = withEdit();
    const counter = arm(dry, Number.POSITIVE_INFINITY);
    pulledOf(await runVaultPull(rig, dry, { options }));
    const steps = counter.state.ops;
    expect(steps).toBeGreaterThanOrEqual(6); // conflict copy (temp, rename), the restored file (temp, rename), the state, and the marker-free directories

    const baseState = storedIn(base.kv, STATE_KEY);
    const original = { [PLAN]: vaultTexts(restoredFrom(base).host)[PLAN], [BINARY]: vaultTexts(restoredFrom(base).host)[BINARY] };
    for (let kill = 1; kill <= steps; kill++) {
      const puller = withEdit();
      const armed = arm(puller, kill);
      const outcome = await pullUntilKilled(rig, puller, { options });
      expect(outcome, `kill after step ${kill}`).toBe("killed");

      const texts = vaultTexts(puller.host);
      expectOnly(texts, [DAILY, PLAN, BINARY, LATER], `after kill ${kill}`);
      expect([EDIT, OLD_DAILY], `daily after kill ${kill}`).toContain(texts[DAILY]);
      expect(texts[PLAN]).toBe(original[PLAN]);
      expect(texts[BINARY]).toBe(original[BINARY]);
      expect(texts[LATER]).toBe(LATER_TEXT);
      for (const copy of copiesOf(texts)) expect(texts[copy], `copy after kill ${kill}`).toBe(EDIT);
      // The local edit is never lost: if the node's text replaced it, the edit is in a whole copy.
      if (texts[DAILY] === OLD_DAILY) expect(copiesOf(texts).length, `edit kept after kill ${kill}`).toBeGreaterThan(0);

      // The state is the old one until the last step; a restore never writes the floor.
      if (kill < steps) expect(puller.host.kvStore.get(STATE_KEY), `state after kill ${kill}`).toEqual(baseState);
      else expect(rootStateOf(puller).restoredFrom).toBe(1);
      expectFloorBytes(puller, base, `after kill ${kill}`);
      expect(puller.locks.file.bytes, `lock after kill ${kill}`).toBeUndefined();
      expectOnlyReads(rig.node);

      armed.disarm();
      const resumed = pulledOf(await runVaultPull(rig, puller, { options }));
      expect(resumed.result.verdict).toBe("restore");
      expect(resumed.result.settlement.needsAttention, `resume after kill ${kill}`).toBe(false);
      const after = vaultTexts(puller.host);
      expect(after[DAILY], `resume after kill ${kill}`).toBe(OLD_DAILY);
      expect(after[LATER]).toBe(LATER_TEXT);
      expect(copiesOf(after).length).toBeGreaterThan(0);
      for (const copy of copiesOf(after)) expect(after[copy]).toBe(EDIT);
      expect(partFiles(puller.host)).toEqual([]);
      expect(await stateOf(puller.host)).toMatchObject({ sequence: 2, highestSequence: 2, restoredFrom: 1, complete: true, unmaterialized: [] });
      expectFloorBytes(puller, base, `after resume ${kill}`);
      expect(await readFloor(puller.store, rootStateOf(puller).vaultId)).toMatchObject({ sequence: 2 });
    }
  });
});

describe("a restore by manifest CID into a directory with no state, killed after each step", () => {
  it("leaves only whole files, writes the state last, leaves the floor, and the marker lets the rerun in", async () => {
    const rig = await publishedOnce();
    const older = await rig.manifest();
    await publishAgain(rig);
    const b = newPuller();
    pulledOf(await runVaultPull(rig, b));
    const floor = b.store.entries.get(FLOOR_FILE);
    expect(floor).toBeDefined();
    const options = { target: { kind: "manifest" as const, cid: older.rootCID }, flags: { allowRollback: true } };
    const fresh = (): Puller => {
      const store = createMemoryDeviceStore();
      store.entries.set(FLOOR_FILE, Uint8Array.from(floor as Uint8Array));
      return newPuller(undefined, store);
    };
    const probe = fresh();
    const counter = arm(probe, Number.POSITIVE_INFINITY);
    pulledOf(await runVaultPull(rig, probe, { options }));
    const steps = counter.state.ops;
    const expected = vaultTexts(probe.host);
    expect(expected[DAILY]).toBe(OLD_DAILY);
    expect(steps).toBeGreaterThanOrEqual(7); // marker, three files (temp, rename) and the state

    for (let kill = 1; kill <= steps; kill++) {
      const puller = fresh();
      const armed = arm(puller, kill);
      expect(await pullUntilKilled(rig, puller, { options }), `kill after step ${kill}`).toBe("killed");
      for (const [path, text] of Object.entries(vaultTexts(puller.host))) expect(text, `${path} after kill ${kill}`).toBe(expected[path]);
      // The state is the last write: if it exists, every file is in place.
      if (puller.host.kvStore.has(STATE_KEY)) expect(vaultTexts(puller.host), `state after kill ${kill}`).toEqual(expected);
      expect(puller.store.entries.get(FLOOR_FILE), `floor after kill ${kill}`).toEqual(floor);
      expect(puller.locks.file.bytes).toBeUndefined();
      expectOnlyReads(rig.node);

      armed.disarm();
      const resumed = pulledOf(await runVaultPull(rig, puller, { options }));
      expect(resumed.result.verdict).toBe("restore");
      expect(resumed.result.settlement.complete).toBe(true);
      expect(vaultTexts(puller.host)).toEqual(expected);
      expect(partFiles(puller.host)).toEqual([]);
      expect(await stateOf(puller.host)).toMatchObject({ sequence: 1, highestSequence: 2, restoredFrom: 1, complete: true, unmaterialized: [] });
      expect(puller.store.entries.get(FLOOR_FILE)).toEqual(floor);
    }
  });
});

describe("a fork resolution over a note both devices edited, killed after each step", () => {
  const A_DAILY = "A wrote this daily note.\n";
  const B_DAILY = "B wrote this daily note.\n";
  const A_PLAN = "A rewrote the quarterly plan.\n";
  const B_NEW = "B added a note.\n";
  const NEW_FILE = "New/from-b.md";

  async function scenario(): Promise<{ fork: Fork; base: Snapshot; vaultId: string }> {
    const fork = await makeFork({ [DAILY]: A_DAILY, [PLAN]: A_PLAN }, { [DAILY]: B_DAILY, [NEW_FILE]: B_NEW });
    const a = newPuller(fork.rigA.host);
    const vaultId = (await stateOf(fork.rigA.host))?.vaultId ?? "";
    // The floor holds this device's own identity at sequence 2, as a publish leaves it.
    await raiseFloor(a.store, vaultId, { sequence: 2, identity: fork.x, at: 1 });
    return { fork, base: snapshotOf(a), vaultId };
  }

  it("keeps the edit, writes the floor before the state, never lowers the floor, and the rerun finishes or refuses as a fork", async () => {
    const { fork, base, vaultId } = await scenario();
    const { rigB, x, y } = fork;
    const options = FORK_FLAGS;
    const steps = await countSteps(rigB, base, { options });
    expect(steps).toBeGreaterThanOrEqual(6); // the copy (temp, rename), the node's daily note and new note (temp, rename), the floor, the state

    const baseState = storedIn(base.kv, STATE_KEY);
    for (let kill = 1; kill <= steps; kill++) {
      const puller = restoredFrom(base);
      const armed = arm(puller, kill);
      expect(await pullUntilKilled(rigB, puller, { options }), `kill after step ${kill}`).toBe("killed");

      const texts = vaultTexts(puller.host);
      expectOnly(texts, [DAILY, PLAN, BINARY, NEW_FILE, ...PUBLISHER_ONLY], `after kill ${kill}`);
      expect([A_DAILY, B_DAILY], `daily after kill ${kill}`).toContain(texts[DAILY]);
      expect(texts[PLAN], `plan after kill ${kill}`).toBe(A_PLAN); // only this device edited it: it is never replaced
      if (NEW_FILE in texts) expect(texts[NEW_FILE]).toBe(B_NEW);
      for (const copy of copiesOf(texts)) expect(texts[copy], `copy after kill ${kill}`).toBe(A_DAILY);
      if (texts[DAILY] === B_DAILY) expect(copiesOf(texts).length, `edit kept after kill ${kill}`).toBeGreaterThan(0);

      // Floor then state, never lowered: sequence 2 with either identity; the new state exists only with the node's identity in the floor.
      const floor = floorOf(puller, vaultId);
      expect(floor?.sequence, `floor after kill ${kill}`).toBe(2);
      expect([x, y]).toContain(floor?.identity);
      const newState = !sameBytes(puller.host.kvStore.get(STATE_KEY), baseState);
      if (newState) {
        expect(floor?.identity, `floor before state after kill ${kill}`).toBe(y);
        expect(vaultTexts(puller.host)[DAILY]).toBe(B_DAILY);
        expect(vaultTexts(puller.host)[NEW_FILE]).toBe(B_NEW);
        expect(rootStateOf(puller)).toMatchObject({ manifestIdentity: y, previousIdentity: null, complete: true, unmaterialized: [] });
      }
      expect(puller.locks.file.bytes).toBeUndefined();
      expectOnlyReads(rigB.node);

      armed.disarm();
      if (newState) {
        // The fork is over: a plain pull is the same manifest.
        expect(pulledOf(await runVaultPull(rigB, puller)).result.verdict).toBe("same");
      } else {
        // The state is still ours (X). Without the flag the fork is refused by name; with it the resolution runs again.
        const plain = await runVaultPull(rigB, puller);
        expect(plain.kind, `plain rerun after kill ${kill}`).toBe("stopped");
        if (plain.kind === "stopped") {
          expect(plain.stop.reason).toBe("fork");
          expect(plain.stop.message).toContain("--resolve-fork");
        }
        const resumed = pulledOf(await runVaultPull(rigB, puller, { options }));
        expect(resumed.result.verdict).toBe("fork-resolution");
        expect(resumed.result.forkResolution?.ancestorUsed, `ancestor after kill ${kill}`).toBe(true);
      }

      const after = vaultTexts(puller.host);
      expect(after[DAILY], `resume after kill ${kill}`).toBe(B_DAILY);
      expect(after[PLAN]).toBe(A_PLAN);
      expect(after[NEW_FILE]).toBe(B_NEW);
      expect(copiesOf(after).length).toBeGreaterThan(0);
      for (const copy of copiesOf(after)) expect(after[copy]).toBe(A_DAILY);
      expect(partFiles(puller.host)).toEqual([]);
      expect(await stateOf(puller.host)).toMatchObject({ sequence: 2, highestSequence: 2, manifestIdentity: y, highestIdentity: y, previousIdentity: null, complete: true, unmaterialized: [] });
      expect(await readFloor(puller.store, vaultId)).toMatchObject({ sequence: 2, identity: y });
    }
  });
});

describe("a fork resolution with no common ancestor, killed after each step", () => {
  const A_PLAN = "A rewrote the quarterly plan.\n";
  const B_DAILY = "B wrote this daily note.\n";

  it("every differing file is kept in a whole copy at every kill point, and the rerun finishes", async () => {
    const fork = await makeFork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    const { rigB, y } = fork;
    const a = newPuller(fork.rigA.host);
    const state = await stateOf(fork.rigA.host);
    if (state === undefined) throw new Error("fixture changed");
    // This device has no record of the manifest it built on: B is absent and the node's text takes every differing path.
    await writeRootState(fork.rigA.host.kv, { ...state, previousIdentity: null });
    await raiseFloor(a.store, state.vaultId, { sequence: 2, identity: fork.x, at: 1 });
    const base = snapshotOf(a);
    const options = FORK_FLAGS;
    const steps = await countSteps(rigB, base, { options });

    for (let kill = 1; kill <= steps; kill++) {
      const puller = restoredFrom(base);
      const armed = arm(puller, kill);
      expect(await pullUntilKilled(rigB, puller, { options }), `kill after step ${kill}`).toBe("killed");

      const texts = vaultTexts(puller.host);
      expect([A_PLAN, ORIGINAL_PLAN], `plan after kill ${kill}`).toContain(texts[PLAN]);
      const planCopies = Object.entries(texts).filter(([path]) => path.startsWith("Projects/Secret Merger/Quarterly plan (ipfs conflict"));
      for (const [, text] of planCopies) expect(text, `plan copy after kill ${kill}`).toBe(A_PLAN);
      // This device's plan text is at its path or in a whole copy: never neither.
      if (texts[PLAN] !== A_PLAN) expect(planCopies.length, `edit kept after kill ${kill}`).toBeGreaterThan(0);
      expect(floorOf(puller, state.vaultId)?.sequence, `floor after kill ${kill}`).toBe(2);
      expect(puller.locks.file.bytes).toBeUndefined();

      armed.disarm();
      const kept = !sameBytes(puller.host.kvStore.get(STATE_KEY), storedIn(base.kv, STATE_KEY));
      const resumed = await runVaultPull(rigB, puller, kept ? {} : { options });
      expect(resumed.kind, `rerun after kill ${kill}`).toBe("completed");
      const after = vaultTexts(puller.host);
      expect(after[PLAN]).toBe(ORIGINAL_PLAN);
      expect(after[DAILY]).toBe(B_DAILY);
      expect(Object.entries(after).some(([path, text]) => path.startsWith("Projects/Secret Merger/Quarterly plan (ipfs conflict") && text === A_PLAN)).toBe(true);
      expect(partFiles(puller.host)).toEqual([]);
      expect(await stateOf(puller.host)).toMatchObject({ manifestIdentity: y, previousIdentity: null, complete: true });
    }
  });
});
