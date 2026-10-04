import { describe, expect, it, vi } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { massRemovalTimerNotice } from "../../src/plugin/mass-removal-dialog-model";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { createPublishRunner, type PublishRunner } from "../../src/plugin/publish-runner";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import type { MassRemovalCounts } from "../../src/sync/publish-refusals";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { sessionRig } from "../helpers/plugin-session";
import { initVault } from "../helpers/vault-init";
import { MemoryAdapter } from "../support/memory-adapter";

const MFS_ROOT = "/obsidian-vault-sync/mvp07b-removal";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const EMPTIED: MassRemovalCounts = { removing: 2, remaining: 2, exclusionDriven: 0 };

function store(): SettingsStore {
  const port: PluginDataPort = { loadData: async () => null, saveData: async () => undefined };
  return createSettingsStore(port, { ...loadSettings(null), settings: { ...defaultSettings(), mfsRoot: MFS_ROOT } });
}

interface Rig {
  readonly adapter: MemoryAdapter;
  readonly node: FakeNode;
  readonly runner: PublishRunner;
  readonly asked: MassRemovalCounts[];
}

/** A published two-note vault with the session already unlocked (the first run is manual), then both notes deleted from the folder. */
async function emptiedVault(answer: ((counts: MassRemovalCounts) => Promise<boolean>) | undefined): Promise<Rig> {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/hello.md", "hello", 1000);
  adapter.put("notes/world.md", "world", 1000);
  const node = createFakeNode();
  await initVault(createObsidianHostBridge({ adapter }).fs, node, MFS_ROOT);
  const settings = store();
  const asked: MassRemovalCounts[] = [];
  const runner = createPublishRunner({
    store: settings,
    adapter,
    bus: createSyncEventBus(),
    createClient: () => node.client,
    session: sessionRig({ store: settings, adapter, createClient: () => node.client }).session,
    now: () => new Date(1_800_000_000_000),
    ...(answer === undefined
      ? {}
      : {
          askMassRemoval: async (counts: MassRemovalCounts) => {
            asked.push(counts);
            return answer(counts);
          },
        }),
  });
  expect((await runner.run()).kind).toBe("published");
  adapter.files.delete("notes/hello.md");
  adapter.files.delete("notes/world.md");
  node.calls.length = 0;
  return { adapter, node, runner, asked };
}

const writes = (node: FakeNode): string[] => node.calls.filter((call) => MUTATING.test(call));

describe("plugin publish: mass-removal port", () => {
  it("a manual publish asks through the port with the counts and publishes after a yes", async () => {
    const r = await emptiedVault(async () => true);
    r.asked.length = 0;
    const outcome = await r.runner.run();
    expect(r.asked).toEqual([EMPTIED]);
    expect(outcome).toMatchObject({ kind: "published" });
    expect(outcome.kind === "published" && outcome.result.removed).toBe(2);
  });

  it("a manual publish that is declined writes nothing and says the removal was not confirmed", async () => {
    const r = await emptiedVault(async () => false);
    r.asked.length = 0;
    const outcome = await r.runner.run();
    expect(r.asked).toEqual([EMPTIED]);
    expect(outcome).toMatchObject({ kind: "refused", reason: "mass-removal" });
    expect(outcome.notice).toContain("2 of 2");
    expect(outcome.notice).toMatch(/not confirmed|Nothing was written/);
    expect(writes(r.node)).toEqual([]);
    expect(r.runner.isRunning()).toBe(false);
  });

  it("the timer path never asks: it refuses with the timer notice and writes nothing", async () => {
    const answer = vi.fn(async () => true);
    const r = await emptiedVault(answer);
    answer.mockClear();
    r.asked.length = 0;
    const outcome = await r.runner.run({ unattended: true });
    expect(answer).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "refused", reason: "mass-removal" });
    expect(outcome.notice).toBe(`IPFS Sync: ${massRemovalTimerNotice(EMPTIED)}`);
    expect(writes(r.node)).toEqual([]);
  });

  it("a manual publish with no port wired refuses like the timer and writes nothing", async () => {
    const r = await emptiedVault(undefined);
    const outcome = await r.runner.run();
    expect(outcome).toMatchObject({ kind: "refused", reason: "mass-removal" });
    expect(writes(r.node)).toEqual([]);
  });

  it("an ordinary publish is not asked", async () => {
    const r = await emptiedVault(async () => true);
    r.adapter.put("notes/hello.md", "hello again", 2000);
    r.adapter.put("notes/world.md", "world", 1000);
    r.asked.length = 0;
    const outcome = await r.runner.run();
    expect(r.asked).toEqual([]);
    expect(outcome.kind).toBe("published");
  });
});
