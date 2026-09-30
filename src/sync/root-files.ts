import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Names of the per-root local files under the vault's `.ipfs-sync/` folder. Publishing one directory to two MFS
 * roots keeps two independent sets: each name carries the first 16 hex characters of sha256(mfsRoot).
 */

const DIGEST_HEX_CHARS = 16;

export interface RootFileNames {
  /** `state.<h>.json`: the last completed publish to this root. */
  readonly state: string;
  /** `journal.<h>.json`: the publish in flight, written before its manifest. */
  readonly journal: string;
  /** `keyslots.<h>.json`: byte-identical copy of the node's key-slot file for this root. */
  readonly keyslots: string;
}

/** The lock file is per vault directory, not per root: it stops two processes from publishing at once. */
export const PUBLISH_LOCK_KEY = "publish.lock";

/** First 16 hex characters of sha256 over the UTF-8 MFS root. */
export function rootDigest(mfsRoot: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(mfsRoot))).slice(0, DIGEST_HEX_CHARS);
}

export function rootFileNames(mfsRoot: string): RootFileNames {
  const digest = rootDigest(mfsRoot);
  return { state: `state.${digest}.json`, journal: `journal.${digest}.json`, keyslots: `keyslots.${digest}.json` };
}
