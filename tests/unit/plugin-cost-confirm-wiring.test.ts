// mvp-07b task 2.4, wiring half: the cost-confirm answer reaches plugin pull, publish (the session's unlock and the engine) and Restore, on manual runs
// only. A vault whose slot costs more than the default proceeds after an explicit yes and refuses on a no; the unattended (timer, catch-up) path is
// handed no confirmation and is never asked. The vault is made at a cheap cost above the default (more iterations at the floor memory) so the real
// derivation stays fast; everything else is the real runner and the real engine over the recording fake node. Nothing here ran in Obsidian.
import { describe, expect, it, vi } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import type { CostPolicy, KdfParams } from "../../src/crypto";
import { costConfirmationFrom } from "../../src/plugin/cost-confirm-dialog-model";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { unlockForRestore } from "../../src/plugin/pull-restore";
import { createPublishRunner, type PublishOutcome } from "../../src/plugin/publish-runner";
import type { PullOutcome } from "../../src/plugin/pull-runner";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import { pullEncryptedVault } from "../../src/sync/encrypted-pull-stage";
import { publishVault } from "../../src/sync/publish";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { resetNodeTrace, servedRoot } from "../helpers/encrypted-pull-rig";
import { pluginOver } from "../helpers/plugin-pull-encrypted-rig";
import { sessionRig } from "../helpers/plugin-session";
import { ROOT, createRig, seedVault, type Rig } from "../helpers/publish-rig";
import { sourceTexts } from "../helpers/pull-stage-rig";
import { initVault } from "../helpers/vault-init";
import { MemoryAdapter } from "../support/memory-adapter";

// Wrap the three engine entry points the plugin calls so a test sees exactly what the runner handed them; each still runs for real.
vi.mock("../../src/sync/encrypted-pull-stage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/sync/encrypted-pull-stage")>();
  return { ...original, pullEncryptedVault: vi.fn(original.pullEncryptedVault) };
});
vi.mock("../../src/sync/publish", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/sync/publish")>();
  return { ...original, publishVault: vi.fn(original.publishVault) };
});
vi.mock("../../src/plugin/pull-restore", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/plugin/pull-restore")>();
  return { ...original, unlockForRestore: vi.fn(original.unlockForRestore) };
});

/** Above the default cost (3 iterations), at the floor memory: a real derivation of a tenth of a second or so. */
const HIGH: KdfParams = { m: 19_456, t: 4, p: 1 };
const APPROVE: CostPolicy = { approveCost: async () => true };
const MUTATING = /^(write|rm|pin|publish|keyGen) /;

/** Device A: a vault whose only key slot costs HIGH, published once. */
async function highPublisher(): Promise<Rig> {
  const rig = createRig();
  seedVault(rig.host);
  await rig.init(HIGH);
  await rig.publish({ costPolicy: APPROVE });
  servedRoot(rig.node);
  resetNodeTrace(rig.node);
  return rig;
}

/** The asking function of the dialog, as a stub: it records the costs it was shown and answers with `answer`. */
function asker(answer: boolean): { readonly ask: (costs: readonly KdfParams[]) => Promise<boolean>; readonly shown: (readonly KdfParams[])[] } {
  const shown: (readonly KdfParams[])[] = [];
  return {
    shown,
    ask: async (costs) => {
      shown.push(costs);
      return answer;
    },
  };
}

const finished = (outcome: PullOutcome): boolean => outcome.kind === "completed" || outcome.kind === "unfinished";
const filesOf = (adapter: MemoryAdapter): string[] => [...adapter.files.keys()].sort();
const pullDeps = (): Parameters<typeof pullEncryptedVault>[0][] => vi.mocked(pullEncryptedVault).mock.calls.map(([deps]) => deps);

