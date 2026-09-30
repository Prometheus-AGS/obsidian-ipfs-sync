import { BLOB_NAME_PATTERN } from "../crypto";
import {
  MANIFEST_DEVICE_MAX_CHARS,
  MANIFEST_MAX_ENTRIES,
  MANIFEST_MAX_PATH_BYTES,
  MANIFEST_V2_VERSION,
  createFilesMap,
  type EncryptedManifest,
  type EncryptedManifestFile,
} from "./encrypted-manifest";
import { untrustedPathReason } from "./manifest-paths";

/**
 * Structural reader for the plaintext manifest kept in the local state and journal files. The local files are
 * read BEFORE any key exists (a mismatch with the node must refuse before any key derivation), so this reader
 * checks shapes and formats only; it cannot recompute blob names. The node's authenticated manifest is compared
 * with it later (`sameManifest`), and nothing read here is ever sent to the node without that comparison.
 * Messages name fields, never paths.
 */

export class LocalManifestError extends Error {
  constructor(what: string) {
    super(`local manifest record is not valid: ${what}`);
    this.name = "LocalManifestError";
  }
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROOT_CID = /^b[a-z2-7]{10,127}$/;
const ENTRY_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{10,127})$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ROOT_KEYS = ["device", "excludesHash", "files", "publishedAt", "rootCID", "sequence", "vaultId", "version"];
const ENTRY_KEYS = ["blob", "cid", "fileId", "sha256", "size"];

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(what: string): never {
  throw new LocalManifestError(what);
}

function exactKeys(record: JsonRecord, keys: readonly string[], what: string): void {
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) bad(`${what} has missing or unexpected fields`);
}

function pattern(record: JsonRecord, key: string, expected: RegExp): string {
  const value = record[key];
  if (typeof value !== "string" || !expected.test(value)) bad(`field "${key}" has the wrong format`);
  return value as string;
}

function integer(record: JsonRecord, key: string, min: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) bad(`field "${key}" must be an integer of at least ${min}`);
  return value as number;
}

function parseEntry(value: unknown): EncryptedManifestFile {
  if (!isRecord(value)) bad("a file entry is not an object");
  const entry = value as JsonRecord;
  exactKeys(entry, ENTRY_KEYS, "a file entry");
  return {
    sha256: pattern(entry, "sha256", HEX64),
    size: integer(entry, "size", 0),
    blob: pattern(entry, "blob", BLOB_NAME_PATTERN),
    fileId: pattern(entry, "fileId", HEX32),
    cid: pattern(entry, "cid", ENTRY_CID),
  };
}

function parseFiles(value: unknown): Record<string, EncryptedManifestFile> {
  if (!isRecord(value)) bad('field "files" is not an object');
  const source = value as JsonRecord;
  const paths = Object.keys(source);
  if (paths.length > MANIFEST_MAX_ENTRIES) bad("too many file entries");
  const files = createFilesMap();
  let pathBytes = 0;
  for (const path of paths) {
    pathBytes += new TextEncoder().encode(path).length;
    if (pathBytes > MANIFEST_MAX_PATH_BYTES) bad("paths exceed the byte limit");
    if (untrustedPathReason(path) !== undefined) bad("a path is not acceptable");
    files[path] = parseEntry(source[path]);
  }
  return files;
}

/** Validate a manifest object read from a local state or journal file. */
export function parseLocalManifest(value: unknown): EncryptedManifest {
  if (!isRecord(value)) bad("the manifest is not an object");
  const root = value as JsonRecord;
  exactKeys(root, ROOT_KEYS, "the manifest");
  if (root["version"] !== MANIFEST_V2_VERSION) bad('field "version" must be 2');
  const device = root["device"];
  if (typeof device !== "string" || Array.from(device).length < 1 || Array.from(device).length > MANIFEST_DEVICE_MAX_CHARS) {
    bad('field "device" has the wrong length');
  }
  return {
    version: MANIFEST_V2_VERSION,
    vaultId: pattern(root, "vaultId", HEX32),
    sequence: integer(root, "sequence", 1),
    rootCID: pattern(root, "rootCID", ROOT_CID),
    publishedAt: pattern(root, "publishedAt", ISO_UTC),
    device: device as string,
    excludesHash: pattern(root, "excludesHash", HEX64),
    files: parseFiles(root["files"]),
  };
}

function sameEntry(a: EncryptedManifestFile, b: EncryptedManifestFile): boolean {
  return a.sha256 === b.sha256 && a.size === b.size && a.blob === b.blob && a.fileId === b.fileId && a.cid === b.cid;
}

/**
 * The resume comparison: `vaultId`, `sequence`, `rootCID` and the file map (every path with every entry field)
 * must be equal. Own-property lookups only, so a path such as `constructor` cannot match an inherited member.
 */
export function sameManifest(a: EncryptedManifest, b: EncryptedManifest): boolean {
  if (a.vaultId !== b.vaultId || a.sequence !== b.sequence || a.rootCID !== b.rootCID) return false;
  const paths = Object.keys(a.files);
  if (paths.length !== Object.keys(b.files).length) return false;
  return paths.every((path) => {
    const other = Object.hasOwn(b.files, path) ? b.files[path] : undefined;
    const own = a.files[path];
    return other !== undefined && own !== undefined && sameEntry(own, other);
  });
}
