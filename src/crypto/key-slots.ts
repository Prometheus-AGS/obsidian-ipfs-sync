import { aesGcmDecrypt, aesGcmEncrypt } from "./aes-gcm";
import {
  DEFAULT_KDF_PARAMS,
  assertKdfParams,
  deriveKek,
  enforceCostPolicy,
  type CostPolicy,
  type KdfFunction,
  type KdfParams,
  type KdfProgress,
} from "./argon2";
import { constantTimeEqual, utf8, wipe, type Bytes } from "./bytes";
import { fromHex, toHex } from "./codec";
import { CryptoError } from "./errors";
import { deriveAesGcmKey, hkdfSha256, importHkdfKey } from "./hkdf";
import { LABEL_SLOT_WRAP, SLOT_ID_BYTES, VAULT_ID_BYTES, VCK_BYTES, createVaultKeys, type VaultKeys } from "./key-derivation";
import {
  COMMITMENT_BYTES,
  KEY_SLOTS_VERSION,
  markParsed,
  parseKeySlots,
  prepareTriedSlots,
  serializeKeySlots,
  slotAad,
  slotCommitInfo,
  slotRecordFrom,
  type KeySlotsDocument,
  type ParsedKeySlots,
  type PreparedSlot,
} from "./key-slot-format";
import { assertCanonicalPassphrase, assertGenerated, type CanonicalPassphrase, type GeneratedPassphrase } from "./passphrase";
import { randomBytes, secureRandom, type RandomSource } from "./random";
import { ensureSelfTest } from "./self-test";
import { requireSubtle } from "./webcrypto";

/*
 * SECURITY: this file is one of the few places where the key derivation, the self-test and the randomness can be
 * substituted (the "Internal" functions below). Those are for tests and src/crypto/testing/* only. The public
 * functions (`unlockKeySlots`, `unlockKeySlotsBytes`, `createKeySlots`) accept data and callbacks that cannot weaken
 * the scheme. tools/hook-isolation.mjs (lintTestingImports) forbids the injectable names outside an allow-list.
 */

/** Collaborators substituted by tests only: never reachable from the public functions or the public index. */
export interface KeySlotDeps {
  readonly kdf?: KdfFunction;
  readonly selfTest?: () => Promise<void>;
}

/** Public input for unlock: parsed document, canonical passphrase, optional progress and cost policy. */
export interface UnlockInput {
  readonly document: ParsedKeySlots;
  /** Canonical passphrase (see `canonicalizePassphrase*`). The caller wipes it. */
  readonly passphrase: CanonicalPassphrase;
  readonly onProgress?: KdfProgress;
  /** Slots above the default cost are refused unless `approveCost` says yes. */
  readonly costPolicy?: CostPolicy;
}

export interface UnwrappedVck {
  /** Raw 32-byte VCK. The caller must import it and overwrite it. */
  readonly vck: Bytes;
  readonly vaultIdBytes: Bytes;
  readonly slotId: string;
}

async function deriveSlotSecrets(
  kek: Bytes,
  vaultIdBytes: Bytes,
  slot: { readonly id: Bytes; readonly params: KdfParams; readonly salt: Bytes },
): Promise<{ readonly commitment: Bytes; readonly wrapKey: () => Promise<CryptoKey> }> {
  const base = await importHkdfKey(kek);
  const commitment = await hkdfSha256(base, vaultIdBytes, slotCommitInfo(slot.id, slot.params, slot.salt), COMMITMENT_BYTES);
  return { commitment, wrapKey: () => deriveAesGcmKey(base, vaultIdBytes, utf8(LABEL_SLOT_WRAP)) };
}

async function tryOpenSlot(input: UnlockInput, deps: KeySlotDeps, slot: PreparedSlot, vaultIdBytes: Bytes): Promise<Bytes | undefined> {
  const kdf = deps.kdf ?? deriveKek;
  const kek = await kdf(input.passphrase, slot.salt, slot.params, input.onProgress);
  let commitment: Bytes | undefined;
  try {
    const secrets = await deriveSlotSecrets(kek, vaultIdBytes, slot);
    commitment = secrets.commitment;
    // Order is fixed: the commitment is compared BEFORE the wrap key is derived and before any decryption.
    if (!constantTimeEqual(commitment, slot.commit)) return undefined;
    const aad = slotAad(vaultIdBytes, slot.id, slot.params, slot.salt);
    return await aesGcmDecrypt(await secrets.wrapKey(), slot.nonce, slot.wrapped, aad);
  } catch (error) {
    if (error instanceof CryptoError && error.code === "authentication-failed") return undefined;
    throw error;
  } finally {
    wipe(kek, commitment);
  }
}

/**
 * The single unlock routine, shared by production `unlockKeySlots` and the test-only `unwrap-vck` hook, so the hook
 * cannot bypass the commitment. Order: brand checks (canonical passphrase, parsed document), validation of the
 * tried slots, `requireSubtle`, self-test, cost policy, Argon2id, commitment, constant-time compare, wrap key, GCM.
 * Wrong passphrase and damaged slot are one outcome and change no state. Returns the raw VCK: only the two callers
 * above may hold it, and both overwrite it.
 * @internal test and hook use only
 */
