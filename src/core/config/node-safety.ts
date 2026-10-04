import { MFS_BASE } from "./defaults";
import { ConfigError } from "./errors";

/**
 * Rules that keep this project inside its own namespace on the shared kubo node.
 * Every function is pure and fails closed.
 */

// ---------- MFS confinement ----------

// Matches ASCII control characters, backslash and percent.
const FORBIDDEN_PATH_CHARS = /[\u0000-\u001f\u007f\\%]/;

/**
 * Normalise an absolute MFS path (no trailing slash), or undefined. Rejects relative
 * paths, `.`/`..` segments, empty segments, backslashes, control characters and
 * percent-escapes (a proxy may decode them into traversal).
 */
function normalizePath(path: string): string | undefined {
  if (!path.startsWith("/") || FORBIDDEN_PATH_CHARS.test(path)) return undefined;
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = trimmed.split("/").slice(1);
  const bad = segments.some((s) => s === "" || s === "." || s === "..");
  return bad ? undefined : trimmed;
}

function isUnderBase(normalized: string): boolean {
  return normalized.startsWith(`${MFS_BASE}/`);
}

/** The MFS root must equal `/obsidian-vault-sync` or sit under it. Returns the normalised root. */
export function validateMfsRoot(mfsRoot: string): string {
  const normalized = normalizePath(mfsRoot);
  if (normalized === undefined || (normalized !== MFS_BASE && !isUnderBase(normalized))) {
    throw new ConfigError(
      "unsafe-mfs-root",
      `mfs root "${mfsRoot}" is outside ${MFS_BASE}; refusing to touch anything else on the shared node`,
    );
  }
  return normalized;
}

/**
 * Guard for every MFS mutation (write, rm, ...): the path must sit strictly
 * under `/obsidian-vault-sync/`. Returns the normalised path.
 */
export function assertMfsMutationPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === undefined || !isUnderBase(normalized)) {
    throw new ConfigError("unsafe-mfs-path", `refusing to modify "${path}": mutations are confined to ${MFS_BASE}/`);
  }
  return normalized;
}

// ---------- Publication key ownership ----------

export const KEY_NAME_PATTERN = /^obsidian-vault(-[a-z0-9-]+)?$/;

/** Keys that already exist on the shared node and belong to other projects. */
export const RESERVED_KEY_NAMES: readonly string[] = ["consult-capture", "gomark-relay-lab", "prince-live", "self"];

export function isValidKeyName(name: string): boolean {
  return KEY_NAME_PATTERN.test(name) && !RESERVED_KEY_NAMES.includes(name);
}

export function assertValidKeyName(name: string): string {
  if (isValidKeyName(name)) return name;
  const reserved = RESERVED_KEY_NAMES.includes(name) ? " (it belongs to another project on the node)" : "";
  throw new ConfigError(
    "invalid-key-name",
    `publication key "${name}" is refused${reserved}; names must match ${KEY_NAME_PATTERN.source}`,
  );
}

export type KeyState = "absent" | "owned" | "foreign";

export interface NodeKeyRef {
  readonly name: string;
  /** May be missing when the proxy strips key IDs from `key/list`. */
  readonly id?: string;
}

export interface KeyClassification {
  readonly state: KeyState;
  readonly id?: string;
  readonly reason: string;
}

/**
 * Classify the configured key against the node's key list.
 * `owned` needs the node key's ID to be in the recorded set. A name match with
 * another ID, an unrecorded ID, or no ID at all is `foreign`.
 */
export function classifyKey(
  name: string,
  nodeKeys: readonly NodeKeyRef[],
  ownedIds: readonly string[],
): KeyClassification {
  const match = nodeKeys.find((key) => key.name === name);
  if (match === undefined) return { state: "absent", reason: "no key with this name on the node" };
  if (match.id === undefined || match.id === "") {
    return { state: "foreign", reason: "node did not return the key ID, ownership cannot be verified" };
  }
  if (ownedIds.includes(match.id)) return { state: "owned", id: match.id, reason: "key ID is recorded as owned" };
  return { state: "foreign", id: match.id, reason: "key ID is not in the recorded owned set" };
}

/** Name publishing is allowed only for an owned key. */
export function assertKeyOwnedForPublish(name: string, classification: KeyClassification): void {
  if (classification.state === "owned") return;
  throw new ConfigError(
    "foreign-key",
    `publication key "${name}" is ${classification.state} (${classification.reason}); name publishing is refused`,
  );
}
