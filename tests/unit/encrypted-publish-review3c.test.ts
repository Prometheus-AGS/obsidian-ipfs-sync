import { beforeAll, describe, expect, it } from "vitest";
import { encryptManifestEnvelope } from "../../src/crypto/manifest-envelope";
import { CryptoError } from "../../src/crypto";
import { ManifestFormatError, serializeManifestV2 } from "../../src/sync/encrypted-manifest";
import { readJournal } from "../../src/sync/journal";
import { isUnreadableManifest } from "../../src/sync/manifest-auth";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { NodeKilled, createFakeNode } from "../helpers/fake-kubo";
import { KEY, ROOT, createRig, restoreRig, seedVault, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";
import { otherPassphrase } from "../vectors/slot-helpers";

const OWNED = "k51owned";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
const yes = async (): Promise<boolean> => true;

async function ownedRig(): Promise<Rig> {
  const rig = createRig({ node: createFakeNode([{ name: KEY, id: OWNED }]) });
  rig.owned.push(OWNED);
  seedVault(rig.host);
  await rig.init();
  return rig;
}

let once: RigSnapshot;
beforeAll(async () => {
  const rig = await ownedRig();
  await rig.publish();
  once = snapshotRig(rig);
}, 30_000);

/** Publish sequence 2 after an edit and kill it right after `manifest.enc` was written: a journal is left. */
async function killedAfterManifest(): Promise<Rig> {
  const rig = restoreRig(once);
  rig.host.put("Daily/2026-09-30.md", "# edited for the kill\n", 5000);
  rig.node.mutations = 0;
  rig.node.killAfterMutation = 3;
  expect(await rejection(rig.publish())).toBeInstanceOf(NodeKilled);
  rig.node.killAfterMutation = undefined;
  rig.node.calls.length = 0;
  return rig;
}

/** Replace the node's manifest.enc with an authentic one (same key) that carries a field this build does not know. */
async function plantAuthenticManifestWithUnknownField(rig: Rig): Promise<Uint8Array> {
  const plain = JSON.parse(new TextDecoder().decode(serializeManifestV2(await rig.manifest()))) as Record<string, unknown>;
  const forged = await encryptManifestEnvelope(await rig.keys(), new TextEncoder().encode(JSON.stringify({ ...plain, zzzFutureField: 1 })));
  rig.node.files.set(`${ROOT}/manifest.enc`, forged);
  return forged;
}

describe("N3-01: an authentic manifest this build cannot parse is never overwritten", () => {
  it("isUnreadableManifest: authentication and envelope failures are unreadable, a format error after authentication is not", () => {
    expect(isUnreadableManifest(new CryptoError("authentication-failed", "x"))).toBe(true);
    expect(isUnreadableManifest(new CryptoError("malformed-input", "x"))).toBe(true);
    expect(isUnreadableManifest(new ManifestFormatError("version", "x"))).toBe(false);
    expect(isUnreadableManifest(new CryptoError("vault-mismatch", "x"))).toBe(false);
    expect(isUnreadableManifest(new Error("x"))).toBe(false);
  });

  it("with no journal: publish and publish --repair both refuse, and the node's file is untouched", async () => {
    const rig = restoreRig(once);
    const planted = await plantAuthenticManifestWithUnknownField(rig);
    rig.node.calls.length = 0;
    await expect(rig.publish()).rejects.toBeInstanceOf(ManifestFormatError);
    await expect(rig.publish({ repair: true, confirmRepair: yes })).rejects.toBeInstanceOf(ManifestFormatError);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(rig.node.files.get(`${ROOT}/manifest.enc`)).toEqual(planted);
  });

  it("with a journal: resume does not rewrite it from the journal, the journal stays, nothing is written", async () => {
    const rig = await killedAfterManifest();
    const planted = await plantAuthenticManifestWithUnknownField(rig);
    await expect(rig.publish()).rejects.toBeInstanceOf(ManifestFormatError);
    await expect(rig.publish({ repair: true, confirmRepair: yes })).rejects.toBeInstanceOf(ManifestFormatError);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(rig.node.files.get(`${ROOT}/manifest.enc`)).toEqual(planted);
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");
  });
});

describe("N3-04: the idle path", () => {
  const counter = (): { readonly hook: (fraction: number) => void; readonly runs: () => number } => {
    let calls = 0;
    return { hook: () => void (calls += 1), runs: () => calls };
  };

  it("a touched file with identical content: one normal run publishes nothing and remembers the new time, so the next tick is idle again", async () => {
    const rig = restoreRig(once);
    const same = rig.host.files.get("Daily/2026-09-30.md")?.data ?? "";
    rig.host.put("Daily/2026-09-30.md", same, 99_000);
    const first = counter();
    const result = await rig.publish({ onUnlockProgress: first.hook });
    expect(result).toMatchObject({ published: false, written: 0, removed: 0 });
    expect(first.runs()).toBeGreaterThan(0);
    expect((await readRootState(rig.host.kv, ROOT))?.mtimes["Daily/2026-09-30.md"]).toBe(99_000);
    const second = counter();
    rig.node.calls.length = 0;
    await rig.publish({ onUnlockProgress: second.hook });
    expect(second.runs()).toBe(0);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("a file with no recorded time: one normal run hashes it and records the time, so the cost is paid once, not on every tick", async () => {
    const rig = restoreRig(once);
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    const { ["attachment.bin"]: _dropped, ...rest } = state.mtimes;
    await writeRootState(rig.host.kv, buildRootState({ ...state, mtimes: rest }));
    const first = counter();
    expect(await rig.publish({ onUnlockProgress: first.hook })).toMatchObject({ published: false });
    expect(first.runs()).toBeGreaterThan(0);
    expect((await readRootState(rig.host.kv, ROOT))?.mtimes["attachment.bin"]).toBeDefined();
    const second = counter();
    await rig.publish({ onUnlockProgress: second.hook });
    expect(second.runs()).toBe(0);
  });

  it("a wrong passphrase is not noticed on an unchanged vault (no key is derived, nothing is written); it is refused as soon as there is work", async () => {
    const rig = restoreRig(once);
    rig.node.calls.length = 0;
    const idle = await rig.publish({ passphrase: otherPassphrase() });
    expect(idle).toMatchObject({ published: false, written: 0 });
    expect(rig.node.calls).toEqual([expect.stringMatching(/^stat /), "keyList"]);

    rig.host.put("notes/new.md", "new file", 6000);
    rig.node.calls.length = 0;
    await expect(rig.publish({ passphrase: otherPassphrase() })).rejects.toMatchObject({ code: "wrong-passphrase-or-damaged-slot" });
    // Only the idle check's two read-only probes reached the node; the unlock itself failed on the local key-slot copy before any request.
    expect(rig.node.calls).toEqual([expect.stringMatching(/^stat /), "keyList"]);
  });
});

describe("N3-05: a key name changed after a crash", () => {
  it("the refusal tells the operator to publish with the original key name", async () => {
    const rig = await killedAfterManifest();
    const error = await rejection(rig.publish({ keyName: "obsidian-vault-other" }));
    expect(error).toMatchObject({ code: "journal-mismatch" });
    expect((error as Error).message).toContain("Publish with the key name the interrupted publish used (--key), or use the abandon action");
  });
});
