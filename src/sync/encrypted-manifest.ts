import type { Bytes } from "../crypto/bytes";
import { hasLoneSurrogate, utf8 } from "../crypto/bytes";
import { blobNameFromKey, BLOB_NAME_PATTERN } from "../crypto/blob-names";
import { CryptoError, OversizeInputError, malformed } from "../crypto/errors";
import type { VaultKeys } from "../crypto/key-derivation";
import {
  MANIFEST_MAX_FILE_BYTES,
  decryptManifestEnvelope,
  encryptManifestEnvelope,
  manifestFileSize,
} from "../crypto/manifest-envelope";
import { parseStrictJson, serializeCanonical, type JsonObject, type JsonValue } from "../crypto/strict-json";
import { untrustedPathReason } from "./manifest-paths";

/*
 * Manifest v2 codec (spec: manifest-v2). The plaintext manifest is authenticated inside `manifest.enc`, so a
 * reader accepts any whitespace and key order but rejects duplicate keys, unknown fields, wrong types and
 * malformed formats. Paths are secret: no message in this module contains a path.
 */
export const MANIFEST_V2_VERSION = 2;
export const MANIFEST_MAX_ENTRIES = 100_000;
export const MANIFEST_MAX_PATH_BYTES = 8 * 1024 * 1024;
export const MANIFEST_DEVICE_MAX_CHARS = 64;
export const MANIFEST_MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface EncryptedManifestFile {
  /** Lowercase hex sha256 of the plaintext file. */
  readonly sha256: string;
  /** Plaintext size in bytes. */
  readonly size: number;
  /** 52-character canonical node name of the file's blob. */
  readonly blob: string;
  /** The blob's file identifier, 32 lowercase hex characters. */
  readonly fileId: string;
  /** CID of the blob on the node (CIDv0 or CIDv1). */
  readonly cid: string;
}

export interface EncryptedManifest {
  readonly version: typeof MANIFEST_V2_VERSION;
  /** 32 lowercase hex characters. */
  readonly vaultId: string;
  /** Integer 1..2^53-1, one greater than the manifest it replaces. */
  readonly sequence: number;
  /** CIDv1 base32 of `current/`, read before the manifest is written. */
  readonly rootCID: string;
  /** ISO-8601 UTC. */
  readonly publishedAt: string;
  /** 1 to 64 Unicode code points, no control characters (U+0000 to U+001F, U+007F) and no lone surrogates. */
  readonly device: string;
  /** Lowercase hex sha256 of the effective exclusion list. */
  readonly excludesHash: string;
  /** Vault path to entry. Build it with `createFilesMap` so a path such as `__proto__` is plain data. */
  readonly files: Readonly<Record<string, EncryptedManifestFile>>;
}

export interface ManifestLimits {
  readonly maxEntries: number;
  readonly maxPathBytes: number;
  readonly maxFileBytes: number;
}

export const MANIFEST_LIMITS: ManifestLimits = Object.freeze({
  maxEntries: MANIFEST_MAX_ENTRIES,
  maxPathBytes: MANIFEST_MAX_PATH_BYTES,
  maxFileBytes: MANIFEST_MAX_FILE_BYTES,
});

/** A manifest field or value that does not match its format. `field` names the field, never a path. */
export class ManifestFormatError extends CryptoError {
  readonly field: string;

  constructor(field: string, message: string) {
    super("malformed-input", message);
    this.name = "ManifestFormatError";
    this.field = field;
  }
}

function bad(field: string, expectation: string): never {
  throw new ManifestFormatError(field, `manifest field "${field}" ${expectation}`);
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** CIDs are at most 128 characters: the root CID becomes a URL path segment and the file name `manifests/<cid>.enc`. */
export const MANIFEST_CID_MAX_CHARS = 128;
const ROOT_CID_V1 = /^b[a-z2-7]{10,127}$/;
const ENTRY_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{10,127})$/;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const ROOT_KEYS = ["device", "excludesHash", "files", "publishedAt", "rootCID", "sequence", "vaultId", "version"];
const ENTRY_KEYS = ["blob", "cid", "fileId", "sha256", "size"];

/** A `files` map that is safe against prototype keys: a path named `__proto__` becomes an ordinary own property. */
export function createFilesMap(entries: Iterable<readonly [string, EncryptedManifestFile]> = []): Record<string, EncryptedManifestFile> {
  const map = Object.create(null) as Record<string, EncryptedManifestFile>;
  for (const [path, entry] of entries) map[path] = entry;
  return map;
}

/** Refuse a node-returned `rootCID` that is not CIDv1 base32 (for example a CIDv0), with a typed refusal. */
export function assertRootCidV1(rootCID: string): void {
  if (!ROOT_CID_V1.test(rootCID)) bad("rootCID", "must be a CIDv1 base32 string (a CIDv0 root is not supported)");
}

/* ---------- serialisation and caps ---------- */

