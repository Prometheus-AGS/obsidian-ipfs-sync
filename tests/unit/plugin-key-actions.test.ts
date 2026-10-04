import { describe, expect, it, vi } from "vitest";
import {
  CryptoError,
  KDF_ITERATIONS_CEILING,
  KDF_ITERATIONS_DEFAULT,
  KDF_MEMORY_CEILING_KIB,
  KDF_MEMORY_DEFAULT_KIB,
  KDF_PARALLELISM,
  formatPassphrase,
  generatePassphrase,
  type CostPolicy,
  type GeneratedPassphrase,
  type KdfParams,
} from "../../src/crypto";
import { enforceCostPolicy } from "../../src/crypto/argon2";
import { costConfirmationFrom, createCostConfirmModel } from "../../src/plugin/cost-confirm-dialog-model";
import { acceptStatementsFor } from "../../src/plugin/accept-slots-dialog-model";
import type { AcceptSlotsDialogRequest } from "../../src/plugin/accept-slots-dialog";
import type { ChangePassphraseDialogRequest } from "../../src/plugin/change-passphrase-dialog";
import type { IncreaseCostDialogRequest } from "../../src/plugin/increase-cost-dialog";
import { UNEXPECTED_FAILURE_TEXT } from "../../src/plugin/key-action-failure";
import { createKeyActions, type KeyActions, type KeyActionsDeps, type KeyEngine } from "../../src/plugin/key-actions";
import type { KeyDialogOpeners } from "../../src/plugin/key-dialogs";
import type { KeyDialogOutcome } from "../../src/plugin/key-dialog-shared";
import type { KeyPorts } from "../../src/plugin/key-ports";
import { loadSettings } from "../../src/plugin/settings-migration";
import { testNodeSettings } from "../helpers/test-node-settings";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import { busyNotice, createSyncLock } from "../../src/plugin/sync-lock";
import type { AcceptDeps, KeyManagementDeps, PreparedAcceptance, PreparedRewrap } from "../../src/sync/key-management";
import { KeyManagementError } from "../../src/sync/key-management";
import { MAINTENANCE_WAYS_OUT } from "../../src/sync/publish-refusals";
import { keySlotsCopyPath } from "../../src/sync/vault-keys";
import { REFERENCE_TEXT } from "../helpers/plugin-session";
import { MemoryAdapter } from "../support/memory-adapter";

const MFS_ROOT = "/obsidian-vault-sync/mvp07b-keys";
const KEY_NAME = testNodeSettings().publicationKey;
const ROOT_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const STANDARD: KdfParams = { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM };
const HIGH: KdfParams = { m: KDF_MEMORY_CEILING_KIB, t: KDF_ITERATIONS_CEILING, p: KDF_PARALLELISM };
const LOWER: KdfParams = { m: 32_768, t: 2, p: KDF_PARALLELISM };
const COPY = new TextEncoder().encode('{"stand-in":"local key-slot copy"}');
const INCOMING = new TextEncoder().encode('{"stand-in":"incoming key slots"}');

const spy = <T extends (...args: never[]) => unknown>(implementation: T) => vi.fn(implementation);

function store(): SettingsStore {
  const port: PluginDataPort = { loadData: async () => null, saveData: async () => undefined };
  return createSettingsStore(port, { ...loadSettings(null), settings: { ...testNodeSettings(), mfsRoot: MFS_ROOT } });
}

interface Captured<R> {
  request: R;
  finish: (outcome: KeyDialogOutcome) => void;
}

