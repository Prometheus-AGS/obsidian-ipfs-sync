import {
  KDF_ALGORITHM,
  KDF_OUTPUT_BYTES,
  KDF_SALT_BYTES,
  KDF_VERSION,
  assertKdfParams,
  type KdfParams,
} from "./argon2";
import { concatBytes, u32be, utf8, type Bytes } from "./bytes";
import { fromBase64, fromHex, toBase64 } from "./codec";
import { CryptoError, KdfParamsError, OversizeInputError, invalidArgument, malformed } from "./errors";
import { LABEL_SLOT_AAD, LABEL_SLOT_COMMIT, SLOT_ID_BYTES, VAULT_ID_BYTES, VCK_BYTES } from "./key-derivation";
import { AES_GCM_NONCE_BYTES, AES_GCM_TAG_BYTES } from "./aes-gcm";
import {
  containsOnlyIntegers,
  parseStrictJson,
  serializeCanonical,
  type JsonObject,
  type JsonValue,
} from "./strict-json";

/*
 * keyslots.json (design decision 2). Check order on read: size, parse, format version, canonical form, schema.
 * Then, for the at most two passphrase slots that will be tried: fixed fields, binary lengths, KDF bounds, all
 * before the first derivation.
 */
export const KEY_SLOTS_VERSION = 1;
export const KEY_SLOTS_MAX_BYTES = 16 * 1024;
export const KEY_SLOTS_MAX_SLOTS = 8;
/** At most this many passphrase slots are tried in one unlock. */
export const KEY_SLOTS_MAX_TRIED = 2;
export const SLOT_TYPE_PASSPHRASE = "passphrase";
export const WRAP_ALGORITHM = "aes-256-gcm";
export const WRAPPED_VCK_BYTES = VCK_BYTES + AES_GCM_TAG_BYTES;
export const COMMITMENT_BYTES = 32;

export interface PassphraseSlotRecord {
  readonly type: typeof SLOT_TYPE_PASSPHRASE;
  /** 32 lowercase hex characters (16 raw bytes). */
  readonly id: string;
  readonly kdf: {
    readonly alg: string;
    readonly dkLen: number;
    readonly m: number;
    readonly p: number;
    /** Canonical base64. */
    readonly salt: string;
    readonly t: number;
    readonly v: number;
  };
  readonly wrap: { readonly alg: string; readonly ct: string; readonly nonce: string };
  readonly commit: string;
}

/** A slot of a type this build does not know. Skipped by unlock; kept verbatim so a rewritten document preserves it. */
export interface UnknownSlotRecord {
  readonly type: string;
  readonly raw: JsonObject;
}

export type SlotRecord = PassphraseSlotRecord | UnknownSlotRecord;

export interface KeySlotsDocument {
  readonly version: typeof KEY_SLOTS_VERSION;
  /** 32 lowercase hex characters (16 raw bytes). */
  readonly vaultId: string;
  readonly slots: readonly SlotRecord[];
}

declare const parsedBrand: unique symbol;

/**
 * A document that came out of `parseKeySlots` (size cap, strict parse, canonical form, schema) or out of
 * `createKeySlots`. Unlock accepts nothing else. The brand is also enforced at run time through a registry, so a
 * hand-built or `JSON.parse`d object cannot be passed off as parsed.
 */
export type ParsedKeySlots = KeySlotsDocument & { readonly [parsedBrand]: true };

const PARSED = new WeakSet<object>();

/** Freeze and register a document produced by this module's parser or creator. */
function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

export function markParsed(document: KeySlotsDocument): ParsedKeySlots {
  deepFreeze(document);
  PARSED.add(document);
  return document as ParsedKeySlots;
}

export function assertParsed(document: KeySlotsDocument): ParsedKeySlots {
  if (!PARSED.has(document)) throw invalidArgument("key-slot document was not produced by parseKeySlots");
  return document as ParsedKeySlots;
}

/** A passphrase slot that passed the fixed-field, length and bounds checks. */
export interface PreparedSlot {
  readonly id: Bytes;
  readonly idHex: string;
  readonly params: KdfParams;
  readonly salt: Bytes;
  readonly nonce: Bytes;
  readonly wrapped: Bytes;
  readonly commit: Bytes;
}

export function isPassphraseSlot(slot: SlotRecord): slot is PassphraseSlotRecord {
  return slot.type === SLOT_TYPE_PASSPHRASE;
}

const HEX32 = /^[0-9a-f]{32}$/;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectKeys(object: JsonObject, keys: readonly string[], what: string): void {
  const actual = Object.keys(object).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw malformed(`${what} has missing or unexpected fields`);
  }
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") throw malformed(`field "${key}" must be a string`);
  return value;
}