describe("plugin pull: a slot above the default cost", () => {
  it("is refused with no confirmation wired, and writes nothing", async () => {
    const publisher = await highPublisher();
    const b = pluginOver(publisher);
    const before = filesOf(b.adapter);
    const outcome = await b.pull();
    expect(finished(outcome)).toBe(false);
    expect(outcome.notice).toMatch(/cost/i);
    expect(filesOf(b.adapter)).toEqual(before);
  });

  it("proceeds after an explicit yes, asked once with the slot's cost and only once the passphrase is in hand", async () => {
    const publisher = await highPublisher();
    const stub = asker(true);
    const b = pluginOver(publisher, { confirmCost: costConfirmationFrom(stub.ask).confirm });
    const outcome = await b.pull();
    expect(outcome.kind).toBe("completed");
    expect(stub.shown).toEqual([[HIGH]]);
    expect(b.passphrase.requests).toEqual([{ attempt: 1 }]);
    expect(b.texts()).toEqual(sourceTexts(publisher));
  });

  it("refuses on a no and writes nothing", async () => {
    const publisher = await highPublisher();
    const stub = asker(false);
    const b = pluginOver(publisher, { confirmCost: costConfirmationFrom(stub.ask).confirm });
    const before = filesOf(b.adapter);
    const outcome = await b.pull();
    expect(stub.shown).toEqual([[HIGH]]);
    expect(finished(outcome)).toBe(false);
    expect(filesOf(b.adapter)).toEqual(before);
    expect(await b.state()).toBeUndefined();
  });

  it("the unattended run is handed no confirmation, is never asked, and keeps refusing", async () => {
    const publisher = await highPublisher();
    const stub = asker(true);
    vi.mocked(pullEncryptedVault).mockClear();
    const b = pluginOver(publisher, { confirmCost: costConfirmationFrom(stub.ask).confirm });
    const before = filesOf(b.adapter);
    const outcome = await b.pull({ unattended: true });
    expect(finished(outcome)).toBe(false);
    expect(stub.shown).toEqual([]);
    expect(pullDeps().length).toBeGreaterThan(0);
    for (const deps of pullDeps()) expect(deps.confirmCost).toBeUndefined();
    expect(filesOf(b.adapter)).toEqual(before);
  });

  it("a manual run hands the engine the confirmation", async () => {
    const publisher = await highPublisher();
    vi.mocked(pullEncryptedVault).mockClear();
    const b = pluginOver(publisher, { confirmCost: costConfirmationFrom(asker(true).ask).confirm });
    await b.pull();
    expect(pullDeps().length).toBeGreaterThan(0);
    for (const deps of pullDeps()) expect(typeof deps.confirmCost).toBe("function");
  });
});

const PUBLISH_ROOT = "/obsidian-vault-sync/mvp07b-cost";

function store(): SettingsStore {
  const port: PluginDataPort = { loadData: async () => null, saveData: async () => undefined };
  return createSettingsStore(port, { ...loadSettings(null), settings: { ...defaultSettings(), mfsRoot: PUBLISH_ROOT } });
}

interface PublishRig {
  readonly adapter: MemoryAdapter;
  readonly node: FakeNode;
  readonly run: (unattended?: boolean) => Promise<PublishOutcome>;
}

/** A plugin vault whose local key-slot copy costs HIGH, a locked session, and a runner. `policy` is wired into the session's unlock and the engine alike, as `index.ts` does. */
async function highPluginVault(policy: CostPolicy | undefined): Promise<PublishRig> {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/a.md", "alpha", 1000);
  const node = createFakeNode();
  await initVault(createObsidianHostBridge({ adapter }).fs, node, PUBLISH_ROOT, HIGH);
  const settings = store();
  const session = sessionRig({ store: settings, adapter, createClient: () => node.client, ...(policy === undefined ? {} : { costPolicy: policy }) }).session;
  const runner = createPublishRunner({
    store: settings,
    adapter,
    bus: createSyncEventBus(),
    session,
    createClient: () => node.client,
    now: () => new Date(1_800_000_000_000),
    ...(policy === undefined ? {} : { costPolicy: policy }),
  });
  return { adapter, node, run: (unattended = false) => runner.run({ unattended }) };
}

const publishOptions = (): { readonly costPolicy?: CostPolicy }[] => vi.mocked(publishVault).mock.calls.map(([, options]) => options);

