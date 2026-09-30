import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { CryptoError, VCK_BYTES, formatPassphrase, toBase64, toHex, utf8 } from "../../src/crypto";
import {
  createSessionKeys,
  hasLocalKeySlots,
  type DialogCallbacks,
  type OpenRequest,
  type SessionKeys,
  type SetupRequest,
  type SetupResult,
  type UnlockRequest,
  type UnlockingEvent,
} from "../../src/plugin/session-keys";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { VaultKeysError, openVault, toUnlockedVault, type UnlockedVault } from "../../src/sync/vault-keys";
import { createFakeNode } from "../helpers/fake-kubo";
import { KEY, ROOT, createRig, restoreRig, seedVault, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";
import { FLOOR_PARAMS, otherPassphrase, referencePassphrase } from "../vectors/slot-helpers";

const OWNED = "k51owned";
const REFERENCE_TEXT = String.fromCharCode(...referencePassphrase());
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

interface Harness {
  readonly session: SessionKeys;
  readonly unlockRequests: UnlockRequest[];
  readonly setupRequests: SetupRequest[];
  readonly events: UnlockingEvent[];
  readonly opens: OpenRequest[];
  /** Argon2id runs seen by the `open` port (its progress callback fires only while the derivation runs). */
  derivations(): number;
}

interface HarnessOptions {
  readonly typed?: readonly (string | undefined)[];
  readonly setup?: (request: SetupRequest) => Promise<SetupResult | undefined>;
  readonly vaultExists?: () => Promise<boolean>;
  readonly holdUnlock?: Promise<void>;
}

/** A session over the rig's real `openVault` at the floor cost: real key slots, real derivation, a counting hook. */
function harness(rig: Rig, options: HarnessOptions = {}): Harness {
  const unlockRequests: UnlockRequest[] = [];
  const setupRequests: SetupRequest[] = [];
  const events: UnlockingEvent[] = [];
  const opens: OpenRequest[] = [];
  let derivations = 0;
  const typed = [...(options.typed ?? [REFERENCE_TEXT])];
  const dialogs: DialogCallbacks = {
    unlock: async (request) => {
      unlockRequests.push(request);
      await options.holdUnlock;
      return typed.length > 1 ? typed.shift() : typed[0];
    },
    setup: async (request) => {
      setupRequests.push(request);
      return options.setup?.(request);
    },
    unlocking: (event) => void events.push(event),
  };
  const session = createSessionKeys({
    dialogs,
    vaultExists: options.vaultExists ?? (() => hasLocalKeySlots(rig.host.fs, ROOT)),
    open: async (request) => {
      opens.push(request);
      const opened = await openVault({
        fs: rig.host.fs,
        mfsRoot: ROOT,
        passphrase: request.passphrase,
        create: request.create,
        createParams: FLOOR_PARAMS,
        local: { hasState: false },
        node: { fetchKeySlots: async () => rig.node.files.get(`${ROOT}/keyslots.json`), manifestPresent: async () => rig.node.files.has(`${ROOT}/manifest.enc`) },
        onProgress: (fraction) => {
          derivations += 1;
          request.onProgress(fraction);
        },
      });
      return toUnlockedVault(opened);
    },
  });
  return { session, unlockRequests, setupRequests, events, opens, derivations: () => derivations };
}

async function ownedRig(): Promise<Rig> {
  const rig = createRig({ node: createFakeNode([{ name: KEY, id: OWNED }]) });
  rig.owned.push(OWNED);
  seedVault(rig.host);
  await rig.init();
  return rig;
}

let fresh: RigSnapshot;
beforeAll(async () => {
  fresh = snapshotRig(await ownedRig());
}, 30_000);

const counter = (): { readonly hook: (fraction: number) => void; readonly runs: () => number } => {
  let calls = 0;
  return { hook: () => void (calls += 1), runs: () => calls };
};

async function unlockedVault(session: SessionKeys): Promise<UnlockedVault> {
  const outcome = await session.unlock();
  if (outcome.kind !== "unlocked") throw new Error(`expected unlocked, got ${outcome.kind}`);
  return outcome.vault;
}

describe("one prompt per session", () => {
  it("two publishes prompt once and the second derives nothing", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    await h.session.refresh();
    await unlockedVault(h.session);
    const engine = counter();
    await rig.publish({ passphrase: undefined, unlocked: h.session.provider, onUnlockProgress: engine.hook });
    rig.host.put("notes/second.md", "second", 6000);
    const second = await rig.publish({ passphrase: undefined, unlocked: h.session.provider, onUnlockProgress: engine.hook });
    await unlockedVault(h.session);
    expect(second).toMatchObject({ published: true, written: 1 });
    expect(h.unlockRequests).toHaveLength(1);
    expect(h.derivations()).toBeGreaterThan(0);
    expect(engine.runs()).toBe(0);
  }, 30_000);

  it("concurrent unlock calls share one dialog and one derivation sequence", async () => {
    const rig = restoreRig(fresh);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => void (release = resolve));
    const h = harness(rig, { holdUnlock: gate });
    const first = h.session.unlock();
    const second = h.session.unlock();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.kind).toBe("unlocked");
    expect(b).toEqual(a);
    expect(h.unlockRequests).toHaveLength(1);
    expect(h.opens).toHaveLength(1);
  }, 30_000);
});