function toJson(manifest: EncryptedManifest): JsonValue {
  // A plain object silently turns a `__proto__` path into a prototype change and drops the file: require createFilesMap.
  if (Object.getPrototypeOf(manifest.files) !== null) throw new ManifestFormatError("files", "manifest field \"files\" must be built with createFilesMap");
  const files = Object.create(null) as Record<string, JsonValue>;
  for (const path of Object.keys(manifest.files)) {
    const entry = manifest.files[path] as EncryptedManifestFile;
    files[path] = { blob: entry.blob, cid: entry.cid, fileId: entry.fileId, sha256: entry.sha256, size: entry.size };
  }
  return {
    device: manifest.device,
    excludesHash: manifest.excludesHash,
    files,
    publishedAt: manifest.publishedAt,
    rootCID: manifest.rootCID,
    sequence: manifest.sequence,
    vaultId: manifest.vaultId,
    version: manifest.version,
  };
}

/** `JSON.stringify` layout with object keys sorted by UTF-16 code unit at every level and no whitespace, as UTF-8. */
export function serializeManifestV2(manifest: EncryptedManifest): Bytes {
  return utf8(serializeCanonical(toJson(manifest), 0));
}

export interface ManifestSizes {
  readonly entries: number;
  readonly pathBytes: number;
  readonly plaintextBytes: number;
  readonly fileBytes: number;
}

function pathBytesOf(paths: readonly string[]): number {
  return paths.reduce((sum, path) => sum + utf8(path).length, 0);
}

/**
 * Writer-side cap check, run BEFORE any blob is written: serialises the manifest and refuses, naming the cap
 * (`manifest-entries`, `manifest-path-bytes` or `manifest-file-size`), anything the reader would refuse, so the
 * publisher never writes a manifest it cannot read back. Returns the serialised plaintext for reuse.
 */
export function checkManifestCaps(manifest: EncryptedManifest): { readonly plaintext: Bytes; readonly sizes: ManifestSizes } {
  return checkManifestCapsWith(manifest, MANIFEST_LIMITS);
}

/** @internal test use only: substituted limits. */
export function checkManifestCapsWith(
  manifest: EncryptedManifest,
  limits: ManifestLimits,
): { readonly plaintext: Bytes; readonly sizes: ManifestSizes } {
  const paths = Object.keys(manifest.files);
  if (paths.length > limits.maxEntries) {
    throw new OversizeInputError("manifest-entries", `the vault has more than ${limits.maxEntries} files; the manifest limit is exceeded`);
  }
  const pathBytes = pathBytesOf(paths);
  if (pathBytes > limits.maxPathBytes) {
    throw new OversizeInputError("manifest-path-bytes", `the vault's paths total more than ${limits.maxPathBytes} bytes; the manifest limit is exceeded`);
  }
  const plaintext = serializeManifestV2(manifest);
  const fileBytes = manifestFileSize(plaintext.length);
  if (fileBytes > limits.maxFileBytes) {
    throw new OversizeInputError("manifest-file-size", `manifest.enc would be ${fileBytes} bytes; the limit is ${limits.maxFileBytes}`);
  }
  return { plaintext, sizes: { entries: paths.length, pathBytes, plaintextBytes: plaintext.length, fileBytes } };
}

/* ---------- validation ---------- */

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectKeys(object: JsonObject, keys: readonly string[], what: string): void {
  const actual = Object.keys(object).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) bad(what, "has missing or unexpected fields");
}

function text(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") bad(key, "must be a string");
  return value as string;
}

function safeInteger(object: JsonObject, key: string, min: number): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) bad(key, `must be an integer of at least ${min}`);
  return value as number;
}

function matching(object: JsonObject, key: string, pattern: RegExp, expectation: string): string {
  const value = text(object, key);
  if (!pattern.test(value)) bad(key, `must be ${expectation}`);
  return value;
}

function checkPath(path: string): void {
  if (hasLoneSurrogate(path)) bad("path", "is not valid Unicode text");
  const reason = untrustedPathReason(path);
  if (reason !== undefined) bad("path", `is not acceptable (${reason})`);
}

function parseEntry(value: JsonValue | undefined): EncryptedManifestFile {
  if (!isObject(value)) bad("files", "entries must be objects");
  const entry = value as JsonObject;
  expectKeys(entry, ENTRY_KEYS, "file entry");
  return {
    sha256: matching(entry, "sha256", HEX64, "64 lowercase hex characters"),
    size: safeInteger(entry, "size", 0),
    blob: matching(entry, "blob", BLOB_NAME_PATTERN, "a 52-character blob name"),
    fileId: matching(entry, "fileId", HEX32, "32 lowercase hex characters"),
    cid: matching(entry, "cid", ENTRY_CID, "a CIDv0 or CIDv1 string"),
  };
}

