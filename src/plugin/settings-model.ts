import { DEFAULT_GATEWAY_URL, DEFAULT_MFS_ROOT, DEFAULT_PUBLICATION_KEY, DEFAULT_RPC_URL, type AuthScheme } from "../core/config";
import { DEFAULT_MAX_READ_MB } from "./read-cap";

/** Version marker of the stored plugin data. Data without it is the previous plugin's form. */
export const SETTINGS_VERSION = 3;

/** The form before pull existed (mvp-04). It loads with defaults for the fields added since. */
export const PREVIOUS_SETTINGS_VERSION = 2;

export const AUTH_SCHEMES: readonly AuthScheme[] = ["none", "basic", "bearer", "header"];

export interface EndpointSettings {
  readonly url: string;
  /** Unset when the URL carries the port (or the scheme default applies). */
  readonly port?: number;
}

/** One scheme with its own fields; the scheme applies to both endpoints. Secrets are stored in plain text. */
export type AuthSettings =
  | { readonly scheme: "none" }
  | { readonly scheme: "basic"; readonly user: string; readonly password: string }
  | { readonly scheme: "bearer"; readonly token: string }
  | { readonly scheme: "header"; readonly headerName: string; readonly headerValue: string };

/**
 * What the last pull did. Counts, root CIDs and a timestamp only: no path, no file content, no credential.
 * (Notices may show paths; nothing stored does.)
 */
export interface PullSummary {
  /** ISO 8601 time the pull finished. */
  readonly at: string;
  /** CID of the published root the IPNS name resolved to. */
  readonly rootCid: string;
  /** CID of the vault tree the manifest describes. */
  readonly manifestCid: string;
  /** Files written, including those replaced after a conflict. */
  readonly fetched: number;
  readonly unchanged: number;
  /** Conflict copies created. */
  readonly conflicts: number;
  readonly failed: number;
  readonly remoteDeleted: number;
}

/** What the last publish did; same rule as `PullSummary`. */
export interface PublishSummary {
  readonly at: string;
  readonly written: number;
  readonly removed: number;
  /** Files left out because they exceeded the read cap. */
  readonly skipped: number;
  /** Present when a snapshot was published. */
  readonly rootCid?: string;
}

/**
 * The plugin's stored data, `data.json` in the plugin folder. That file sits inside the vault, so the
 * default exclusions list it: it holds secrets and must never be published.
 */
export interface PluginSettings {
  readonly version: typeof SETTINGS_VERSION;
  readonly rpc: EndpointSettings;
  readonly gateway: EndpointSettings;
  readonly publicationKey: string;
  readonly mfsRoot: string;
  readonly auth: AuthSettings;
  /** Additions to the default exclusions (the defaults themselves are not stored). */
  readonly userExclusions: readonly string[];
  /** IDs of IPNS keys this plugin created or the operator adopted. Never filled by migration. */
  readonly ownedKeys: readonly string[];
  /** 0 disables auto-publish. */
  readonly publishIntervalMinutes: number;
  /** IPNS name to pull from. Empty means the ID of the owned publication key. */
  readonly pullName: string;
  /** Pull once after the workspace is ready. A per-device setting; off by default. */
  readonly catchUpOnLoad: boolean;
  /** Largest file the plugin loads into memory, in megabytes (8 to 1024). */
  readonly maxReadMb: number;
  readonly lastPull?: PullSummary;
  readonly lastPublish?: PublishSummary;
  /** Values of the key-value capability, base64. Kept in the same file as the settings. */
  readonly kv: Readonly<Record<string, string>>;
}

export function defaultSettings(): PluginSettings {
  return {
    version: SETTINGS_VERSION,
    rpc: { url: DEFAULT_RPC_URL },
    gateway: { url: DEFAULT_GATEWAY_URL },
    publicationKey: DEFAULT_PUBLICATION_KEY,
    mfsRoot: DEFAULT_MFS_ROOT,
    auth: { scheme: "none" },
    userExclusions: [],
    ownedKeys: [],
    publishIntervalMinutes: 0,
    pullName: "",
    catchUpOnLoad: false,
    maxReadMb: DEFAULT_MAX_READ_MB,
    kv: {},
  };
}

/** Auth fields of a scheme, all empty: the starting point when the operator switches scheme. */
export function emptyAuth(scheme: AuthScheme): AuthSettings {
  switch (scheme) {
    case "none":
      return { scheme };
    case "basic":
      return { scheme, user: "", password: "" };
    case "bearer":
      return { scheme, token: "" };
    case "header":
      return { scheme, headerName: "", headerValue: "" };
  }
}
