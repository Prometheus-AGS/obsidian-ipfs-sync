import type { Bytes, HostBridge, HostKv, HostNet } from "../core/host-bridge";
import { HostDeniedError, HostNotImplementedError } from "../sync/host-errors";
import { fetchTransport, type Transport } from "../kubo";
import { createObsidianFs, type VaultAdapter } from "./obsidian-fs";
import { createFolderKv } from "./obsidian-kv";

export interface ObsidianHostOptions {
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  /**
   * Key-value capability. Defaults to files under `<vault>/.ipfs-sync/`, the layout the CLI uses, which is
   * what lets both hosts share the engine's last-published record. `createPluginDataKv` (obsidian-kv.ts)
   * provides the alternative over the plugin's stored data.
   */
  readonly kv?: HostKv;
  /** Variables `envRead` reports, such as the device name the manifest carries. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the platform `fetch`; the plugin passes its `requestUrl` transport. */
  readonly transport?: Transport;
  readonly now?: () => number;
  /** Largest file a read may load, in megabytes (default 64). Read from the settings when each operation starts. */
  readonly maxReadMb?: number;
}

/** `net.fetch` calls the transport directly: it does not go through `requestEndpoint`, so it does not enforce the redirect refusal. */
function createNet(transport: Transport): HostNet {
  return {
    fetch: async (request) => {
      const signal = request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs);
      const body = request.body === undefined ? undefined : new Blob([request.body]);
      const response = await transport(request.url, { method: request.method ?? "GET", headers: request.headers, body, signal });
      const bytes: Bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: bytes };
    },
  };
}

/**
 * The Obsidian host: `fs_*` over the vault adapter, `kv_*` (vault folder by default), `net_*` over the transport,
 * `time_now` and `env_read`. Agents raise a typed not-implemented error and shell execution is denied.
 * Imports Obsidian types only through the structural `VaultAdapter`; nothing here needs Node.
 */
export function createObsidianHostBridge(options: ObsidianHostOptions): HostBridge {
  const { adapter, env = {}, transport = fetchTransport, now = Date.now } = options;
  const fs = createObsidianFs(adapter, { maxReadMb: options.maxReadMb });
  return {
    fs,
    kv: options.kv ?? createFolderKv(fs),
    net: createNet(transport),
    agent: {
      list: () => Promise.reject(new HostNotImplementedError("agent_list")),
      invoke: () => Promise.reject(new HostNotImplementedError("agent_invoke")),
    },
    timeNow: () => now(),
    envRead: (name) => env[name],
    shellExec: () => Promise.reject(new HostDeniedError("shell_exec")),
  };
}