interface Rig {
  readonly actions: KeyActions;
  readonly adapter: MemoryAdapter;
  readonly settings: SettingsStore;
  readonly lock: ReturnType<typeof createSyncLock>;
  readonly engine: { [K in keyof KeyEngine]: ReturnType<typeof vi.fn> };
  readonly afterChange: ReturnType<typeof vi.fn>;
  readonly ports: KeyPorts;
  readonly prepared: PreparedRewrap;
  readonly preparedAcceptance: PreparedAcceptance;
  readonly generated: GeneratedPassphrase;
  readonly opened: {
    change?: Captured<ChangePassphraseDialogRequest>;
    cost?: Captured<IncreaseCostDialogRequest>;
    accept?: Captured<AcceptSlotsDialogRequest>;
  };
  readonly closed: ReturnType<typeof vi.fn>;
}

async function rig(options: { readonly copy?: boolean; readonly deps?: Partial<KeyActionsDeps> } = {}): Promise<Rig> {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  if (options.copy !== false) adapter.put(await keySlotsCopyPath(MFS_ROOT), COPY);
  const settings = store();
  const lock = createSyncLock();
  const generated = generatePassphrase();
  const prepared = { vault: { keySlots: COPY }, start: {}, currentCost: STANDARD } as unknown as PreparedRewrap;
  const ports: KeyPorts = {
    deps: { stand: "in" } as unknown as KeyManagementDeps,
    acceptDeps: { stand: "in" } as unknown as AcceptDeps,
    key: { absent: false },
    keyRefusal: undefined,
    mfsRoot: MFS_ROOT,
    keyName: KEY_NAME,
    readCopy: async () => COPY,
    resolveAcceptTarget: async () => ({ kind: "name", rootCid: ROOT_CID }),
  };
  const acceptance = { keySlots: INCOMING } as unknown as PreparedAcceptance["acceptance"];
  const preparedAcceptance = { mfsRoot: MFS_ROOT, target: { kind: "name", rootCid: ROOT_CID }, acceptance, maintenance: { kind: "none" }, work: { copy: true, state: false, publishJournal: false, maintenance: false } } as unknown as PreparedAcceptance;
  const engine = {
    prepareRewrap: spy(async () => prepared),
    planRewrapCost: spy((_slots: Uint8Array, choice: { kind: string; cost: KdfParams | undefined }) => ({ current: STANDARD, next: choice.cost ?? STANDARD, raises: false, downgrade: false })),
    executeRewrap: spy(async () => ({ kind: "rewrapped", testUnlock: "verified" })),
    prepareAcceptance: spy(async () => preparedAcceptance),
    commitAcceptance: spy(async () => ({ kind: "accepted" })),
    costFloorOf: spy((bytes: Uint8Array) => (bytes === INCOMING ? LOWER : STANDARD)),
    pendingMaintenance: spy(async () => undefined),
    // Task 2.5: the prune engine functions are driven by `plugin-prune-action.test.ts`; these actions never call them.
    preparePrune: spy(async () => {
      throw new Error("this suite does not prune");
    }),
    executePrune: spy(async () => {
      throw new Error("this suite does not prune");
    }),
  };
  const opened: Rig["opened"] = {};
  const closed = vi.fn();
  const dialogs: KeyDialogOpeners = {
    changePassphrase: (request, finish) => {
      opened.change = { request, finish };
      return { close: () => closed("change") };
    },
    increaseCost: (request, finish) => {
      opened.cost = { request, finish };
      return { close: () => closed("cost") };
    },
    acceptSlots: (request, finish) => {
      opened.accept = { request, finish };
      return { close: () => closed("accept") };
    },
    // Task 2.5: the prune dialog is driven by `plugin-prune-action.test.ts`; these actions never open it.
    pruneHistory: () => {
      throw new Error("this suite does not open the prune dialog");
    },
  };
  const afterChange = vi.fn();
  const actions = createKeyActions({
    store: settings,
    adapter,
    lock,
    transport: async () => {
      throw new Error("a stubbed key action must not reach the transport");
    },
    now: () => new Date(1_800_000_000_000),
    dialogs,
    afterChange,
    engine: engine as unknown as KeyEngine,
    openPorts: async () => ports,
    generate: () => generated,
    ...options.deps,
  });
  return { actions, adapter, settings, lock, engine, afterChange, ports, prepared, preparedAcceptance, generated, opened, closed };
}

