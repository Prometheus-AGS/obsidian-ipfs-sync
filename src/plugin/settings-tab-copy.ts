import { DEFAULT_MFS_ROOT, DEFAULT_PUBLICATION_KEY, type AuthScheme } from "../core/config";
import { DEFAULT_MAX_READ_MB, MAX_MAX_READ_MB, MIN_MAX_READ_MB } from "./read-cap";
import type { EditableFieldId } from "./settings-fields";
import { DEFAULT_PULL_CONFIRM_ABOVE_MB, MAX_PULL_CONFIRM_ABOVE_MB, MIN_PULL_CONFIRM_ABOVE_MB } from "./settings-model";

/**
 * Every visible word of the settings tab that is not produced by the view model. Direct statements, no
 * marketing language. Kept apart from the rendering so copy changes touch no layout code.
 */

export interface FieldCopy {
  readonly name: string;
  readonly desc: string;
  readonly placeholder?: string;
  /** Show a numeric keypad on touch devices. The value is still text, so errors can be shown for it. */
  readonly numeric?: boolean;
  /** Long values (URLs, paths): the input gets its own full-width line under the label. */
  readonly wide?: boolean;
}

export const FIELD_COPY: Readonly<Record<EditableFieldId, FieldCopy>> = {
  rpcUrl: {
    name: "RPC URL",
    desc: "The kubo RPC endpoint the plugin publishes through.",
    placeholder: "https://ipfs.example.org",
    wide: true,
  },
  rpcPort: {
    name: "RPC port",
    desc: "Optional. Empty means the port in the URL, or the scheme default. The grey text in the box is a hint, not a value.",
    placeholder: "optional",
    numeric: true,
  },
  gatewayUrl: {
    name: "Gateway URL",
    desc: "The kubo gateway endpoint. It can differ from the RPC endpoint in host, port and scheme.",
    placeholder: "https://gateway.example.org",
    wide: true,
  },
  gatewayPort: {
    name: "Gateway port",
    desc: "Optional. Empty means the port in the URL, or the scheme default. The grey text in the box is a hint, not a value.",
    placeholder: "optional",
    numeric: true,
  },
  publicationKey: {
    name: "Publication key name",
    desc: `The IPNS key the vault pointer is published under. Default: ${DEFAULT_PUBLICATION_KEY}.`,
    wide: true,
  },
  mfsRoot: {
    name: "MFS root",
    desc: `The directory on the node that holds this vault. It must sit under /obsidian-vault-sync. Default: ${DEFAULT_MFS_ROOT}.`,
    wide: true,
  },
  publishIntervalMinutes: {
    name: "Auto-publish interval (minutes)",
    desc: "How often the plugin publishes on its own. 0 turns automatic publishing off.",
    placeholder: "0",
    numeric: true,
  },
  pullName: {
    name: "Pull IPNS name",
    desc:
      "The IPNS name this device pulls from: a key ID, optionally starting with /ipns/. " +
      "Leave it empty to pull from the ID of your own publication key. " +
      "To pull one explicit root instead, enter /ipfs/ followed by its CID: an advanced input for restoring or checking a version. " +
      "The grey text in the box is a hint, not a value.",
    placeholder: "empty: your publication key",
    wide: true,
  },
  pullConfirmAboveMb: {
    name: "Ask before pulling more than (MB)",
    desc:
      `A pull that would fetch more than this many megabytes asks you first, as a whole number from ${MIN_PULL_CONFIRM_ABOVE_MB} to ${MAX_PULL_CONFIRM_ABOVE_MB}. ` +
      `Default: ${DEFAULT_PULL_CONFIRM_ABOVE_MB}. If you decline, nothing is fetched and those files stay unfinished.`,
    placeholder: String(DEFAULT_PULL_CONFIRM_ABOVE_MB),
    numeric: true,
  },
  catchUpOnLoad: {
    name: "Catch up on load",
    desc:
      "Pull once when this vault opens. Off by default. It is a per-device setting: it is saved on this device only and is not synced.",
  },
  maxReadMb: {
    name: "Read cap (MB)",
    desc:
      `The largest file the plugin reads into memory in one piece, as a whole number of megabytes from ${MIN_MAX_READ_MB} to ${MAX_MAX_READ_MB}. ` +
      `Default: ${DEFAULT_MAX_READ_MB}. A file above the cap is never truncated or deleted: publish skips it and counts it as skipped, ` +
      "pull counts it as failed, and both carry on with the other files.",
    placeholder: String(DEFAULT_MAX_READ_MB),
    numeric: true,
  },
  authScheme: {
    name: "Authentication scheme",
    desc: "Applies to both the RPC and the gateway endpoint.",
  },
  authUser: { name: "User", desc: "The user name for basic authentication." },
  authPassword: { name: "Password", desc: "The password for basic authentication." },
  authToken: { name: "Bearer token", desc: "A static token or a JWT. A JWT that has expired is reported here." },
  authHeaderName: { name: "Header name", desc: "The name of the request header, for example X-Api-Key." },
  authHeaderValue: { name: "Header value", desc: "The value sent in that header." },
};