export async function unwrapVckInternal(input: UnlockInput, deps: KeySlotDeps = {}): Promise<UnwrappedVck> {
  assertCanonicalPassphrase(input.passphrase);
  const tried = prepareTriedSlots(input.document);
  // Platform checks come BEFORE any prompt: a device that cannot run the cryptography must not ask the user anything.
  requireSubtle();
  await (deps.selfTest ?? ensureSelfTest)();
  await enforceCostPolicy(tried.map((slot) => slot.params), input.costPolicy);
  const vaultIdBytes = fromHex(input.document.vaultId, VAULT_ID_BYTES);
  for (const slot of tried) {
    const vck = await tryOpenSlot(input, deps, slot, vaultIdBytes);
    if (vck !== undefined && vck.length === VCK_BYTES) return { vck, vaultIdBytes, slotId: slot.idHex };
    wipe(vck);
  }
  throw new CryptoError("wrong-passphrase-or-damaged-slot", "wrong passphrase or damaged key slot");
}

export interface UnlockedVault {
  readonly keys: VaultKeys;
  readonly slotId: string;
}

/** @internal test use only: unlock with substituted collaborators. */
export async function unlockKeySlotsInternal(input: UnlockInput, deps: KeySlotDeps): Promise<UnlockedVault> {
  const { vck, vaultIdBytes, slotId } = await unwrapVckInternal(input, deps);
  try {
    return { keys: await createVaultKeys(vaultIdBytes, vck), slotId };
  } finally {
    wipe(vck, vaultIdBytes);
  }
}

/** Unlock a parsed key-slot document. The VCK is imported non-extractable and the raw bytes are overwritten. */
export function unlockKeySlots(input: UnlockInput): Promise<UnlockedVault> {
  return unlockKeySlotsInternal({ document: input.document, passphrase: input.passphrase, onProgress: input.onProgress, costPolicy: input.costPolicy }, {});
}

/** Read (size cap, strict parse, canonical form, schema) and unlock the bytes of a `keyslots.json`. */
export async function unlockKeySlotsBytes(
  bytes: Uint8Array,
  passphrase: CanonicalPassphrase,
  options: Pick<UnlockInput, "onProgress" | "costPolicy"> = {},
): Promise<UnlockedVault> {
  return unlockKeySlots({ document: parseKeySlots(bytes), passphrase, onProgress: options.onProgress, costPolicy: options.costPolicy });
}

export interface CreateKeySlotsInput {
  /** Only a passphrase produced by `generatePassphrase` can create a vault. */
  readonly passphrase: GeneratedPassphrase;
  /** Argon2id cost; must be within the floors and ceilings. Default 64 MiB, t=3, p=1. */
  readonly params?: KdfParams;
  readonly onProgress?: KdfProgress;
}

export interface CreatedKeySlots {
  readonly document: ParsedKeySlots;
  /** The exact bytes to write as `keyslots.json` (canonical form). */
  readonly bytes: Bytes;
  readonly keys: VaultKeys;
  readonly slotId: string;
}

/**
 * @internal test use only: create with injected randomness and collaborators. Draw order:
 * vaultId(16), VCK(32), slotId(16), salt(16), wrap nonce(12).
 */
export async function createKeySlotsInternal(input: CreateKeySlotsInput, random: RandomSource, deps: KeySlotDeps): Promise<CreatedKeySlots> {
  assertGenerated(input.passphrase);
  const params = input.params ?? DEFAULT_KDF_PARAMS;
  assertKdfParams(params);
  requireSubtle();
  await (deps.selfTest ?? ensureSelfTest)();
  const vaultIdBytes = randomBytes(random, VAULT_ID_BYTES);
  const vck = randomBytes(random, VCK_BYTES);
  const id = randomBytes(random, SLOT_ID_BYTES);
  const salt = randomBytes(random, 16);
  const nonce = randomBytes(random, 12);
  let kek: Bytes | undefined;
  try {
    kek = await (deps.kdf ?? deriveKek)(input.passphrase, salt, params, input.onProgress);
    const secrets = await deriveSlotSecrets(kek, vaultIdBytes, { id, params, salt });
    const wrapped = await aesGcmEncrypt(await secrets.wrapKey(), nonce, vck, slotAad(vaultIdBytes, id, params, salt));
    const document: KeySlotsDocument = {
      version: KEY_SLOTS_VERSION,
      vaultId: toHex(vaultIdBytes),
      slots: [slotRecordFrom({ idHex: toHex(id), params, salt, nonce, wrapped, commit: secrets.commitment })],
    };
    wipe(secrets.commitment);
    return {
      document: markParsed(document),
      bytes: serializeKeySlots(document),
      keys: await createVaultKeys(vaultIdBytes, vck),
      slotId: toHex(id),
    };
  } finally {
    wipe(kek, vck, vaultIdBytes, id);
  }
}

/** Create a new vault: a fresh VCK and vault identifier and one passphrase slot with a key commitment. */
export function createKeySlots(input: CreateKeySlotsInput): Promise<CreatedKeySlots> {
  return createKeySlotsInternal({ passphrase: input.passphrase, params: input.params, onProgress: input.onProgress }, secureRandom, {});
}