describe("a timer tick with a session derives nothing (W-07, counting hook)", () => {
  it("positive control: the passphrase path with a change runs the derivation and the hook sees it", async () => {
    const rig = restoreRig(fresh);
    rig.host.put("notes/new.md", "new", 6000);
    const engine = counter();
    await rig.publish({ onUnlockProgress: engine.hook });
    expect(engine.runs()).toBeGreaterThan(0);
  }, 30_000);

  it("changes and idle ticks with an unlocked session run no derivation and no prompt", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    await unlockedVault(h.session);
    const afterUnlock = h.derivations();
    const engine = counter();
    const tick = (): Promise<unknown> => rig.publish({ passphrase: undefined, unlocked: h.session.provider, onUnlockProgress: engine.hook });
    await tick();
    for (let i = 0; i < 3; i += 1) await tick();
    rig.host.put("notes/edit.md", "edit", 7000);
    await tick();
    expect(engine.runs()).toBe(0);
    expect(h.derivations()).toBe(afterUnlock);
    expect(h.unlockRequests).toHaveLength(1);
  }, 60_000);

  it("the provider is synchronous, never prompts and yields nothing while locked", () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    expect(h.session.provider()).toBeUndefined();
    expect(h.unlockRequests).toHaveLength(0);
    expect(h.opens).toHaveLength(0);
  });
});

describe("lock", () => {
  it("lock drops the keys, the engine refuses with no request, and the next unlock prompts again", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    await unlockedVault(h.session);
    h.session.lock();
    expect(h.session.state()).toBe("locked");
    expect(h.session.provider()).toBeUndefined();
    rig.node.calls.length = 0;
    const refusal = await rejection(rig.publish({ passphrase: undefined, unlocked: h.session.provider }));
    expect(refusal).toBeInstanceOf(PublishRefusedError);
    expect((refusal as PublishRefusedError).code).toBe("passphrase-required");
    expect(rig.node.calls).toEqual([]);
    await unlockedVault(h.session);
    expect(h.unlockRequests).toHaveLength(2);
  }, 30_000);

  it("lock is idempotent and a lock during an unlock discards the result", async () => {
    const rig = restoreRig(fresh);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => void (release = resolve));
    const h = harness(rig, { holdUnlock: gate });
    const pending = h.session.unlock();
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.session.lock();
    h.session.lock();
    release();
    expect((await pending).kind).toBe("cancelled");
    expect(h.session.provider()).toBeUndefined();
    expect(h.session.state()).not.toBe("unlocked");
  }, 30_000);

  it("dispose (plugin unload) locks and refuses every later prompt", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    await unlockedVault(h.session);
    h.session.dispose();
    expect(h.session.provider()).toBeUndefined();
    expect((await h.session.unlock()).kind).toBe("cancelled");
    expect((await h.session.setup()).kind).toBe("cancelled");
    expect(h.unlockRequests).toHaveLength(1);
  }, 30_000);
});

