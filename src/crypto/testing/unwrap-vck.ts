/**
 * TEST-ONLY. Returns the raw vault content key from a `keyslots.json` and a passphrase, so the automated
 * feature operation can prove that the key does not occur in any byte stored on the node. It calls the SAME
 * internal routine as production unlock, so a corrupted commitment fails here exactly as it fails there.
 * This module MUST NOT be imported by the plugin, the CLI or any module reachable from them (tools/hook-isolation.mjs
 * fails the build if a bundle contains the sentinel below or any input from this folder).
 */
import type { Bytes } from "../bytes";
import { parseKeySlots } from "../key-slot-format";
import type { CanonicalPassphrase } from "../passphrase";
import { unwrapVckInternal, type KeySlotDeps } from "../key-slots";

export const UNWRAP_VCK_SENTINEL = "IPFS_SYNC_TEST_ONLY_SENTINEL_UNWRAP_VCK_9a06e3b17d48";

export interface RawVault {
  readonly vck: Bytes;
  readonly vaultId: Bytes;
  readonly slotId: string;
}

export async function unwrapVckForTest(keySlots: Uint8Array, passphrase: CanonicalPassphrase, deps: KeySlotDeps = {}): Promise<RawVault> {
  if (passphrase.length === 0) throw new Error(`${UNWRAP_VCK_SENTINEL}: empty passphrase`);
  const raw = await unwrapVckInternal({ document: parseKeySlots(keySlots), passphrase }, deps);
  return { vck: raw.vck, vaultId: raw.vaultIdBytes, slotId: raw.slotId };
}
