import type { RawConfigLayer } from "./types";

/** The only MFS subtree this project may touch on the shared node. */
export const MFS_BASE = "/obsidian-vault-sync";

/** Marker file that flags a synthetic fixture vault (the guard is removed by the encrypted-pull change, mvp-07). */
export const FIXTURE_MARKER = ".ipfs-sync-fixture";

/** Marker text created by the user or the fixture generator. The only value that enables publish. */
export const FIXTURE_MARKER_VALUE = "fixture";

/** Marker text created by pull when it populated an empty destination. Enables pull, never publish. */
export const PULLED_MARKER_VALUE = "pulled-fixture";

export const DEFAULT_RPC_URL = "https://ipfs.prometheusags.ai";
export const DEFAULT_GATEWAY_URL = "https://ipfs.prometheusags.ai";
export const DEFAULT_PUBLICATION_KEY = "obsidian-vault-sync";

/** Default MFS root: only this project's vault content lives under it (`MFS_BASE` stays the confinement base). */
export const DEFAULT_MFS_ROOT = `${MFS_BASE}/default`;

/** Lowest-precedence layer: flags > env > config file > these defaults. */
export function defaultLayer(): RawConfigLayer {
  return {
    rpc: { url: DEFAULT_RPC_URL },
    gateway: { url: DEFAULT_GATEWAY_URL },
    publicationKey: DEFAULT_PUBLICATION_KEY,
    mfsRoot: DEFAULT_MFS_ROOT,
    auth: { scheme: "none" },
    ownedKeys: [],
  };
}