describe("unlock dialog behaviour", () => {
  it("a wrong passphrase re-prompts with the failure, a malformed one too, then it unlocks", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig, { typed: [String.fromCharCode(...otherPassphrase()), "not a passphrase", REFERENCE_TEXT] });
    expect((await h.session.unlock()).kind).toBe("unlocked");
    expect(h.unlockRequests.map((request) => [request.attempt, request.failure])).toEqual([
      [1, undefined],
      [2, "wrong-passphrase"],
      [3, "format"],
    ]);
  }, 30_000);

  it("cancel returns cancelled, stays locked and derives nothing; a hyphenated lower-case entry is accepted", async () => {
    const rig = restoreRig(fresh);
    const cancelled = harness(rig, { typed: [undefined] });
    expect((await cancelled.session.unlock()).kind).toBe("cancelled");
    expect(cancelled.session.state()).toBe("locked");
    expect(cancelled.opens).toHaveLength(0);
    const pretty = harness(rig, { typed: [formatPassphrase(referencePassphrase()).toLowerCase()] });
    expect((await pretty.session.unlock()).kind).toBe("unlocked");
  }, 30_000);

  it("the indicator sees start, progress in range, then end, and the passphrase bytes handed to the port are overwritten afterwards", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    await h.session.unlock();
    const kinds = h.events.map((event) => event.kind);
    expect(kinds[0]).toBe("start");
    expect(kinds.at(-1)).toBe("end");
    expect(kinds).toContain("progress");
    for (const event of h.events) if (event.kind === "progress") expect(event.fraction >= 0 && event.fraction <= 1).toBe(true);
    expect(h.opens[0]?.passphrase.every((byte) => byte === 0)).toBe(true);
  }, 30_000);

  it("a non-passphrase failure propagates and leaves the session locked and able to try again", async () => {
    const rig = restoreRig(fresh);
    let calls = 0;
    const session = createSessionKeys({
      dialogs: { unlock: async () => REFERENCE_TEXT, setup: async () => undefined },
      vaultExists: async () => true,
      open: async () => {
        calls += 1;
        throw new CryptoError("platform-failure", "device out of memory");
      },
    });
    expect(await rejection(session.unlock())).toBeInstanceOf(CryptoError);
    expect(await rejection(session.unlock())).toBeInstanceOf(CryptoError);
    expect(calls).toBe(2);
    expect(session.state()).toBe("locked");
    void rig;
  });
});

describe("states and setup", () => {
  it("not-set-up until a vault exists: unlock never creates one", async () => {
    const rig = createRig();
    const h = harness(rig);
    expect(h.session.state()).toBe("not-set-up");
    expect(await h.session.refresh()).toBe("not-set-up");
    expect(await h.session.unlock()).toEqual({ kind: "not-set-up" });
    expect(h.unlockRequests).toHaveLength(0);
    expect(h.setupRequests).toHaveLength(0);
    expect(h.opens).toHaveLength(0);
  });

  it("refresh reports locked when the local key-slot copy exists", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    expect(await h.session.refresh()).toBe("locked");
  });

  it("setup shows the generated passphrase in 5 groups of 5, verifies the re-entry, creates through the port, and the vault then publishes with no passphrase", async () => {
    const rig = createRig({ node: createFakeNode([{ name: KEY, id: OWNED }]) });
    rig.owned.push(OWNED);
    seedVault(rig.host);
    let shown = "";
    const h = harness(rig, {
      setup: async (request) => {
        shown = request.passphrase;
        return { confirmed: true, reentered: request.passphrase.toLowerCase().replace(/-/g, " ") };
      },
    });
    const outcome = await h.session.setup();
    expect(outcome.kind).toBe("unlocked");
    expect(shown).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
    expect(h.opens).toHaveLength(1);
    expect(h.opens[0]?.create).toBeDefined();
    expect(h.opens[0]?.passphrase.every((byte) => byte === 0)).toBe(true);
    expect(h.session.state()).toBe("unlocked");
    const result = await rig.publish({ passphrase: undefined, unlocked: h.session.provider });
    expect(result.published).toBe(true);
    expect(rig.node.files.has(`${ROOT}/keyslots.json`)).toBe(true);
    expect(await hasLocalKeySlots(rig.host.fs, ROOT)).toBe(true);
    expect(JSON.stringify([...rig.host.kvStore.values()].map((value) => toBase64(value)))).not.toContain(toBase64(utf8(shown.replace(/-/g, ""))));
  }, 60_000);

  it("setup refuses a wrong re-entry or an unchecked Create, and creates nothing", async () => {
    const rig = createRig();
    const mismatch = harness(rig, { setup: async () => ({ confirmed: true, reentered: REFERENCE_TEXT }) });
    expect(await rejection(mismatch.session.setup())).toBeInstanceOf(CryptoError);
    const declined = harness(rig, { setup: async (request) => ({ confirmed: false, reentered: request.passphrase }) });
    expect((await declined.session.setup()).kind).toBe("cancelled");
    const cancelled = harness(rig, { setup: async () => undefined });
    expect((await cancelled.session.setup()).kind).toBe("cancelled");
    for (const h of [mismatch, declined, cancelled]) {
      expect(h.opens).toHaveLength(0);
      expect(h.session.state()).toBe("not-set-up");
    }
  });

  it("setup on an unlocked session returns the held vault without a dialog", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    const vault = await unlockedVault(h.session);
    expect(await h.session.setup()).toEqual({ kind: "unlocked", vault });
    expect(h.setupRequests).toHaveLength(0);
  }, 30_000);
});

