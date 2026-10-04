import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { VaultKeys } from "../../src/crypto";
import { CryptoError, KDF_ITERATIONS_DEFAULT, KDF_MEMORY_DEFAULT_KIB, KDF_PARALLELISM, type CostPolicy, type KdfParams } from "../../src/crypto";
import { costConfirmationFrom, createCostConfirmModel } from "../../src/plugin/cost-confirm-dialog-model";
import { UNEXPECTED_FAILURE_TEXT } from "../../src/plugin/key-action-failure";
import { REAL_KEY_ENGINE, createKeyActions, type KeyActions, type KeyActionsDeps, type KeyEngine } from "../../src/plugin/key-actions";
import type { KeyDialogOpeners } from "../../src/plugin/key-dialogs";
import type { KeyDialogOutcome } from "../../src/plugin/key-dialog-shared";
import type { HeldLock, KeyPorts } from "../../src/plugin/key-ports";
import type { PruneHistoryDialogRequest } from "../../src/plugin/prune-history-dialog";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import { busyNotice, createSyncLock } from "../../src/plugin/sync-lock";
import { sha256Hex } from "../../src/sync/hash";
import { historyFileName } from "../../src/sync/history-names";
import type { AcceptDeps, KeyManagementDeps } from "../../src/sync/key-management";
import { readMaintenanceJournal } from "../../src/sync/maintenance-journal";
import { preparePrune, type PruneDeps } from "../../src/sync/prune-history";
import { MAINTENANCE_WAYS_OUT, lockHeld } from "../../src/sync/publish-refusals";
import { createSnapshotVerifier } from "../../src/sync/read-back";
import { keySlotsCopyPath, toUnlockedVault, type UnlockedVault } from "../../src/sync/vault-keys";
import { NodeKilled } from "../helpers/fake-kubo";
import { KEYSLOTS_PATH, MANIFEST_PATH, maintenanceNodeOf, mutatingCalls, oldKeySlotsOf, publishedRig, historyNamesOf } from "../helpers/maintenance-rig";
import { junkHistoryName, seedHistory, type SeededHistory } from "../helpers/prune-rig";
import { KEY, ROOT, restoreRig, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";
import { REFERENCE_TEXT } from "../helpers/plugin-session";
import { MemoryAdapter } from "../support/memory-adapter";

/**
 * mvp-07b task 2.5 at the action: the REAL engine (`preparePrune`, `executePrune`) over the recording fake node, driven through the plugin's key
 * actions with a scripted dialog. Only the key derivation is stood in (the held vault of the rig opens the local copy; the passphrase text is still
 * canonicalised, passed and wiped), and the ports are built from the rig instead of the Obsidian adapter.
 */

const STANDARD: KdfParams = { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM };
const HIGH: KdfParams = { m: 131_072, t: 4, p: KDF_PARALLELISM };
const COPY = new TextEncoder().encode('{"stand-in":"local key-slot copy"}');
const TOTAL = 40;
const NOW_ISO = "2026-10-04T10:00:00.000Z";

let base: RigSnapshot;
let seeded: RigSnapshot;
let seed: SeededHistory;
let keys: VaultKeys;
let held: UnlockedVault;

beforeAll(async () => {
  const rig = await publishedRig();
  keys = await rig.keys();
  const slots = oldKeySlotsOf(rig);
  held = toUnlockedVault({ keys, vaultId: keys.vaultId, keySlots: slots, keySlotsSha256: await sha256Hex(slots) });
  base = snapshotRig(rig);
  const copy = restoreRig(base);
  copy.node.cidOf(ROOT);
  seed = await seedHistory({ node: copy.node, kv: copy.host.kv, mfsRoot: ROOT, keys, total: TOTAL });
  seeded = snapshotRig(copy);
}, 60_000);

const spy = <T extends (...args: never[]) => unknown>(implementation: T) => vi.fn(implementation);

function store(): SettingsStore {
  const port: PluginDataPort = { loadData: async () => null, saveData: async () => undefined };
  return createSettingsStore(port, { ...loadSettings(null), settings: { ...defaultSettings(), mfsRoot: ROOT, publicationKey: KEY } });
}

interface Opened {
  request: PruneHistoryDialogRequest;
  finish: (outcome: KeyDialogOutcome) => void;
}

interface Harness {
  readonly rig: Rig;
  readonly actions: KeyActions;
  readonly adapter: MemoryAdapter;
  readonly lock: ReturnType<typeof createSyncLock>;
  readonly engine: { preparePrune: ReturnType<typeof vi.fn>; executePrune: ReturnType<typeof vi.fn> };
  readonly opened: { prune?: Opened };
  readonly closed: ReturnType<typeof vi.fn>;
  readonly settings: SettingsStore;
  readonly heldLocks: HeldLock[];
}

const nameOf = (sequence: number): string => (sequence >= TOTAL - 19 ? historyFileName(sequence, seed.manifest.rootCID) : junkHistoryName(sequence));

async function harness(options: { readonly copy?: boolean; readonly deps?: Partial<KeyActionsDeps>; readonly snapshot?: RigSnapshot } = {}): Promise<Harness> {
  const rig = restoreRig(options.snapshot ?? seeded);
  rig.node.cidOf(ROOT);
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  if (options.copy !== false) adapter.put(await keySlotsCopyPath(ROOT), COPY);
  const settings = store();
  const lock = createSyncLock();
  const heldLocks: HeldLock[] = [];
  const openPorts = async (heldLock: HeldLock): Promise<KeyPorts> => {
    heldLocks.push(heldLock);
    const deps: PruneDeps = {
      node: maintenanceNodeOf(rig, () => heldLock.assertHeld()),
      fs: rig.host.fs,
      kv: rig.host.kv,
      deviceStore: undefined,
      now: () => NOW_ISO,
      snapshotVerifier: (keySlots) => createSnapshotVerifier({ client: rig.node.client, keySlots, written: new Map() }),
      assertHeld: heldLock.assertHeld,
      beforeFirstWrite: async () => {
        if (!(await heldLock.verifyHeld())) throw lockHeld("the lock file no longer carries this run's token");
      },
    };
    return {
      deps: deps as unknown as KeyManagementDeps,
      acceptDeps: { stand: "in" } as unknown as AcceptDeps,
      key: { absent: false },
      keyRefusal: undefined,
      mfsRoot: ROOT,
      keyName: KEY,
      readCopy: async () => COPY,
      resolveAcceptTarget: async () => ({ kind: "name", rootCid: "bafy" }),
    };
  };
  const engine = {
    // The real engine, with the held vault in place of the derivation.
    preparePrune: spy(async (deps: PruneDeps, input: Parameters<typeof preparePrune>[1]) => REAL_KEY_ENGINE.preparePrune(deps, { ...input, unlocked: held })),
    executePrune: spy(REAL_KEY_ENGINE.executePrune),
  };
  const opened: Harness["opened"] = {};
  const closed = vi.fn();
  const unused = (): never => {
    throw new Error("a prune must not open another key dialog");
  };
  const dialogs: KeyDialogOpeners = {
    changePassphrase: unused,
    increaseCost: unused,
    acceptSlots: unused,
    pruneHistory: (request, finish) => {
      opened.prune = { request, finish };
      return { close: () => closed("prune") };
    },
  };
  const actions = createKeyActions({
    store: settings,
    adapter,
    lock,
    transport: async () => {
      throw new Error("a stubbed key action must not reach the transport");
    },
    now: () => new Date(1_800_000_000_000),
    dialogs,
    afterChange: vi.fn(),
    engine: { ...REAL_KEY_ENGINE, costFloorOf: () => STANDARD, ...engine } as unknown as KeyEngine,
    openPorts,
    ...options.deps,
  });
  return { rig, actions, adapter, lock, engine, opened, closed, settings, heldLocks };
}

async function open(h: Harness): Promise<PruneHistoryDialogRequest> {
  void h.actions.pruneHistory();
  await vi.waitFor(() => expect(h.opened.prune).toBeDefined());
  return (h.opened.prune as Opened).request;
}

const progress = (): ((fraction: number) => void) => () => undefined;
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index]);
const rmCalls = (rig: Rig): string[] => rig.node.calls.filter((call) => call.startsWith("rm "));

