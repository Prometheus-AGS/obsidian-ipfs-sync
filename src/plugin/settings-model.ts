import { DEFAULT_MFS_ROOT, DEFAULT_PUBLICATION_KEY, type AuthScheme } from "../core/config";
import { PULL_CONFIRM_ABOVE_DEFAULT } from "../sync/pull-budget";
import { DEFAULT_MAX_READ_MB } from "./read-cap";

/** Version marker of the stored plugin data. Data without it is the previous plugin's form. */
export const SETTINGS_VERSION = 3;

/** The form before pull existed (mvp-04). It loads with defaults for the fields added since. */
export const PREVIOUS_SETTINGS_VERSION = 2;

export const AUTH_SCHEMES: readonly AuthScheme[] = ["none", "basic", "bearer", "header"];

/** The pull ceiling: a pull that would fetch more than this many megabytes asks for confirmation first (mvp-07a design 14). The default is the pull's own ceiling, 512 MiB. */
export const DEFAULT_PULL_CONFIRM_ABOVE_MB = PULL_CONFIRM_ABOVE_DEFAULT / (1024 * 1024);
export const MIN_PULL_CONFIRM_ABOVE_MB = 64;
export const MAX_PULL_CONFIRM_ABOVE_MB = 8192;

export function isValidPullConfirmAboveMb(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PULL_CONFIRM_ABOVE_MB && value <= MAX_PULL_CONFIRM_ABOVE_MB;
}

export const PULL_CONFIRM_RANGE_MESSAGE = `the pull ceiling must be a whole number of megabytes from ${MIN_PULL_CONFIRM_ABOVE_MB} to ${MAX_PULL_CONFIRM_ABOVE_MB}`;

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
  /** A pull that fetches more than this many megabytes asks first (64 to 8192, default 512). Older stored data loads with the default. */
  readonly pullConfirmAboveMb: number;
  /** Set once the one-time "this node is the maintainer's own and is open to anyone" notice was shown. Absent means not shown yet. */
  readonly retiredDefaultNoticeShown?: boolean;
  readonly lastPull?: PullSummary;
  readonly lastPublish?: PublishSummary;
  /** Values of the key-value capability, base64. Kept in the same file as the settings. */
  readonly kv: Readonly<Record<string, string>>;
  /**
   * The device-local store (`src/plugin/device-store-plugin.ts`): entry name to base64 bytes. Holds the device id and the
   * sequence floor. Only the settings store writes it, and it keeps every floor at its maximum on every save.
   */
  readonly deviceStore: Readonly<Record<string, string>>;
}

export function defaultSettings(): PluginSettings {
  return {
    version: SETTINGS_VERSION,
    // No node is a default: an empty URL means "not configured", and every action refuses until the operator sets one.
    rpc: { url: "" },
    gateway: { url: "" },
    publicationKey: DEFAULT_PUBLICATION_KEY,
    mfsRoot: DEFAULT_MFS_ROOT,
    auth: { scheme: "none" },
    userExclusions: [],
    ownedKeys: [],
    publishIntervalMinutes: 0,
    pullName: "",
    catchUpOnLoad: false,
    maxReadMb: DEFAULT_MAX_READ_MB,
    pullConfirmAboveMb: DEFAULT_PULL_CONFIRM_ABOVE_MB,
    kv: {},
    deviceStore: {},
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
