/**
 * TEST-ONLY. Turns a known passphrase text into a `GeneratedPassphrase`, so tests can create vaults with fixed,
 * reproducible secrets. This module MUST NOT be imported by the plugin, the CLI or any module reachable from them
 * (tools/hook-isolation.mjs fails the build if a bundle contains the sentinel below or any input from this folder).
 */
import { canonicalizePassphraseText, markGenerated, type GeneratedPassphrase } from "../passphrase";

export const GENERATED_PASSPHRASE_SENTINEL = "IPFS_SYNC_TEST_ONLY_SENTINEL_GENERATED_PASSPHRASE_5e2b7c90a1d3";

export function asGenerated(text: string): GeneratedPassphrase {
  if (text.length === 0) throw new Error(`${GENERATED_PASSPHRASE_SENTINEL}: empty text`);
  return markGenerated(canonicalizePassphraseText(text));
}