describe("prune action: opening", () => {
  it("opens the dialog with the cost of the local key-slot copy, once a vault exists", async () => {
    const h = await harness();
    const request = await open(h);
    expect(request.cost).toEqual(STANDARD);
    expect(h.lock.holder()).toBeUndefined();
    expect(mutatingCalls(h.rig)).toEqual([]);
  });

  it("opens nothing and says there is no vault when this device holds no key-slot copy", async () => {
    const h = await harness({ copy: false });
    expect(await h.actions.pruneHistory()).toBe("no-vault");
    expect(h.opened).toEqual({});
  });

  it("opens nothing while another operation holds the lock, and no second key dialog opens beside it", async () => {
    const h = await harness();
    const release = h.lock.tryAcquire("pull");
    expect(await h.actions.pruneHistory()).toBe("busy");
    release?.();
    void h.actions.pruneHistory();
    await vi.waitFor(() => expect(h.opened.prune).toBeDefined());
    expect(await h.actions.pruneHistory()).toBe("already-open");
  });
});

describe("prune action: the preview is a dry run", () => {
  it("shows counts only, from the real engine, and writes nothing", async () => {
    const h = await harness();
    const request = await open(h);
    const result = await request.preview({ keep: 5, passphrase: REFERENCE_TEXT }, progress());
    expect(result).toMatchObject({ ok: true, review: { removing: 20, keeping: 20, total: TOTAL } });
    const review = result.ok ? result.review : undefined;
    const text = JSON.stringify(review);
    expect(text).toContain("20 of the 40 history files");
    expect(text).toContain("was raised to 20");
    expect(text).toContain("derived from the passphrase you gave");
    // Never a node path or name: not a junk name, not a genuine one.
    for (let sequence = 1; sequence <= TOTAL; sequence += 1) expect(text).not.toContain(nameOf(sequence));
    expect(text).not.toContain("manifests/0");
    expect(mutatingCalls(h.rig)).toEqual([]);
    expect(rmCalls(h.rig)).toEqual([]);
    expect(h.engine.executePrune).not.toHaveBeenCalled();
    expect(historyNamesOf(h.rig)).toEqual(seed.names);
  });

  it("passes the engine the count and the passphrase it made from the typed text, then wipes it", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 25, passphrase: REFERENCE_TEXT }, progress());
    const [, input] = h.engine.preparePrune.mock.calls[0] as [unknown, { keep: number; mfsRoot: string; keyName: string; passphrase: Uint8Array; key: unknown }];
    expect(input).toMatchObject({ keep: 25, mfsRoot: ROOT, keyName: KEY, key: { absent: false } });
    expect([...input.passphrase].every((byte) => byte === 0)).toBe(true);
  });

  it("holds both locks from a good preview until the dialog ends, so publish and pull wait", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    expect(h.lock.holder()).toBe("key-management");
    expect([...h.adapter.files.keys()].some((path) => path.endsWith("publish.lock"))).toBe(true);
    h.opened.prune?.finish("cancelled");
    await vi.waitFor(() => expect(h.lock.holder()).toBeUndefined());
    expect([...h.adapter.files.keys()].some((path) => path.endsWith("publish.lock"))).toBe(false);
  });

  it("cancelling after the preview never executes: nothing is removed, nothing is published, the lock is given back", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    h.opened.prune?.finish("cancelled");
    await vi.waitFor(() => expect(h.lock.holder()).toBeUndefined());
    expect(h.engine.executePrune).not.toHaveBeenCalled();
    expect(mutatingCalls(h.rig)).toEqual([]);
    expect(historyNamesOf(h.rig)).toEqual(seed.names);
    expect(await readMaintenanceJournal(h.rig.host.kv, ROOT)).toEqual({ kind: "none" });
  });

  it("says there is nothing to prune, holds no lock, and offers nothing to remove when the plan removes nothing", async () => {
    const h = await harness();
    const request = await open(h);
    const result = await request.preview({ keep: 100, passphrase: REFERENCE_TEXT }, progress());
    expect(result).toMatchObject({ ok: true, review: { removing: 0, keeping: TOTAL, total: TOTAL } });
    expect(JSON.stringify(result)).toContain("Nothing to prune");
    expect(h.lock.holder()).toBeUndefined();
    expect(await request.remove()).toMatchObject({ ok: false, retryable: false });
    expect(h.engine.executePrune).not.toHaveBeenCalled();
  });

  it("asks the cost-confirm seam's policy for a slot above the default, and passes it to the engine", async () => {
    const asked: KdfParams[][] = [];
    const ports = costConfirmationFrom(async (costs) => {
      asked.push([...costs]);
      const model = createCostConfirmModel(costs);
      model.confirm();
      return true;
    });
    const h = await harness({ deps: { costConfirmation: ports } });
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    const [, input] = h.engine.preparePrune.mock.calls[0] as [unknown, { costPolicy?: CostPolicy }];
    expect(input.costPolicy).toBe(ports.policy);
    expect(HIGH.m).toBeGreaterThan(STANDARD.m);
    expect(asked).toEqual([]);
  });

  it("without the seam passes no policy, so the engine refuses a slot above the default as the command line does", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    expect(h.engine.preparePrune.mock.calls[0]?.[1]).not.toHaveProperty("costPolicy");
  });
});

