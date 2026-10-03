import { createSyncEventBus } from "../../src/core/events";
import type { GatewayRange, GatewayStream } from "../../src/kubo";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { createPublishRunner, type PublishOutcome } from "../../src/plugin/publish-runner";
import { createPullRunner } from "../../src/plugin/pull-runner";
import { createSyncLock } from "../../src/plugin/sync-lock";
import { readRootState } from "../../src/sync/root-state";
import { keyIdOf } from "./encrypted-pull-rig";
import { REFERENCE_TEXT, scriptedDialogs, scriptedPassphrase, type EncryptedPluginRig, type NodeClient } from "./plugin-pull-encrypted-rig";
import { NOW, freshVault, storeWith } from "./plugin-pull-rig";
import { sessionRig } from "./plugin-session";
import { ROOT, type Rig } from "./publish-rig";

/**
 * The plugin's decrypting pull over a gateway that either honours `Range` (206 and a matching `Content-Range`) or ignores it
 * (200 and the whole body), with a log of every gateway read the plugin sent (mvp-07a task 6.1).
 */

/** One run of the plugin's publish runner for this device: the vault is unlocked from the scripted passphrase, the node is the rig's. */
export async function publishFromPlugin(b: EncryptedPluginRig): Promise<PublishOutcome> {
  const client = b.publisher.node.client;
  const session = sessionRig({ store: b.store, adapter: b.adapter, createClient: () => client, typed: [REFERENCE_TEXT] }).session;
  return createPublishRunner({ store: b.store, adapter: b.adapter, bus: createSyncEventBus(), session, createClient: () => client, now: () => NOW }).run();
}

export type RangeMode = "honour" | "ignore";

export interface GatewayRead {
  /** `<tree cid>/<path>` as requested. */
  readonly target: string;
  readonly range: { readonly start: number; readonly length: number } | undefined;
  /** What the gateway answered. */
  readonly status: 200 | 206;
}

export interface RangeLoggingClient {
  readonly client: NodeClient;
  readonly reads: GatewayRead[];
}

export function rangeLoggingClient(client: NodeClient, mode: RangeMode): RangeLoggingClient {
  const reads: GatewayRead[] = [];
  const wrapped: NodeClient = {
    ...client,
    gatewayStream: async (cid, path = "", range?: GatewayRange): Promise<GatewayStream> => {
      const whole = await client.gatewayFetch(cid, path);
      const target = `${cid}${path === "" ? "" : `/${path}`}`;
      const honoured = mode === "honour" && range !== undefined;
      reads.push({ target, range: range === undefined ? undefined : { start: range.start, length: range.length }, status: honoured ? 206 : 200 });
      const body = honoured ? whole.slice(range.start, range.start + range.length) : whole;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        yield body;
      }
      return honoured
        ? { status: 206, contentRange: `bytes ${range.start}-${range.start + body.length - 1}/${whole.length}`, chunks: chunks() }
        : { status: 200, contentRange: undefined, chunks: chunks() };
    },
  };
  return { client: wrapped, reads };
}

export interface PluginDevice {
  readonly adapter?: EncryptedPluginRig["adapter"];
  readonly store?: EncryptedPluginRig["store"];
}

/** A plugin pull runner over a fresh memory vault (or the given plugin data and vault), pulling `publisher`'s node through `client`. */
export function pluginThrough(publisher: Rig, client: NodeClient, device: PluginDevice = {}): EncryptedPluginRig {
  const adapter = device.adapter ?? freshVault();
  const store = device.store ?? storeWith({ mfsRoot: ROOT, ownedKeys: [keyIdOf(publisher.node)] });
  const bus = createSyncEventBus();
  const lock = createSyncLock();
  const passphrase = scriptedPassphrase();
  const dialogs = scriptedDialogs();
  let counter = 0;
  const runner = createPullRunner({ store, adapter, bus, lock, createClient: () => client, now: () => NOW, newId: () => `part${(counter += 1)}`, passphrase, dialogs });
  const host = (): ReturnType<typeof createObsidianHostBridge> => createObsidianHostBridge({ adapter });
  return {
    publisher,
    adapter,
    store,
    runner,
    bus,
    lock,
    passphrase,
    dialogs,
    client,
    pull: (runOptions) => runner.run(runOptions),
    state: () => readRootState(host().kv, ROOT),
    texts: () => {
      const texts: Record<string, string> = {};
      for (const path of adapter.files.keys()) {
        if (path.startsWith(".ipfs-sync") || path.startsWith(".obsidian/")) continue;
        texts[path] = adapter.text(path) ?? "";
      }
      return texts;
    },
  };
}