function integerField(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw malformed(`field "${key}" must be an integer`);
  return value;
}

function objectField(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  if (!isObject(value)) throw malformed(`field "${key}" must be an object`);
  return value;
}

function parsePassphraseSlot(object: JsonObject): PassphraseSlotRecord {
  expectKeys(object, ["commit", "id", "kdf", "type", "wrap"], "passphrase slot");
  const kdf = objectField(object, "kdf");
  const wrap = objectField(object, "wrap");
  expectKeys(kdf, ["alg", "dkLen", "m", "p", "salt", "t", "v"], "slot kdf");
  expectKeys(wrap, ["alg", "ct", "nonce"], "slot wrap");
  const id = stringField(object, "id");
  if (!HEX32.test(id)) throw malformed("slot identifier must be 32 lowercase hex characters");
  return {
    type: SLOT_TYPE_PASSPHRASE,
    id,
    kdf: {
      alg: stringField(kdf, "alg"),
      dkLen: integerField(kdf, "dkLen"),
      m: integerField(kdf, "m"),
      p: integerField(kdf, "p"),
      salt: stringField(kdf, "salt"),
      t: integerField(kdf, "t"),
      v: integerField(kdf, "v"),
    },
    wrap: { alg: stringField(wrap, "alg"), ct: stringField(wrap, "ct"), nonce: stringField(wrap, "nonce") },
    commit: stringField(object, "commit"),
  };
}

function parseSlot(value: JsonValue): SlotRecord {
  if (!isObject(value)) throw malformed("slot must be an object");
  const type = value["type"];
  if (typeof type !== "string") throw malformed("slot type must be a string");
  return type === SLOT_TYPE_PASSPHRASE ? parsePassphraseSlot(value) : { type, raw: value };
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw malformed("key-slot document is not valid UTF-8");
  }
}

/**
 * Read a `keyslots.json`. Order: size cap, parse (duplicate keys, bounded depth, prototype-free objects),
 * format version, canonical form, schema. Nothing here derives a key. `unsupported-format` is raised for a
 * version this build does not know; `malformed-input` for every structural problem; `oversize-input` for the
 * 16 KiB and 8-slot caps.
 */
export function parseKeySlots(bytes: Uint8Array): ParsedKeySlots {
  if (bytes.length > KEY_SLOTS_MAX_BYTES) throw new OversizeInputError("keyslots-size", "key-slot document exceeds 16 KiB");
  const text = decodeText(bytes);
  const root = parseStrictJson(text);
  if (!isObject(root)) throw malformed("key-slot document must be an object");
  const version = root["version"];
  if (typeof version !== "number") throw malformed("key-slot document has no format version");
  if (version !== KEY_SLOTS_VERSION) throw new CryptoError("unsupported-format", `key-slot format version ${String(version)} is not supported`);
  if (!containsOnlyIntegers(root) || `${serializeCanonical(root, 2)}\n` !== text) throw malformed("key-slot document is not in canonical form");
  expectKeys(root, ["slots", "vaultId", "version"], "key-slot document");
  const vaultId = stringField(root, "vaultId");
  if (!HEX32.test(vaultId)) throw malformed("vaultId must be 32 lowercase hex characters");
  const slots = root["slots"];
  if (!Array.isArray(slots)) throw malformed("slots must be a list");
  if (slots.length > KEY_SLOTS_MAX_SLOTS) throw new OversizeInputError("keyslots-slot-count", "key-slot document lists more than 8 slots");
  return markParsed({ version: KEY_SLOTS_VERSION, vaultId, slots: slots.map(parseSlot) });
}

function slotToJson(slot: SlotRecord): JsonValue {
  if (!isPassphraseSlot(slot)) return slot.raw;
  const { kdf, wrap } = slot;
  return { commit: slot.commit, id: slot.id, kdf: { ...kdf }, type: slot.type, wrap: { ...wrap } };
}

/** Canonical serialisation: sorted keys, two-space indent, LF, exactly one trailing newline. */
export function serializeKeySlots(document: KeySlotsDocument): Bytes {
  const value: JsonValue = { slots: document.slots.map(slotToJson), vaultId: document.vaultId, version: document.version };
  return utf8(`${serializeCanonical(value, 2)}\n`);
}

function decodeSalt(salt: string): Bytes {
  const bytes = fromBase64(salt);
  if (bytes.length !== KDF_SALT_BYTES) throw new KdfParamsError("salt", `Argon2id salt must be ${KDF_SALT_BYTES} bytes`);
  return bytes;
}

