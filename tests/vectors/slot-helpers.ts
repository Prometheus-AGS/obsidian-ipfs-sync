import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalizePassphraseText, concatBytes, fromBase64, toBase64, utf8, type CanonicalPassphrase, type CostPolicy, type GeneratedPassphrase, type CreatedKeySlots, type KdfParams, type UnlockedVault } from "../../src/crypto";
import { u32be } from "../../src/crypto/bytes";
import type { KdfFunction } from "../../src/crypto/argon2";
import { asGenerated } from "../../src/crypto/testing/generated-passphrase";
import { parseKeySlots } from "../../src/crypto/key-slot-format";
import { createKeySlotsInternal, unlockKeySlotsInternal } from "../../src/crypto/key-slots";
import { secureRandom, type RandomSource } from "../../src/crypto/random";
import { serializeCanonical, type JsonValue } from "../../src/crypto/strict-json";
import { VALID_PASSPHRASE } from "./passphrase";

/** Canonical bytes of the pinned reference passphrase. */
export function referencePassphrase(): CanonicalPassphrase {
  return canonicalizePassphraseText(VALID_PASSPHRASE.canonical);
}

/** A second, different, valid generated passphrase (fixed, so tests are deterministic). */
/** The reference passphrase as a GeneratedPassphrase (test-only mark), for creating vaults with a fixed secret. */
export function referenceGenerated(): GeneratedPassphrase {
  return asGenerated(VALID_PASSPHRASE.canonical);
}

export const OTHER_PASSPHRASE = "AAAAAAAAAAAAAAAAAAAAAAAJ6";
export const otherPassphrase = (): CanonicalPassphrase => canonicalizePassphraseText(OTHER_PASSPHRASE);

export interface CountingKdf {
  readonly kdf: KdfFunction;
  readonly calls: () => number;
}

/**
 * A fast stand-in for Argon2id for tests of slot LOGIC (ordering, tampering, counting). It binds the password,
 * salt and all three cost parameters, so any change to them changes the key. Real Argon2id is used in the tests
 * that check the primitive itself.
 */
export function countingFakeKdf(): CountingKdf {
  let count = 0;
  const kdf: KdfFunction = async (password, salt, params: KdfParams) => {
    count++;
    return new Uint8Array(sha256(concatBytes(utf8("fake-kdf"), password, salt, u32be(params.m), u32be(params.t), u32be(params.p))));
  };
  return { kdf, calls: () => count };
}

export const FLOOR_PARAMS: KdfParams = { m: 19_456, t: 2, p: 1 };

export async function createWithFakeKdf(
  counter: CountingKdf,
  passphrase: CanonicalPassphrase = referencePassphrase(),
  params: KdfParams = FLOOR_PARAMS,
  random: RandomSource = secureRandom,
): Promise<CreatedKeySlots> {
  return createKeySlotsInternal({ passphrase: asGenerated(String.fromCharCode(...passphrase)), params }, random, { kdf: counter.kdf });
}

/** Parse and unlock with the counting stand-in KDF (test-only path). */
export async function unlockBytesWith(
  bytes: Uint8Array,
  passphrase: CanonicalPassphrase,
  counter: CountingKdf,
  options: { readonly costPolicy?: CostPolicy } = {},
): Promise<UnlockedVault> {
  return unlockKeySlotsInternal({ document: parseKeySlots(bytes), passphrase, costPolicy: options.costPolicy }, { kdf: counter.kdf });
}
type Mutable = { [key: string]: Mutable | Mutable[] | string | number | boolean | null };

/** Decode a canonical key-slot document, apply an edit, and re-serialise it canonically (LF, two spaces, one newline). */
export function editDocument(bytes: Uint8Array, edit: (document: Mutable) => void): Uint8Array<ArrayBuffer> {
  const document = JSON.parse(new TextDecoder().decode(bytes)) as Mutable;
  edit(document);
  return utf8(`${serializeCanonical(document as JsonValue, 2)}\n`);
}

/** Flip one bit of a base64 field's decoded value and re-encode canonically. */
export function flipBase64Bit(value: string, bit = 0): string {
  const bytes = fromBase64(value);
  bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) ^ (1 << (bit & 7));
  return toBase64(bytes);
}

export function firstSlot(document: Mutable): Mutable {
  return (document["slots"] as Mutable[])[0] as Mutable;
}