const progress = (): ((fraction: number) => void) => () => undefined;

describe("key actions: slot cost", () => {
  it("is the cost of the local key-slot copy, read from one local file", async () => {
    const r = await rig();
    expect(await r.actions.slotCost()).toEqual(STANDARD);
    expect(r.engine.costFloorOf).toHaveBeenCalledWith(COPY);
  });

  it("is undefined when this device holds no copy, and no dialog opens for an action", async () => {
    const r = await rig({ copy: false });
    expect(await r.actions.slotCost()).toBeUndefined();
    expect(await r.actions.changePassphrase()).toBe("no-vault");
    expect(await r.actions.increaseCost()).toBe("no-vault");
    expect(await r.actions.acceptSlots()).toBe("no-vault");
    expect(r.opened).toEqual({});
  });
});

describe("key actions: change passphrase is wired to the engine", () => {
  it("shows the generated passphrase in display form with the current cost", async () => {
    const r = await rig();
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    expect(r.opened.change?.request.passphrase).toBe(formatPassphrase(r.generated));
    expect(r.opened.change?.request.cost).toEqual(STANDARD);
  });

  it("prepares, then rewraps with the generated passphrase at the current cost, and reports the test unlock", async () => {
    const r = await rig();
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    const result = await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    expect(result).toEqual({ ok: true, testUnlock: "verified" });
    expect(r.engine.prepareRewrap).toHaveBeenCalledWith(r.ports.deps, expect.objectContaining({ mfsRoot: MFS_ROOT, keyName: KEY_NAME, key: r.ports.key }));
    expect(r.engine.planRewrapCost).toHaveBeenCalledWith(COPY, { kind: "change-passphrase", cost: undefined });
    const [, prepared, input] = r.engine.executeRewrap.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(prepared).toBe(r.prepared);
    expect(input["next"]).toEqual({ kind: "generated", passphrase: r.generated });
    expect(input["params"]).toEqual(STANDARD);
    expect(input).not.toHaveProperty("allowDowngrade");
    expect(r.afterChange).toHaveBeenCalledTimes(1);
  });

  it("wipes the canonical passphrase it made from the typed text, and releases both locks", async () => {
    const r = await rig();
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    const input = r.engine.prepareRewrap.mock.calls[0]?.[1] as { passphrase: Uint8Array };
    expect([...input.passphrase].every((byte) => byte === 0)).toBe(true);
    expect(r.lock.holder()).toBeUndefined();
    expect([...r.adapter.files.keys()].some((path) => path.endsWith("publish.lock"))).toBe(false);
  });

  it("holds the sync lock while the engine works", async () => {
    const r = await rig();
    let holder: string | undefined;
    r.engine.prepareRewrap.mockImplementation(async () => {
      holder = r.lock.holder();
      return r.prepared;
    });
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    expect(holder).toBe("key-management");
  });

  it("answers a wrong passphrase as retryable and changes nothing", async () => {
    const r = await rig();
    r.engine.prepareRewrap.mockRejectedValue(new CryptoError("wrong-passphrase-or-damaged-slot", "wrong passphrase or damaged key slot"));
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    const result = await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(r.engine.executeRewrap).not.toHaveBeenCalled();
    expect(r.afterChange).not.toHaveBeenCalled();
    expect(r.lock.holder()).toBeUndefined();
  });

  it("answers a failure after the journal as not retryable, names the ways out, and never echoes the passphrase", async () => {
    const r = await rig();
    r.engine.executeRewrap.mockRejectedValue(new KeyManagementError("test-unlock-failed", "the new passphrase could not be verified"));
    r.engine.pendingMaintenance.mockResolvedValue({ type: "rewrap" });
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    const result = await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    expect(result).toMatchObject({ ok: false, retryable: false });
    const reason = result && !result.ok ? result.reason : "";
    expect(reason).toContain("the new passphrase could not be verified");
    expect(reason).toContain(MAINTENANCE_WAYS_OUT);
    expect(reason).not.toContain(REFERENCE_TEXT);
    expect(r.afterChange).not.toHaveBeenCalled();
    expect(r.lock.holder()).toBeUndefined();
  });

  it("shows an error it does not recognise as a generic line, never its message", async () => {
    const r = await rig();
    r.engine.prepareRewrap.mockRejectedValue(new Error(`internal detail ${REFERENCE_TEXT}`));
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    const result = await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    expect(result).toEqual({ ok: false, reason: UNEXPECTED_FAILURE_TEXT, retryable: false });
  });

  it("refuses while another operation holds the lock: retryable, nothing touched, and no dialog opens", async () => {
    const r = await rig();
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    const release = r.lock.tryAcquire("publish");
    const result = await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    expect(result).toEqual({ ok: false, reason: busyNotice("publish"), retryable: true });
    expect(r.engine.prepareRewrap).not.toHaveBeenCalled();
    release?.();
    const second = await rig();
    const hold = second.lock.tryAcquire("pull");
    expect(await second.actions.changePassphrase()).toBe("busy");
    expect(second.opened).toEqual({});
    hold?.();
  });

  it("ends the call with the dialog's outcome and wipes the generated passphrase", async () => {
    const r = await rig();
    const ended = r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    r.opened.change?.finish("done");
    expect(await ended).toBe("done");
    expect([...r.generated].every((byte) => byte === 0)).toBe(true);
  });

  it("opens one key dialog at a time", async () => {
    const r = await rig();
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    expect(await r.actions.increaseCost()).toBe("already-open");
  });
});