describe("what the session keeps", () => {
  it("the held keys are non-extractable", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    const vault = await unlockedVault(h.session);
    const keys = [await vault.keys.nameKey(), await vault.keys.manifestKey(), await vault.keys.fileKey(new Uint8Array(16).fill(7))];
    expect(keys.map((key) => key.extractable)).toEqual([false, false, false]);
    await expect(crypto.subtle.exportKey("raw", keys[1] as CryptoKey)).rejects.toThrow();
    expect(Object.keys(vault.keys)).not.toContain("vck");
  }, 30_000);

  it("after an unlocked session and a publish, no stored byte holds the passphrase; the session serialises to public data only", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    const vault = await unlockedVault(h.session);
    rig.host.put("notes/stored.md", "stored", 6000);
    await rig.publish({ passphrase: undefined, unlocked: h.session.provider });
    const needles = [REFERENCE_TEXT, formatPassphrase(referencePassphrase()), REFERENCE_TEXT.toLowerCase()].flatMap((text) => [
      Buffer.from(text),
      Buffer.from(toBase64(utf8(text))),
      Buffer.from(toHex(utf8(text))),
    ]);
    const stored: Uint8Array[] = [...[...rig.host.files.values()].map((file) => file.data), ...rig.host.kvStore.values(), ...rig.node.files.values()];
    for (const bytes of stored) for (const needle of needles) expect(Buffer.from(bytes).includes(needle)).toBe(false);
    const serialised = JSON.stringify({ session: h.session, state: h.session.state(), vault });
    for (const needle of needles) expect(serialised.includes(needle.toString())).toBe(false);
    expect(vault.keySlots.length).toBeLessThan(16 * 1024);
    expect(VCK_BYTES).toBe(32);
  }, 60_000);

  it("the module has no storage dependency: no plugin data, browser storage, file or key-value access", () => {
    const source = readFileSync(new URL("../../src/plugin/session-keys.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["saveData", "loadData", "localStorage", "sessionStorage", "indexedDB", "kv.set", "fs.write", "console."]) expect(code).not.toContain(forbidden);
    expect(code).not.toMatch(/from "\.\.\/kubo/);
  });
});

describe("the engine seam (vault-keys)", () => {
  it("slots that differ from the session's need the passphrase: locked, and no derivation", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    const vault = await unlockedVault(h.session);
    const foreign: UnlockedVault = { ...vault, keySlots: new Uint8Array([...vault.keySlots, 10]) };
    const progress = counter();
    const error = await rejection(
      openVault({
        fs: rig.host.fs,
        mfsRoot: ROOT,
        unlocked: foreign,
        local: { hasState: false },
        node: { fetchKeySlots: async () => rig.node.files.get(`${ROOT}/keyslots.json`), manifestPresent: async () => false },
        onProgress: progress.hook,
      }),
    );
    expect(error).toBeInstanceOf(VaultKeysError);
    expect((error as VaultKeysError).code).toBe("locked");
    expect(progress.runs()).toBe(0);
  }, 30_000);

  it("a node whose slots differ from the local copy is still refused with a session, before anything is written", async () => {
    const rig = restoreRig(fresh);
    const h = harness(rig);
    await unlockedVault(h.session);
    rig.node.files.set(`${ROOT}/keyslots.json`, new Uint8Array([1, 2, 3]));
    rig.node.calls.length = 0;
    const error = await rejection(rig.publish({ passphrase: undefined, unlocked: h.session.provider }));
    expect(error).toBeInstanceOf(VaultKeysError);
    expect((error as VaultKeysError).code).toBe("vault-mismatch");
    expect(rig.node.calls.filter((call) => /^(write|rm|pin|publish|keyGen) /.test(call))).toEqual([]);
  }, 30_000);
});