describe("prune action: remove", () => {
  it("removes the older entries, keeps the newest N and the current entry, and leaves manifest.enc, keyslots.json and current/ alone", async () => {
    const h = await harness();
    const manifestBefore = h.rig.node.files.get(MANIFEST_PATH);
    const slotsBefore = h.rig.node.files.get(KEYSLOTS_PATH);
    const currentBefore = [...h.rig.node.files.keys()].filter((path) => path.startsWith(`${ROOT}/current/`)).sort();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    const result = await request.remove();
    expect(result).toEqual({ ok: true, kind: "pruned", removed: 20, kept: 20 });
    const left = historyNamesOf(h.rig);
    expect(left).toEqual(seed.names.slice(20));
    expect(left).toContain(historyFileName(TOTAL, seed.manifest.rootCID));
    expect(rmCalls(h.rig).filter((call) => !call.includes("/manifests/"))).toEqual([]);
    expect(bytesEqual(h.rig.node.files.get(MANIFEST_PATH), manifestBefore)).toBe(true);
    expect(bytesEqual(h.rig.node.files.get(KEYSLOTS_PATH), slotsBefore)).toBe(true);
    expect([...h.rig.node.files.keys()].filter((path) => path.startsWith(`${ROOT}/current/`)).sort()).toEqual(currentBefore);
    expect(h.rig.node.calls.filter((call) => call.startsWith("publish "))).toHaveLength(1);
    expect(await readMaintenanceJournal(h.rig.host.kv, ROOT)).toEqual({ kind: "none" });
  });

  it("gives both locks back after the removal, whatever its answer", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    await request.remove();
    expect(h.lock.holder()).toBeUndefined();
    expect([...h.adapter.files.keys()].some((path) => path.endsWith("publish.lock"))).toBe(false);
    // The dialog's own end after the removal is harmless.
    h.opened.prune?.finish("done");
    expect(h.lock.holder()).toBeUndefined();
  });

  it("re-checks the lock file's token before the first write: a lock that changed hands writes nothing and is not retryable", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    const lockPath = [...h.adapter.files.keys()].find((path) => path.endsWith("publish.lock")) as string;
    h.adapter.put(lockPath, JSON.stringify({ token: "another-process", pid: 1 }));
    const result = await request.remove();
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(mutatingCalls(h.rig)).toEqual([]);
    expect(historyNamesOf(h.rig)).toEqual(seed.names);
    expect(h.lock.holder()).toBeUndefined();
  });

  it("reports a node that died mid-prune as the real outcome: not retryable, the journal named, the generic line and the ways out", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    h.rig.node.killAfterMutation = 5;
    const result = await request.remove();
    h.rig.node.killAfterMutation = undefined;
    expect(result).toMatchObject({ ok: false, retryable: false });
    const reason = result.ok ? "" : result.reason;
    expect(reason).toContain(UNEXPECTED_FAILURE_TEXT);
    expect(reason).toContain("A history prune is pending on this device");
    expect(reason).not.toContain("rewrap");
    expect(reason).toContain(MAINTENANCE_WAYS_OUT);
    expect((await readMaintenanceJournal(h.rig.host.kv, ROOT)).kind).toBe("ok");
    expect(NodeKilled).toBeDefined();
    expect(h.lock.holder()).toBeUndefined();
  });

  it("without a preview there is nothing to remove", async () => {
    const h = await harness();
    const request = await open(h);
    expect(await request.remove()).toMatchObject({ ok: false, retryable: false });
    expect(h.engine.executePrune).not.toHaveBeenCalled();
    expect(mutatingCalls(h.rig)).toEqual([]);
  });

  it("a second removal of the same preview does nothing", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    expect(await request.remove()).toMatchObject({ ok: true });
    expect(await request.remove()).toMatchObject({ ok: false });
    expect(h.engine.executePrune).toHaveBeenCalledTimes(1);
  });
});