function assertFixedFields(slot: PassphraseSlotRecord): void {
  const { kdf, wrap } = slot;
  if (kdf.alg !== KDF_ALGORITHM || kdf.v !== KDF_VERSION || kdf.dkLen !== KDF_OUTPUT_BYTES || wrap.alg !== WRAP_ALGORITHM) {
    throw new CryptoError("unsupported-format", "key slot declares an algorithm, version or output length this build does not support");
  }
}

/** Fixed fields, binary lengths and KDF bounds of one passphrase slot. Throws before any derivation. */
export function prepareSlot(slot: PassphraseSlotRecord): PreparedSlot {
  assertFixedFields(slot);
  const params: KdfParams = { m: slot.kdf.m, t: slot.kdf.t, p: slot.kdf.p };
  const salt = decodeSalt(slot.kdf.salt);
  assertKdfParams(params);
  return {
    id: fromHex(slot.id, SLOT_ID_BYTES),
    idHex: slot.id,
    params,
    salt,
    nonce: fromBase64(slot.wrap.nonce, AES_GCM_NONCE_BYTES),
    wrapped: fromBase64(slot.wrap.ct, WRAPPED_VCK_BYTES),
    commit: fromBase64(slot.commit, COMMITMENT_BYTES),
  };
}

/**
 * Refuse a file that lists ANY slot of a type this build does not know, not only among the (at most two) slots an
 * unlock tries. A rewrap writes a file with one slot; an unknown slot (a future hardware-key slot, say) would be
 * silently dropped, so the rewrap stops before it derives anything. `parseKeySlots` keeps every slot of the file
 * (up to 8, unknown ones verbatim), so this scan sees them all.
 */
export function assertNoUnknownSlots(document: ParsedKeySlots): ParsedKeySlots {
  assertParsed(document);
  if (document.slots.some((slot) => !isPassphraseSlot(slot))) {
    throw new CryptoError("unsupported-format", "cannot rewrap a file with slot types this version does not know");
  }
  return document;
}

/**
 * The passphrase slots an unlock will try: unknown types are skipped, at most two are taken in list order, and
 * ALL of them are validated here, so a bad first slot refuses the whole unlock even when the second is good.
 * Raises `no-usable-slot` when no passphrase slot remains.
 */
export function prepareTriedSlots(document: ParsedKeySlots): readonly PreparedSlot[] {
  assertParsed(document);
  const candidates = document.slots.filter(isPassphraseSlot).slice(0, KEY_SLOTS_MAX_TRIED);
  if (candidates.length === 0) throw new CryptoError("no-usable-slot", "the key-slot document has no passphrase slot this build can use");
  return candidates.map(prepareSlot);
}

/** Commitment information bytes: label || slotId(16) || v || m || t || p || dkLen (u32 each) || salt(16). */
export function slotCommitInfo(vaultSlotId: Bytes, params: KdfParams, salt: Bytes): Bytes {
  return concatBytes(
    utf8(LABEL_SLOT_COMMIT),
    vaultSlotId,
    u32be(KDF_VERSION),
    u32be(params.m),
    u32be(params.t),
    u32be(params.p),
    u32be(KDF_OUTPUT_BYTES),
    salt,
  );
}

/** Slot associated data: label || vaultId(16) || slotId(16) || v || m || t || p || dkLen || salt(16) || "argon2id" || 0x00 || "aes-256-gcm". */
export function slotAad(vaultIdBytes: Bytes, slotId: Bytes, params: KdfParams, salt: Bytes): Bytes {
  if (vaultIdBytes.length !== VAULT_ID_BYTES) throw malformed("vault identifier must be 16 bytes");
  return concatBytes(
    utf8(LABEL_SLOT_AAD),
    vaultIdBytes,
    slotId,
    u32be(KDF_VERSION),
    u32be(params.m),
    u32be(params.t),
    u32be(params.p),
    u32be(KDF_OUTPUT_BYTES),
    salt,
    utf8(KDF_ALGORITHM),
    new Uint8Array([0]),
    utf8(WRAP_ALGORITHM),
  );
}

export function slotRecordFrom(input: {
  readonly idHex: string;
  readonly params: KdfParams;
  readonly salt: Bytes;
  readonly nonce: Bytes;
  readonly wrapped: Bytes;
  readonly commit: Bytes;
}): PassphraseSlotRecord {
  return {
    type: SLOT_TYPE_PASSPHRASE,
    id: input.idHex,
    kdf: {
      alg: KDF_ALGORITHM,
      dkLen: KDF_OUTPUT_BYTES,
      m: input.params.m,
      p: input.params.p,
      salt: toBase64(input.salt),
      t: input.params.t,
      v: KDF_VERSION,
    },
    wrap: { alg: WRAP_ALGORITHM, ct: toBase64(input.wrapped), nonce: toBase64(input.nonce) },
    commit: toBase64(input.commit),
  };
}
