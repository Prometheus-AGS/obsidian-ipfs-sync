import { describe, expect, it } from "vitest";
import { requestUrlTransport } from "../../src/plugin/request-url-transport";
import { createSessionKeys, type DialogCallbacks, type UnlockingEvent } from "../../src/plugin/session-keys";
import { loadSettings } from "../../src/plugin/settings-migration";
import { testNodeSettings } from "../helpers/test-node-settings";
import { createSettingsStore } from "../../src/plugin/settings-store";
import { createVaultOpener, createVaultProbe } from "../../src/plugin/vault-opener";
import type { PublishClient } from "../../src/sync/publish";
import { keySlotsCopyPath } from "../../src/sync/vault-keys";
import { createFakeNode } from "../helpers/fake-kubo";
import { MemoryAdapter } from "../support/memory-adapter";
import { FLOOR_PARAMS } from "../vectors/slot-helpers";

/** review-5 R5-03: the setup guard is the one `ipfs-sync init` applies: an empty root only, checked again before the write. */

const MFS_ROOT = "/obsidian-vault-sync/mvp06-opener";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;

function setupRig(onEvent?: (event: UnlockingEvent) => void) {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  const node = createFakeNode();
  const store = createSettingsStore({ loadData: async () => null, saveData: async () => undefined }, { ...loadSettings(null), settings: { ...testNodeSettings(), mfsRoot: MFS_ROOT } });
  const now = (): Date => new Date(1_800_000_000_000);
  const dialogs: DialogCallbacks = {
    unlock: async () => undefined,
    setup: async (request) => ({ confirmed: true, reentered: request.passphrase }),
    unlocking: (event) => onEvent?.(event),
  };
  const session = createSessionKeys({
    dialogs,
    open: createVaultOpener({ store, adapter, transport: requestUrlTransport, now, createClient: (): PublishClient => node.client, createParams: FLOOR_PARAMS }),
    vaultExists: createVaultProbe({ store, adapter, now }),
  });
  return { adapter, node, session };
}

describe("R5-03: plugin setup creates a vault only in an empty root", () => {
  it("refuses a root that holds any entry at all, even one that is not a vault file, and writes nothing", async () => {
    const r = setupRig();
    r.node.files.set(`${MFS_ROOT}/notes.txt`, new TextEncoder().encode("someone else's data"));
    await expect(r.session.setup()).rejects.toThrow(/not empty/);
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(r.adapter.files.has(await keySlotsCopyPath(MFS_ROOT))).toBe(false);
  }, 30_000);

  it("still refuses a root that holds key slots or a manifest, with the vault wording", async () => {
    const r = setupRig();
    r.node.files.set(`${MFS_ROOT}/keyslots.json`, new TextEncoder().encode("{}"));
    await expect(r.session.setup()).rejects.toThrow(/already holds a vault/);
  }, 30_000);

  it("creates the vault in an empty root", async () => {
    const r = setupRig();
    expect((await r.session.setup()).kind).toBe("unlocked");
    expect(r.adapter.files.has(await keySlotsCopyPath(MFS_ROOT))).toBe(true);
  }, 30_000);

  it("looks at the root again after the derivation and before the local copy is written", async () => {
    let planted = false;
    let plant: () => void = () => undefined;
    const r = setupRig((event) => {
      // The derivation reports progress after the first look at the root and before the write.
      if (event.kind === "progress" && !planted) {
        planted = true;
        plant();
      }
    });
    plant = () => r.node.files.set(`${MFS_ROOT}/late.txt`, new TextEncoder().encode("arrived during the derivation"));
    await expect(r.session.setup()).rejects.toThrow(/not empty/);
    expect(planted).toBe(true);
    expect(r.adapter.files.has(await keySlotsCopyPath(MFS_ROOT))).toBe(false);
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  }, 30_000);
});