function parseFiles(value: JsonValue | undefined, limits: ManifestLimits): Record<string, EncryptedManifestFile> {
  if (!isObject(value)) bad("files", "must be an object");
  const source = value as JsonObject;
  const paths = Object.keys(source);
  if (paths.length > limits.maxEntries) throw new OversizeInputError("manifest-entries", "the manifest lists more files than the limit allows");
  let pathBytes = 0;
  const files = createFilesMap();
  for (const path of paths) {
    pathBytes += utf8(path).length;
    if (pathBytes > limits.maxPathBytes) throw new OversizeInputError("manifest-path-bytes", "the manifest's paths exceed the byte limit");
    checkPath(path);
    files[path] = parseEntry(source[path]);
  }
  return files;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Explicit calendar check for `publishedAt` (no `Date.parse`, whose leniency differs between JavaScript engines):
 * month 1-12, day valid for the month including leap years, hour 0-23, minute 0-59, second 0-59.
 */
function isCalendarTime(value: string): boolean {
  const match = ISO_UTC.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const days = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days ?? 0) && hour <= 23 && minute <= 59 && second <= 59;
}

function parseHeaderFields(root: JsonObject): Omit<EncryptedManifest, "files"> {
  if (root["version"] !== MANIFEST_V2_VERSION) bad("version", "must be the integer 2");
  const publishedAt = matching(root, "publishedAt", ISO_UTC, "an ISO-8601 UTC timestamp");
  if (!isCalendarTime(publishedAt)) bad("publishedAt", "must be a real calendar date and time");
  const device = text(root, "device");
  const deviceLength = Array.from(device).length;
  if (deviceLength < 1 || deviceLength > MANIFEST_DEVICE_MAX_CHARS) bad("device", `must be 1 to ${MANIFEST_DEVICE_MAX_CHARS} characters`);
  if (hasLoneSurrogate(device) || /[\u0000-\u001f\u007f]/.test(device)) bad("device", "must not contain control characters or lone surrogates");
  return {
    version: MANIFEST_V2_VERSION,
    vaultId: matching(root, "vaultId", HEX32, "32 lowercase hex characters"),
    sequence: safeInteger(root, "sequence", 1),
    rootCID: matching(root, "rootCID", ROOT_CID_V1, "a CIDv1 base32 string"),
    publishedAt,
    device,
    excludesHash: matching(root, "excludesHash", HEX64, "64 lowercase hex characters"),
  };
}

/** Recompute every blob name from its path and require equality (names are compared as strings). */
async function checkBlobNames(keys: VaultKeys, files: Readonly<Record<string, EncryptedManifestFile>>): Promise<void> {
  const nameKey = await keys.nameKey();
  const paths = Object.keys(files);
  const batch = 512;
  for (let start = 0; start < paths.length; start += batch) {
    const slice = paths.slice(start, start + batch);
    const names = await Promise.all(slice.map((path) => blobNameFromKey(nameKey, path)));
    if (names.some((name, index) => name !== (files[slice[index] as string] as EncryptedManifestFile).blob)) {
      bad("blob", "does not match the name computed from its path");
    }
  }
}

/**
 * Validate manifest plaintext bytes (authenticated or written by this device): strict JSON (duplicate keys
 * refused, no prototypes), exact field sets, formats, caps, untrusted-path rules and blob-name consistency.
 */
export function parseManifestV2(keys: VaultKeys, plaintext: Uint8Array): Promise<EncryptedManifest> {
  return parseManifestV2With(keys, plaintext, MANIFEST_LIMITS);
}

/** @internal test use only: substituted limits. */
export async function parseManifestV2With(keys: VaultKeys, plaintext: Uint8Array, limits: ManifestLimits): Promise<EncryptedManifest> {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext);
  } catch {
    throw malformed("manifest is not valid UTF-8");
  }
  const root = parseStrictJson(source, { integersOnly: true });
  if (!isObject(root)) bad("manifest", "must be an object");
  expectKeys(root as JsonObject, ROOT_KEYS, "manifest");
  const fields = parseHeaderFields(root as JsonObject);
  if (fields.vaultId !== keys.vaultId) throw new CryptoError("vault-mismatch", "manifest belongs to another vault");
  const files = parseFiles((root as JsonObject)["files"], limits);
  await checkBlobNames(keys, files);
  return { ...fields, files };
}

/* ---------- encrypted file ---------- */

/**
 * Serialise, check every cap, verify the manifest reads back (formats, paths, names), and encrypt it as
 * `manifest.enc`. Refuses before producing bytes, so the publisher never writes what it cannot read.
 */
export function encodeManifestFile(keys: VaultKeys, manifest: EncryptedManifest): Promise<{ readonly file: Bytes; readonly sizes: ManifestSizes }> {
  return encodeManifestFileWith(keys, manifest, MANIFEST_LIMITS);
}

/** @internal test use only: substituted limits. */
export async function encodeManifestFileWith(
  keys: VaultKeys,
  manifest: EncryptedManifest,
  limits: ManifestLimits,
): Promise<{ readonly file: Bytes; readonly sizes: ManifestSizes }> {
  const { plaintext, sizes } = checkManifestCapsWith(manifest, limits);
  await parseManifestV2With(keys, plaintext, limits);
  return { file: await encryptManifestEnvelope(keys, plaintext), sizes };
}

/** Authenticate and decode `manifest.enc`. Nothing is returned unless the file authenticates and validates. */
export async function decodeManifestFile(keys: VaultKeys, file: Uint8Array): Promise<EncryptedManifest> {
  return parseManifestV2(keys, await decryptManifestEnvelope(keys, file));
}

