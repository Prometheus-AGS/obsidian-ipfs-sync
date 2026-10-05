import type { RawConfigLayer } from "./types";

/** The only MFS subtree this project may touch on the shared node. */
export const MFS_BASE = "/obsidian-vault-sync";

export const DEFAULT_PUBLICATION_KEY = "obsidian-vault-sync";

/** Default MFS root: only this project's vault content lives under it (`MFS_BASE` stays the confinement base). */
export const DEFAULT_MFS_ROOT = `${MFS_BASE}/default`;

/**
 * Lowest-precedence layer: flags > env > config file > these defaults.
 * There is deliberately no RPC or gateway URL here: no node is a default, so a run with none
 * configured fails closed (`no-rpc-url`, `no-gateway-url`) instead of reaching someone else's node.
 */
export function defaultLayer(): RawConfigLayer {
  return {
    publicationKey: DEFAULT_PUBLICATION_KEY,
    mfsRoot: DEFAULT_MFS_ROOT,
    auth: { scheme: "none" },
    ownedKeys: [],
  };
}