describe("key actions: increase cost is wired to the engine", () => {
  async function open(r: Rig): Promise<IncreaseCostDialogRequest> {
    void r.actions.increaseCost();
    await vi.waitFor(() => expect(r.opened.cost).toBeDefined());
    return (r.opened.cost as Captured<IncreaseCostDialogRequest>).request;
  }

  it("shows the current cost", async () => {
    const r = await rig();
    expect((await open(r)).current).toEqual(STANDARD);
  });

  it("plans a higher cost with the engine and rewraps with the same passphrase", async () => {
    const r = await rig();
    const request = await open(r);
    const result = await request.run({ passphrase: REFERENCE_TEXT, params: HIGH, allowDowngrade: false }, progress());
    expect(result).toEqual({ ok: true, testUnlock: "verified" });
    expect(r.engine.planRewrapCost).toHaveBeenCalledWith(COPY, { kind: "increase-cost", cost: HIGH });
    const input = r.engine.executeRewrap.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input["next"]).toEqual({ kind: "reuse" });
    expect(input["params"]).toEqual(HIGH);
    expect(input).not.toHaveProperty("allowDowngrade");
    expect(r.afterChange).toHaveBeenCalledTimes(1);
  });

  it("sends the confirmed lower choice straight to the rewrap with the downgrade allowed, because the plan refuses a lower increase", async () => {
    const r = await rig();
    const request = await open(r);
    const result = await request.run({ passphrase: REFERENCE_TEXT, params: LOWER, allowDowngrade: true }, progress());
    expect(result).toEqual({ ok: true, testUnlock: "verified" });
    expect(r.engine.planRewrapCost).not.toHaveBeenCalledWith(COPY, expect.objectContaining({ kind: "increase-cost" }));
    const input = r.engine.executeRewrap.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input["next"]).toEqual({ kind: "reuse" });
    expect(input["params"]).toEqual(LOWER);
    expect(input["allowDowngrade"]).toBe(true);
  });

  it("does not allow the downgrade for a lower choice that was not confirmed: the rewrap is left to refuse it", async () => {
    const r = await rig();
    r.engine.executeRewrap.mockRejectedValue(new CryptoError("kdf-cost-refused", "a lower cost needs the downgrade confirmation"));
    const request = await open(r);
    const result = await request.run({ passphrase: REFERENCE_TEXT, params: LOWER, allowDowngrade: false }, progress());
    expect(r.engine.executeRewrap.mock.calls[0]?.[2]).not.toHaveProperty("allowDowngrade");
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});

