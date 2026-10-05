import { DEFAULT_PUBLICATION_KEY, hasUserinfo, isRetiredDefaultHost, isValidKeyName, RESERVED_KEY_NAMES } from "../core/config";
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
  "IPFS Sync: the built-in node of version 0.2.0 was removed, and your saved settings pointed at it, so the node URLs are now empty. Credentials saved for it were removed too; enter them again for your own node. Open the settings and set your own IPFS node.";

/** A stored endpoint URL (RPC or gateway) names the retired host. */
function namesRetiredHost(settings: PluginSettings): boolean {
  return isRetiredDefaultHost(settings.rpc.url) || isRetiredDefaultHost(settings.gateway.url);
}

/**
 * Stored data of a known version that still names the retired built-in node: both URLs are emptied and the auth tied to
 * that endpoint is dropped, so neither the URL nor a credential written for it is kept. Written back now.
 */
function clearRetiredNode(settings: PluginSettings, outcome: LoadOutcome): LoadResult {
  const { gatewayAuth: _dropped, ...rest } = settings;
  const cleared: PluginSettings = { ...rest, rpc: { url: "" }, gateway: { url: "" }, auth: { scheme: "none" } };
  return { settings: cleared, outcome, notices: [RETIRED_NODE_REMOVED_NOTICE], persist: true };
}

/** Shown once when the previous plugin's saved address held a user name or password; neither the address nor the credential is kept. */
const LEGACY_CREDENTIALS_NOTICE =
  "IPFS Sync: the address saved by the previous version contained a user name or password, which is not allowed in an address, so the node URLs are now empty. Open the settings, set the address again, and enter the credentials in the authentication fields. Credentials saved with it were removed too; enter them again.";

/** The keys the previous plugin saved (the last two only in its oldest form). */
const LEGACY_KEYS: readonly string[] = ["rpcUrl", "keyName", "authToken", "excludedPaths", "publishIntervalMinutes", "lastPublishedRoot", "lastPublishedAt"];

/**
 * Keys of the current form. `publishIntervalMinutes` is in both forms, so it does not tell them apart; the rest do. The optional
 * keys are listed by hand because the defaults omit them.
 */
const CURRENT_FORM_KEYS: readonly string[] = [
  ...Object.keys(defaultSettings()).filter((key) => key !== "publishIntervalMinutes"),
  "gatewayAuth",
  "retiredDefaultNoticeShown",
  "lastPull",
  "lastPublish",
];

/**
 * An object without a version marker is the previous plugin's data only if it is empty, or has one of that plugin's keys and
 * none of the current form's. A current-form file that lost its marker would otherwise be overwritten with defaults, wiping the
 * owned keys, the gateway credential and the device store (which holds the anti-rollback floor).
 */
function isLegacyForm(stored: Stored): boolean {
  const keys = Object.keys(stored);
  if (keys.length === 0) return true;
  return keys.some((key) => LEGACY_KEYS.includes(key)) && !keys.some((key) => CURRENT_FORM_KEYS.includes(key));
}

function migrateLegacy(stored: Stored): LoadResult {
  const base = defaultSettings();
  const oldUrl = text(stored, "rpcUrl")?.trim().replace(/\/+$/, "");
  const retired = oldUrl !== undefined && isRetiredDefaultHost(oldUrl);
  const credentialed = oldUrl !== undefined && !retired && hasUserinfo(oldUrl);
  const carried = oldUrl !== undefined && oldUrl !== "" && !retired && !credentialed;
  const url = carried ? oldUrl : base.rpc.url;
  // A token is kept only with the address it was written for. With no address carried over (absent, empty, retired or credentialed)
  // it would go to whatever node is set next, so it is never persisted.
  const token = carried ? (text(stored, "authToken")?.trim() ?? "") : "";
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
  const notices = [
    ...(notice === undefined ? [] : [notice]),
    ...(retired ? [RETIRED_NODE_REMOVED_NOTICE] : []),
    ...(credentialed ? [LEGACY_CREDENTIALS_NOTICE] : []),
  ];
  return { settings, outcome: "migrated", notices, persist: true };
}

const UNREADABLE_NOTICE =
  "IPFS Sync: the stored settings could not be read, so defaults are in use. The stored data is left untouched until you change a setting. " +
  "Changing a setting saves the defaults over that file, which holds your credentials, your owned keys and the sequence floor record. " +
  "Before that happens a copy of the file is saved in the plugin folder as data.json.unreadable-followed by the UTC date and time. " +
  "The copy is plain text and holds the same secrets as the original, so delete it when you no longer need it.";

function unreadable(): LoadResult {
  return { settings: defaultSettings(), outcome: "unreadable", notices: [UNREADABLE_NOTICE], persist: false };
}

/**
 * Interpret whatever `loadData()` returned. `null` (no file yet) gives defaults. An object with the
 * version marker is the current form (or the version before it, which loads with defaults for the new fields
 * and is written in the new form on the next settings change); an object without one is the previous
 * plugin's form when it has one of that plugin's keys (or is empty). Anything else, or a marker this build does not
 * know, gives defaults and leaves the stored data alone.
 */
export function loadSettings(stored: unknown): LoadResult {
  if (stored === null || stored === undefined) {
    return { settings: defaultSettings(), outcome: "fresh", notices: [], persist: false };
  }
  if (!isObject(stored)) return unreadable();
  if (!("version" in stored)) return isLegacyForm(stored) ? migrateLegacy(stored) : unreadable();
  const version = stored["version"];
  if (version !== SETTINGS_VERSION && version !== PREVIOUS_SETTINGS_VERSION) return unreadable();
  const parsed = parseStoredSettings(stored);
  if (parsed === undefined) return unreadable();
  const outcome = version === SETTINGS_VERSION ? "current" : "upgraded";
  if (namesRetiredHost(parsed)) return clearRetiredNode(parsed, outcome);
  return { settings: parsed, outcome, notices: [], persist: false };
}