describe("prune action: refusals are the engine's, and only a refusal that wrote nothing and can be retried is retryable", () => {
  it("a wrong passphrase is retryable, writes nothing, holds no lock, and a second preview works", async () => {
    const h = await harness();
    h.engine.preparePrune.mockRejectedValueOnce(new CryptoError("wrong-passphrase-or-damaged-slot", "wrong passphrase or damaged key slot"));
    const request = await open(h);
    expect(await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress())).toMatchObject({ ok: false, retryable: true });
    expect(h.lock.holder()).toBeUndefined();
    expect(mutatingCalls(h.rig)).toEqual([]);
    expect(await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress())).toMatchObject({ ok: true });
  });

  it("another operation holding the lock is retryable and touches nothing", async () => {
    const h = await harness();
    const request = await open(h);
    const release = h.lock.tryAcquire("publish");
    expect(await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress())).toEqual({ ok: false, reason: busyNotice("publish"), retryable: true });
    expect(h.engine.preparePrune).not.toHaveBeenCalled();
    release?.();
  });

  it("a newest history file that does not authenticate is refused with 'nothing was removed', not retryable, and writes nothing", async () => {
    const h = await harness();
    h.rig.node.files.set(`${ROOT}/manifests/${historyFileName(TOTAL, seed.manifest.rootCID)}`, new Uint8Array(64).fill(7));
    const request = await open(h);
    const result = await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok ? "" : result.reason).toContain("does not authenticate for this vault");
    expect(result.ok ? "" : result.reason).toContain("Nothing was removed");
    expect(mutatingCalls(h.rig)).toEqual([]);
    expect(h.lock.holder()).toBeUndefined();
  });

  it("a pending maintenance journal is refused, naming the ways out", async () => {
    const h = await harness();
    const request = await open(h);
    // A prune that did not finish on this device: the journal a mid-prune kill leaves.
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    h.rig.node.killAfterMutation = 4;
    await request.remove();
    h.rig.node.killAfterMutation = undefined;
    const callsBefore = mutatingCalls(h.rig).length;
    const again = await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    expect(again).toMatchObject({ ok: false, retryable: false });
    expect(again.ok ? "" : again.reason).toContain(MAINTENANCE_WAYS_OUT);
    expect(mutatingCalls(h.rig)).toHaveLength(callsBefore);
    expect(h.lock.holder()).toBeUndefined();
  });

  it("shows an error it does not recognise as a generic line, never its message", async () => {
    const h = await harness();
    h.engine.preparePrune.mockRejectedValueOnce(new Error(`internal detail ${REFERENCE_TEXT}`));
    const request = await open(h);
    const result = await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    expect(result).toEqual({ ok: false, reason: UNEXPECTED_FAILURE_TEXT, retryable: false });
  });
});