describe("plugin publish: a slot above the default cost", () => {
  it("is refused with no confirmation wired, and sends nothing to the node", async () => {
    const r = await highPluginVault(undefined);
    const outcome = await r.run();
    expect(outcome.kind).not.toBe("published");
    expect(outcome.notice).toMatch(/cost/i);
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("proceeds after an explicit yes: asked once, at the unlock, and the engine is handed the policy", async () => {
    const stub = asker(true);
    const r = await highPluginVault(costConfirmationFrom(stub.ask).policy);
    vi.mocked(publishVault).mockClear();
    const outcome = await r.run();
    expect(outcome.kind).toBe("published");
    expect(stub.shown).toEqual([[HIGH]]);
    expect(publishOptions().length).toBeGreaterThan(0);
    for (const options of publishOptions()) expect(options.costPolicy).toBeDefined();
  });

  it("refuses on a no and writes nothing to the node", async () => {
    const stub = asker(false);
    const r = await highPluginVault(costConfirmationFrom(stub.ask).policy);
    const outcome = await r.run();
    expect(stub.shown).toEqual([[HIGH]]);
    expect(outcome.kind).not.toBe("published");
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("the timer path with a locked session refuses before the engine and never asks", async () => {
    const stub = asker(true);
    const r = await highPluginVault(costConfirmationFrom(stub.ask).policy);
    vi.mocked(publishVault).mockClear();
    const outcome = await r.run(true);
    expect(outcome).toMatchObject({ kind: "refused", reason: "locked" });
    expect(stub.shown).toEqual([]);
    expect(vi.mocked(publishVault)).not.toHaveBeenCalled();
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("the timer path with an unlocked session is handed no policy and is never asked", async () => {
    const stub = asker(true);
    const r = await highPluginVault(costConfirmationFrom(stub.ask).policy);
    expect((await r.run()).kind).toBe("published");
    stub.shown.length = 0;
    r.adapter.put("notes/a.md", "alpha again", 2000);
    vi.mocked(publishVault).mockClear();
    const outcome = await r.run(true);
    expect(outcome.kind).toBe("published");
    expect(stub.shown).toEqual([]);
    expect(publishOptions().length).toBeGreaterThan(0);
    for (const options of publishOptions()) expect(options.costPolicy).toBeUndefined();
  });
});

describe("plugin Restore: a slot above the default cost", () => {
  async function twoVersions(): Promise<Rig> {
    const publisher = await highPublisher();
    publisher.host.clock += 60_000;
    publisher.host.put("Daily/2026-09-30.md", "Second edition.\n");
    await publisher.publish({ costPolicy: APPROVE });
    servedRoot(publisher.node);
    resetNodeTrace(publisher.node);
    return publisher;
  }

  it("proceeds after an explicit yes, asked once", async () => {
    const publisher = await twoVersions();
    const stub = asker(true);
    const b = pluginOver(publisher, { confirmCost: costConfirmationFrom(stub.ask).confirm });
    b.dialogs.answers.restoreIndex = 1;
    const outcome = await b.runner.restore();
    expect(stub.shown).toEqual([[HIGH]]);
    expect(outcome.kind).toBe("completed");
  });

  it("refuses on a no before any listing is shown, and writes nothing", async () => {
    const publisher = await twoVersions();
    const stub = asker(false);
    const b = pluginOver(publisher, { confirmCost: costConfirmationFrom(stub.ask).confirm });
    const before = filesOf(b.adapter);
    const outcome = await b.runner.restore();
    expect(stub.shown).toEqual([[HIGH]]);
    expect(finished(outcome)).toBe(false);
    expect(b.dialogs.lists).toEqual([]);
    expect(filesOf(b.adapter)).toEqual(before);
  });

  it("with no confirmation wired it refuses and says the cost was the reason", async () => {
    const publisher = await twoVersions();
    const b = pluginOver(publisher);
    const outcome = await b.runner.restore();
    expect(finished(outcome)).toBe(false);
    expect(b.dialogs.lists).toEqual([]);
    expect(outcome.notice).toMatch(/cost/i);
  });

  it("hands unlockForRestore the confirmation", async () => {
    const publisher = await twoVersions();
    vi.mocked(unlockForRestore).mockClear();
    const b = pluginOver(publisher, { confirmCost: costConfirmationFrom(asker(true).ask).confirm });
    await b.runner.restore();
    const [input] = vi.mocked(unlockForRestore).mock.calls[0] ?? [];
    expect(typeof input?.confirmCost).toBe("function");
  });
});