export const AUTH_SCHEME_LABELS: Readonly<Record<AuthScheme, string>> = {
  none: "None",
  basic: "Basic (user and password)",
  bearer: "Bearer (token or JWT)",
  header: "Custom header",
};

export const FIXTURE_NOTICE_TITLE = "Publishing is encrypted";

export const SECRETS_WARNING_TITLE = "Secrets are stored in plain text";
export const SECRETS_WARNING =
  "The password, token and header value are saved unencrypted in this plugin's data file, " +
  ".obsidian/plugins/ipfs-sync/data.json. That file is excluded from sync, so it is never published. " +
  "Anyone who can read this vault folder on this device can read them.";

export const AUTH_INCOMPLETE = "Not saved yet: fill in every field for this scheme.";

export const SECTIONS = {
  endpoints: "Endpoints",
  publication: "Publication",
  authentication: "Authentication",
  exclusions: "Exclusions",
  keys: "Owned keys",
  pull: "Pull",
  memory: "Memory",
  activity: "Last activity",
} as const;

export const PULL_COPY = {
  targetName: "Name that will be pulled",
  publishName: "Last publish",
  pullName: "Last pull",
} as const;

export const EXCLUSIONS_COPY = {
  hashName: "Exclusions hash",
  hashDesc: "Identifies the effective list below. Devices that publish and pull the same vault need the same hash.",
  defaultsName: "Default exclusions",
  defaultsDesc: "Always applied. These cannot be removed.",
  defaultTag: "default",
  additionsName: "Your additions",
  noAdditions: "No additions.",
  addName: "Add an exclusion",
  addDesc: "A vault-relative path. End it with / to exclude a folder, for example drafts/.",
  addPlaceholder: "drafts/",
  addButton: "Add",
  removeButton: "Remove",
} as const;

export const KEYS_COPY = {
  stateName: "Publication key",
  checking: "Asking the node...",
  refreshButton: "Check again",
  ownedName: "Owned key IDs",
  ownedDesc: "Keys this plugin created or you adopted. The plugin publishes only to keys listed here.",
  noOwned: "None recorded yet.",
  adoptName: "Adopt a key by ID",
  adoptDesc: "Record an existing key on the node as owned by this vault. You confirm the consequences before anything is saved.",
  adoptPlaceholder: "Key ID from the node",
  adoptButton: "Adopt...",
} as const;

/**
 * Clean sentences for the reasons `classifyKey` returns (they are lowercase fragments made for log lines).
 * A reason not listed here is capitalised and ended with a full stop.
 */
const KEY_REASON_SENTENCES: Readonly<Record<string, string>> = {
  "no key with this name on the node": "The node has no key with this name.",
  "node did not return the key ID, ownership cannot be verified": "The node did not return the key ID, so ownership cannot be verified.",
  "key ID is recorded as owned": "The key ID is recorded as owned.",
  "key ID is not in the recorded owned set": "The key ID is not in the recorded owned set.",
};

export function keyReasonSentence(reason: string): string {
  const known = KEY_REASON_SENTENCES[reason];
  if (known !== undefined) return known;
  const text = reason.trim();
  const capitalised = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

export const ADOPT_DIALOG = {
  title: "Adopt this key?",
  intro: "Before you continue:",
  cancel: "Cancel",
  confirm: "Adopt key",
} as const;