describe("key actions: accept is wired to the engine", () => {
  async function open(r: Rig): Promise<AcceptSlotsDialogRequest> {
    void r.actions.acceptSlots();
    await vi.waitFor(() => expect(r.opened.accept).toBeDefined());
    return (r.opened.accept as Captured<AcceptSlotsDialogRequest>).request;
  }

  it("asks for the node's current root and reviews the cost of the copy and of the incoming slots", async () => {
    const r = await rig();
    const request = await open(r);
    expect(request.target).toBe("name");
    expect(acceptStatementsFor(request.target).length).toBeGreaterThan(0);
    const result = await request.checkSlots(REFERENCE_TEXT, progress());
    expect(result).toEqual({ ok: true, review: { current: STANDARD, incoming: LOWER, changes: true } });
    expect(r.engine.prepareAcceptance).toHaveBeenCalledWith(
      r.ports.acceptDeps,
      expect.objectContaining({ mfsRoot: MFS_ROOT, target: { kind: "name", rootCid: ROOT_CID } }),
    );
    expect(r.engine.costFloorOf).toHaveBeenCalledWith(COPY);
    expect(r.engine.costFloorOf).toHaveBeenCalledWith(INCOMING);
    expect(r.afterChange).not.toHaveBeenCalled();
  });

  it("takes the review's changes flag from the prepared work", async () => {
    const r = await rig();
    const prepared = r.preparedAcceptance;
    r.engine.prepareAcceptance.mockResolvedValue({ ...prepared, work: { copy: false, state: false, publishJournal: false, maintenance: false } });
    const result = await (await open(r)).checkSlots(REFERENCE_TEXT, progress());
    expect(result).toMatchObject({ ok: true, review: { changes: false } });
  });

  it("keeps the locks from a good check until Accept ends, then stores through the engine and gives them back", async () => {
    const r = await rig();
    const request = await open(r);
    await request.checkSlots(REFERENCE_TEXT, progress());
    expect(r.lock.holder()).toBe("key-management");
    const result = await request.accept({ downgradeConfirmed: true });
    expect(result).toEqual({ ok: true, kind: "accepted" });
    expect(r.engine.commitAcceptance).toHaveBeenCalledWith(r.ports.acceptDeps, expect.anything(), { downgradeConfirmed: true });
    expect(r.afterChange).toHaveBeenCalledTimes(1);
    expect(r.lock.holder()).toBeUndefined();
  });

  it("gives the locks back when the dialog closes after a check without Accept", async () => {
    const r = await rig();
    const ended = r.actions.acceptSlots();
    await vi.waitFor(() => expect(r.opened.accept).toBeDefined());
    await r.opened.accept?.request.checkSlots(REFERENCE_TEXT, progress());
    expect(r.lock.holder()).toBe("key-management");
    r.opened.accept?.finish("cancelled");
    expect(await ended).toBe("cancelled");
    expect(r.lock.holder()).toBeUndefined();
  });

  it("a wrong passphrase at the check is retryable and holds no lock; a later check works", async () => {
    const r = await rig();
    r.engine.prepareAcceptance.mockRejectedValueOnce(new CryptoError("wrong-passphrase-or-damaged-slot", "wrong passphrase or damaged key slot"));
    const request = await open(r);
    expect(await request.checkSlots(REFERENCE_TEXT, progress())).toMatchObject({ ok: false, retryable: true });
    expect(r.lock.holder()).toBeUndefined();
    expect(await request.checkSlots(REFERENCE_TEXT, progress())).toMatchObject({ ok: true });
  });

  it("a failed commit is the real outcome: not retryable, nothing reported as accepted, locks released", async () => {
    const r = await rig();
    r.engine.commitAcceptance.mockRejectedValue(new KeyManagementError("record-mismatch", "this device's record belongs to another vault"));
    const request = await open(r);
    await request.checkSlots(REFERENCE_TEXT, progress());
    const result = await request.accept({ downgradeConfirmed: false });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(r.afterChange).not.toHaveBeenCalled();
    expect(r.lock.holder()).toBeUndefined();
  });

  it("Accept without a current check does nothing", async () => {
    const r = await rig();
    const request = await open(r);
    expect(await request.accept({ downgradeConfirmed: false })).toMatchObject({ ok: false, retryable: false });
    expect(r.engine.commitAcceptance).not.toHaveBeenCalled();
  });

  it("refuses when the withdrawal of a pending rewrap needs a publication key this installation does not own", async () => {
    const r = await rig();
    const prepared = r.preparedAcceptance;
    r.engine.prepareAcceptance.mockResolvedValue({ ...prepared, maintenance: { kind: "ok", journal: { type: "rewrap", phase: "journaled" } } });
    (r.ports as { keyRefusal: unknown }).keyRefusal = new KeyManagementError("no-record", "the publication key is not owned by this installation");
    const result = await (await open(r)).checkSlots(REFERENCE_TEXT, progress());
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not owned by this installation") });
    expect(r.lock.holder()).toBeUndefined();
  });
});

