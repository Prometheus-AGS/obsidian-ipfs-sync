import { classifyKey, ConfigError, describeAuth, displayAddress, type KeyState, type SyncConfig } from "../core/config";
import { createKuboClient, KuboError, type KuboClient, type Transport } from "../kubo";
import { readRootState } from "../sync/root-state";
import { pluginTransport } from "./request-url-transport";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import type { SettingsStore } from "./settings-store";
import { settingsToConfig } from "./settings-to-config";

export interface StatusReport {
  readonly rpc: string;
  readonly gateway: string;
  readonly auth: string;
  readonly mfsRoot: string;
  readonly key: string;
  /** `unknown` when the settings are invalid or the node cannot be asked. */
  readonly keyState: KeyState | "unknown";
  readonly keyDetail: string;
  readonly lastRootCid?: string;
  readonly lastPublishedAt?: string;
  /** Problems that stopped the report from being complete, and non-fatal warnings such as an expired JWT. */
  readonly notes: readonly string[];
}

export interface StatusDeps {
  readonly store: SettingsStore;
  readonly adapter: VaultAdapter;
  readonly transport?: Transport;
  /** Tests swap the node client. */
  readonly createClient?: (config: SyncConfig) => Pick<KuboClient, "keyList">;
  readonly now?: () => Date;
}

async function lastPublished(deps: StatusDeps, config: SyncConfig): Promise<Pick<StatusReport, "lastRootCid" | "lastPublishedAt">> {
  const host = createObsidianHostBridge({ adapter: deps.adapter });
  // The record is kept per MFS root; an unreadable one reads as "nothing published yet" here (publish names the fix).
  const state = await readRootState(host.kv, config.mfsRoot).catch(() => undefined);
  // The record describes one publication; another key is a different one.
  if (state === undefined || state.key !== config.publicationKey || state.rootCid === null) return {};
  return { lastRootCid: state.rootCid, lastPublishedAt: state.manifest.publishedAt };
}

async function keyStatus(config: SyncConfig, client: Pick<KuboClient, "keyList">): Promise<Pick<StatusReport, "keyState" | "keyDetail">> {
  const nodeKeys = (await client.keyList()).map((key) => ({ name: key.name, id: key.id === "" ? undefined : key.id }));
  const found = classifyKey(config.publicationKey, nodeKeys, config.ownedKeys);
  return { keyState: found.state, keyDetail: found.reason };
}

function unknownKey(reason: string): Pick<StatusReport, "keyState" | "keyDetail"> {
  return { keyState: "unknown", keyDetail: reason };
}

/** Everything the Status command shows. The node is asked for the key list only; nothing is written. */
export async function collectStatus(deps: StatusDeps): Promise<StatusReport> {
  const settings = deps.store.get();
  const now = deps.now?.() ?? new Date();
  let config: SyncConfig;
  try {
    config = settingsToConfig(settings, now);
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : "the settings could not be checked";
    return {
      // The stored text may hold credentials or be malformed: show only a redacted form.
      rpc: displayAddress(settings.rpc.url),
      gateway: displayAddress(settings.gateway.url),
      auth: settings.auth.scheme,
      mfsRoot: settings.mfsRoot,
      key: settings.publicationKey,
      ...unknownKey("settings are invalid"),
      notes: [reason],
    };
  }
  const client = deps.createClient?.(config) ?? createKuboClient({ rpc: config.rpc, gateway: config.gateway, transport: deps.transport ?? pluginTransport() });
  let key = unknownKey("not checked");
  const notes = [...config.warnings];
  try {
    key = await keyStatus(config, client);
  } catch (error) {
    if (!(error instanceof KuboError)) throw error;
    key = unknownKey("the node could not be asked");
    notes.push(error.message);
  }
  return {
    rpc: config.rpc.baseUrl,
    gateway: config.gateway.baseUrl,
    auth: describeAuth(config.rpc.auth),
    mfsRoot: config.mfsRoot,
    key: config.publicationKey,
    ...key,
    ...(await lastPublished(deps, config)),
    notes,
  };
}

export function formatStatus(report: StatusReport): string {
  const lines = [
    `RPC: ${report.rpc}`,
    `Gateway: ${report.gateway}`,
    `Auth: ${report.auth}`,
    `MFS root: ${report.mfsRoot}`,
    `Key: ${report.key} (${report.keyState}: ${report.keyDetail})`,
    `Last published: ${report.lastPublishedAt ?? "never"}`,
    `  root: ${report.lastRootCid ?? "none"}`,
    ...report.notes.map((note) => `Note: ${note}`),
  ];
  return lines.join("\n");
}
