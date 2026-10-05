import { DEFAULT_PUBLICATION_KEY, isRetiredDefaultHost, isValidKeyName, RESERVED_KEY_NAMES } from "../core/config";
import { DEFAULT_EXCLUSIONS } from "../sync/exclusions";
import { defaultSettings, PREVIOUS_SETTINGS_VERSION, SETTINGS_VERSION, type PluginSettings } from "./settings-model";
import { parseStoredSettings } from "./settings-parse";

/**
 * Loading the stored plugin data. Migration is a pure mapping of the previous plugin's
 * `{rpcUrl, keyName, authToken, excludedPaths, publishIntervalMinutes}`: no network access, no key
 * adoption (`ownedKeys` stays empty, so a key that already exists on the node stays foreign).
 */

/** The previous plugin's default key name; it maps to the new project key rather than being adopted. */
export const LEGACY_DEFAULT_KEY = "obsidian-vault";

/** `upgraded`: the previous version's data, loaded with defaults for the new fields and not rewritten until the next change. */
export type LoadOutcome = "fresh" | "current" | "upgraded" | "migrated" | "unreadable";

export interface LoadResult {
  readonly settings: PluginSettings;
  readonly outcome: LoadOutcome;
  /** Messages to show the user once (never contain secrets). */
  readonly notices: readonly string[];
  /** True when the result should be written back now. False for unreadable data, which stays untouched until the user saves. */
  readonly persist: boolean;
}

type Stored = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Stored {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(stored: Stored, key: string): string | undefined {
  const value = stored[key];
  return typeof value === "string" ? value : undefined;
}

const KEY_NOTICE_LIMIT = 64;

/** The key name to use and, when the old one was not acceptable, the notice that says why. */
function mapKeyName(legacy: string | undefined): { readonly key: string; readonly notice?: string } {
  if (legacy === undefined || legacy === LEGACY_DEFAULT_KEY) return { key: DEFAULT_PUBLICATION_KEY };
  if (isValidKeyName(legacy)) return { key: legacy };
  const shown = legacy.slice(0, KEY_NOTICE_LIMIT);
  const reason = RESERVED_KEY_NAMES.includes(legacy)
    ? "it belongs to another project on the node"
    : "publication keys must be named obsidian-vault or obsidian-vault-<suffix>";
  return {
    key: DEFAULT_PUBLICATION_KEY,
    notice: `IPFS Sync: the previous key name "${shown}" is not allowed (${reason}). Using "${DEFAULT_PUBLICATION_KEY}" instead; you can change it in the settings.`,
  };
}

function normalizeEntry(entry: string): string {
  return entry.trim().replaceAll("\\", "/");
}

/** The whole configuration folder is a default exclusion now (mvp-07a 1.3); the old build listed six `.obsidian/…` defaults, which would otherwise read as the user's own lines. */
const CONFIG_FOLDER_PREFIX = ".obsidian/";

/** Lines of the old exclusion text that are not already default exclusions and not under the configuration folder, in order, without duplicates. */
function userExclusionsFrom(excludedPaths: string | undefined): readonly string[] {
  if (excludedPaths === undefined) return [];
  const defaults = new Set(DEFAULT_EXCLUSIONS);
  const lines = excludedPaths.split("\n").map(normalizeEntry).filter((line) => line !== "" && !defaults.has(line) && !line.startsWith(CONFIG_FOLDER_PREFIX));
  return [...new Set(lines)];
}

function intervalFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Shown once, in place of carrying the retired built-in node into the new settings (the notice never names the host). */
const RETIRED_NODE_REMOVED_NOTICE =
  "IPFS Sync: the built-in node of version 0.2.0 was removed, and your saved settings pointed at it, so the node URLs are now empty. Open the settings and set your own IPFS node.";

function migrateLegacy(stored: Stored): LoadResult {
  const base = defaultSettings();
  const oldUrl = text(stored, "rpcUrl")?.trim().replace(/\/+$/, "");
  const retired = oldUrl !== undefined && isRetiredDefaultHost(oldUrl);
  const url = oldUrl === undefined || oldUrl === "" || retired ? base.rpc.url : oldUrl;
  const token = text(stored, "authToken")?.trim() ?? "";
  const { key, notice } = mapKeyName(text(stored, "keyName")?.trim());
  const settings: PluginSettings = {
    ...base,
    rpc: { url },
    // The old plugin read through RPC, and the shipped defaults use one host for both.
    gateway: { url },
    publicationKey: key,
    auth: token === "" ? { scheme: "none" } : { scheme: "bearer", token },
    userExclusions: userExclusionsFrom(text(stored, "excludedPaths")),
    publishIntervalMinutes: intervalFrom(stored["publishIntervalMinutes"]),
  };
  const notices = [...(notice === undefined ? [] : [notice]), ...(retired ? [RETIRED_NODE_REMOVED_NOTICE] : [])];
  return { settings, outcome: "migrated", notices, persist: true };
}

const UNREADABLE_NOTICE =
  "IPFS Sync: the stored settings could not be read, so defaults are in use. The stored data is left untouched until you change a setting.";

function unreadable(): LoadResult {
  return { settings: defaultSettings(), outcome: "unreadable", notices: [UNREADABLE_NOTICE], persist: false };
}

/**
 * Interpret whatever `loadData()` returned. `null` (no file yet) gives defaults. An object with the
 * version marker is the current form (or the version before it, which loads with defaults for the new fields
 * and is written in the new form on the next settings change); an object without one is the previous
 * plugin's form. Anything else, or a marker this build does not know, gives defaults and leaves the stored
 * data alone.
 */
export function loadSettings(stored: unknown): LoadResult {
  if (stored === null || stored === undefined) {
    return { settings: defaultSettings(), outcome: "fresh", notices: [], persist: false };
  }
  if (!isObject(stored)) return unreadable();
  if (!("version" in stored)) return migrateLegacy(stored);
  const version = stored["version"];
  if (version !== SETTINGS_VERSION && version !== PREVIOUS_SETTINGS_VERSION) return unreadable();
  const parsed = parseStoredSettings(stored);
  if (parsed === undefined) return unreadable();
  return { settings: parsed, outcome: version === SETTINGS_VERSION ? "current" : "upgraded", notices: [], persist: false };
}