describe("key actions: no secret is stored", () => {
  it("leaves neither the typed nor the generated passphrase in the plugin data or the vault files", async () => {
    const r = await rig();
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    const generated = formatPassphrase(r.generated);
    const stored = JSON.stringify(r.settings.get());
    for (const secret of [REFERENCE_TEXT, REFERENCE_TEXT.toLowerCase(), generated, generated.replaceAll("-", "")]) {
      expect(stored).not.toContain(secret);
      for (const path of r.adapter.files.keys()) expect(r.adapter.text(path) ?? "").not.toContain(secret);
    }
  });
});

describe("key actions: a slot above the default cost needs an explicit confirm (task 2.4)", () => {
  /** The engine's own rule, stood in for the stubbed engine: the policy decides before anything else happens. */
  function refusingEngine(r: Rig): void {
    r.engine.prepareRewrap.mockImplementation(async (_deps: unknown, input: { costPolicy?: CostPolicy }) => {
      await enforceCostPolicy([HIGH], input.costPolicy);
      return r.prepared;
    });
    r.engine.prepareAcceptance.mockImplementation(async (_deps: unknown, input: { confirmCost?: (costs: readonly KdfParams[]) => Promise<boolean> }) => {
      if (input.confirmCost === undefined || (await input.confirmCost([HIGH])) !== true) throw new CryptoError("kdf-cost-refused", "key slot cost not approved");
      return r.preparedAcceptance;
    });
  }

  const dialogAnswering = (answer: (costs: readonly KdfParams[]) => boolean) => {
    const asked: KdfParams[][] = [];
    const ports = costConfirmationFrom(async (costs) => {
      asked.push([...costs]);
      const model = createCostConfirmModel(costs);
      if (answer(costs)) model.confirm();
      else model.cancel();
      return model.state().decided && answer(costs);
    });
    return { asked, ports };
  };

  it("without a confirmation port the rewrap is refused and nothing is written", async () => {
    const r = await rig();
    refusingEngine(r);
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    const result = await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    expect(result).toMatchObject({ ok: false });
    expect(r.engine.executeRewrap).not.toHaveBeenCalled();
    expect(r.afterChange).not.toHaveBeenCalled();
  });

  it("a rewrap of a slot above the default proceeds only after the explicit confirm, which is asked before the rewrap", async () => {
    const { asked, ports } = dialogAnswering(() => true);
    const r = await rig({ deps: { costConfirmation: ports } });
    refusingEngine(r);
    void r.actions.changePassphrase();
    await vi.waitFor(() => expect(r.opened.change).toBeDefined());
    const result = await r.opened.change?.request.run(REFERENCE_TEXT, progress());
    expect(result).toEqual({ ok: true, testUnlock: "verified" });
    expect(asked).toEqual([[HIGH]]);
    expect(r.engine.prepareRewrap.mock.invocationCallOrder[0]).toBeLessThan(r.engine.executeRewrap.mock.invocationCallOrder[0] as number);
    const [, , rewrap] = r.engine.executeRewrap.mock.calls[0] as [unknown, unknown, { costPolicy?: unknown }];
    expect(rewrap.costPolicy).toBe(ports.policy);
    expect(r.lock.holder()).toBeUndefined();
  });

  it("a rewrap is refused on cancel or close: the engine is never asked to rewrap and the locks are given back", async () => {
    const { asked, ports } = dialogAnswering(() => false);
    const r = await rig({ deps: { costConfirmation: ports } });
    refusingEngine(r);
    void r.actions.increaseCost();
    await vi.waitFor(() => expect(r.opened.cost).toBeDefined());
    const result = await r.opened.cost?.request.run({ passphrase: REFERENCE_TEXT, params: HIGH, allowDowngrade: false }, progress());
    expect(result).toMatchObject({ ok: false });
    expect(asked).toEqual([[HIGH]]);
    expect(r.engine.executeRewrap).not.toHaveBeenCalled();
    expect(r.afterChange).not.toHaveBeenCalled();
    expect(r.lock.holder()).toBeUndefined();
  });

  it("an incoming slot above the default is accepted for review only after the explicit confirm", async () => {
    const { asked, ports } = dialogAnswering(() => true);
    const r = await rig({ deps: { costConfirmation: ports } });
    refusingEngine(r);
    void r.actions.acceptSlots();
    await vi.waitFor(() => expect(r.opened.accept).toBeDefined());
    const result = await r.opened.accept?.request.checkSlots(REFERENCE_TEXT, progress());
    expect(result).toMatchObject({ ok: true });
    expect(asked).toEqual([[HIGH]]);
    const [, input] = r.engine.prepareAcceptance.mock.calls[0] as [unknown, { confirmCost?: unknown }];
    expect(input.confirmCost).toBe(ports.confirm);
    await r.opened.accept?.request.accept({ downgradeConfirmed: false });
    expect(r.engine.commitAcceptance).toHaveBeenCalledTimes(1);
  });

  it("an incoming slot is refused on cancel or close: no review, no commit, the lock is given back", async () => {
    const { asked, ports } = dialogAnswering(() => false);
    const r = await rig({ deps: { costConfirmation: ports } });
    refusingEngine(r);
    void r.actions.acceptSlots();
    await vi.waitFor(() => expect(r.opened.accept).toBeDefined());
    const result = await r.opened.accept?.request.checkSlots(REFERENCE_TEXT, progress());
    expect(result).toMatchObject({ ok: false });
    expect(asked).toEqual([[HIGH]]);
    expect(r.engine.commitAcceptance).not.toHaveBeenCalled();
    expect(r.lock.holder()).toBeUndefined();
  });
});

describe("key actions: dispose", () => {
  it("closes the open dialog and gives back a lock an accept review holds", async () => {
    const r = await rig();
    void r.actions.acceptSlots();
    await vi.waitFor(() => expect(r.opened.accept).toBeDefined());
    await r.opened.accept?.request.checkSlots(REFERENCE_TEXT, progress());
    expect(r.lock.holder()).toBe("key-management");
    r.actions.dispose();
    expect(r.closed).toHaveBeenCalledWith("accept");
    await vi.waitFor(() => expect(r.lock.holder()).toBeUndefined());
  });
});