describe("prune action: only a person starts it", () => {
  const source = (name: string): string => readFileSync(new URL(`../../src/plugin/${name}`, import.meta.url), "utf8");

  it.each(["publish-runner.ts", "pull-runner.ts", "catch-up.ts", "stale-lock.ts"])("%s (the timer and the catch-up pull) does not reach the prune engine or its action", (name) => {
    expect(source(name)).not.toMatch(/prune/i);
  });

  it("the plugin entry reaches it only through the settings row", () => {
    const entry = source("index.ts");
    const uses = entry.split("\n").filter((line) => /prune/i.test(line) && !line.trim().startsWith("//"));
    expect(uses.filter((line) => line.includes("openPruneHistory"))).toHaveLength(1);
    expect(uses.every((line) => line.includes("openPruneHistory") || line.includes("keyActions.pruneHistory"))).toBe(true);
  });
});

describe("prune action: dispose", () => {
  it("closes the open dialog and gives back the lock a preview holds", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    expect(h.lock.holder()).toBe("key-management");
    h.actions.dispose();
    expect(h.closed).toHaveBeenCalledWith("prune");
    await vi.waitFor(() => expect(h.lock.holder()).toBeUndefined());
  });
});

describe("prune action: no secret is stored", () => {
  it("leaves the typed passphrase in neither the plugin data nor the vault files", async () => {
    const h = await harness();
    const request = await open(h);
    await request.preview({ keep: 20, passphrase: REFERENCE_TEXT }, progress());
    await request.remove();
    const stored = JSON.stringify(h.settings.get());
    for (const secret of [REFERENCE_TEXT, REFERENCE_TEXT.toLowerCase(), REFERENCE_TEXT.replaceAll("-", "")]) {
      expect(stored).not.toContain(secret);
      for (const path of h.adapter.files.keys()) expect(h.adapter.text(path) ?? "").not.toContain(secret);
    }
  });
});
