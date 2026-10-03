import { classifyKey, type NodeKeyRef } from "../core/config";
import { isCid, isIpnsName } from "../sync/target-resolution";
import type { PluginSettings } from "./settings-model";

/**
 * Which IPNS name the plugin pulls from: the "pull name" setting, else the ID of the owned publication key.
 * Pure: the node is asked for its key list by the caller.
 */

const IPNS_PREFIX = "/ipns/";
const IPFS_PREFIX = "/ipfs/";

export const PULL_NAME_MESSAGE =
  "the pull name must be a single IPNS key ID (letters and digits, optionally starting with /ipns/), or /ipfs/<cid> with the CID of an explicit root, with no spaces";

export type PullNameParse = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

/**
 * The CID of a stored pull name of the form `/ipfs/<cid>` (an explicit root), or `undefined` for an IPNS name or an empty
 * name. The stored value keeps the prefix, so an explicit root is never mistaken for an IPNS key ID.
 */
export function explicitRootOf(pullName: string): string | undefined {
  if (!pullName.startsWith(IPFS_PREFIX)) return undefined;
  const cid = pullName.slice(IPFS_PREFIX.length);
  return isCid(cid) ? cid : undefined;
}

/**
 * Text from the settings tab to the stored name: empty stays empty, a `/ipns/` prefix is dropped, `/ipfs/<cid>` is kept
 * whole as an explicit root, anything else must be a key ID.
 */
export function parsePullName(text: string): PullNameParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, name: "" };
  if (trimmed.startsWith(IPFS_PREFIX)) return explicitRootOf(trimmed) === undefined ? { ok: false, message: PULL_NAME_MESSAGE } : { ok: true, name: trimmed };
  const name = trimmed.startsWith(IPNS_PREFIX) ? trimmed.slice(IPNS_PREFIX.length) : trimmed;
  return isIpnsName(name) ? { ok: true, name } : { ok: false, message: PULL_NAME_MESSAGE };
}

/** What the tab shows as "the name that will be pulled". */
export type PullTargetPreview =
  | { readonly kind: "entered"; readonly name: string }
  /** The pull name is `/ipfs/<cid>`: that root is pulled, no IPNS lookup happens. */
  | { readonly kind: "explicit-root"; readonly cid: string }
  | { readonly kind: "owned-key"; readonly name: string }
  /** Several owned key IDs are recorded and only the node can say which one belongs to the publication key. */
  | { readonly kind: "owned-key-from-node"; readonly keyName: string; readonly recorded: number }
  | { readonly kind: "none" };

export function previewPullTarget(settings: Pick<PluginSettings, "pullName" | "ownedKeys" | "publicationKey">): PullTargetPreview {
  const cid = explicitRootOf(settings.pullName);
  if (cid !== undefined) return { kind: "explicit-root", cid };
  if (settings.pullName !== "") return { kind: "entered", name: settings.pullName };
  const [only, ...rest] = settings.ownedKeys;
  if (only === undefined) return { kind: "none" };
  if (rest.length === 0) return { kind: "owned-key", name: only };
  return { kind: "owned-key-from-node", keyName: settings.publicationKey, recorded: settings.ownedKeys.length };
}

export const NO_PULL_TARGET_MESSAGE =
  "no pull target: the pull name setting is empty and the publication key is not one this plugin owns. Set a pull name in the plugin settings.";

export type PullTargetResolution =
  | { readonly kind: "resolved"; readonly name: string; readonly source: "setting" | "owned-key" }
  /** `name` is the stored `/ipfs/<cid>` text, which is not an IPNS name: the pull runner (task 5.3) branches on `source` and uses `rootCid`. */
  | { readonly kind: "resolved"; readonly name: string; readonly source: "explicit-root"; readonly rootCid: string }
  | { readonly kind: "none"; readonly message: string };

export interface PullTargetInput {
  readonly pullName: string;
  readonly publicationKey: string;
  readonly ownedKeys: readonly string[];
}

/**
 * The name to resolve. An entered name is used as it is. Otherwise `nodeKeys` (a read-only key list, fetched only
 * in this case) must show the publication key with an ID recorded as owned; a missing, unrecorded or foreign key
 * gives no target, so nothing is pulled from someone else's key by default.
 */
export function resolvePullTarget(input: PullTargetInput, nodeKeys: readonly NodeKeyRef[]): PullTargetResolution {
  const rootCid = explicitRootOf(input.pullName);
  if (rootCid !== undefined) return { kind: "resolved", name: input.pullName, source: "explicit-root", rootCid };
  if (input.pullName !== "") return { kind: "resolved", name: input.pullName, source: "setting" };
  const found = classifyKey(input.publicationKey, nodeKeys, input.ownedKeys);
  if (found.state === "owned" && found.id !== undefined) return { kind: "resolved", name: found.id, source: "owned-key" };
  return { kind: "none", message: `${NO_PULL_TARGET_MESSAGE} (the key "${input.publicationKey}" is ${found.state}: ${found.reason})` };
}
