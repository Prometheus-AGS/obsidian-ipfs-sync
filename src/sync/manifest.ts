export const MANIFEST_VERSION = 1;

export interface ManifestFile {
  /** Lowercase hex sha256 of the file bytes. */
  readonly sha256: string;
  readonly size: number;
  /** CID of the file on the node (MFS stat after the write). */
  readonly cid: string;
}

/**
 * Manifest v1 (DESIGN section 4.2). Plaintext. Publishing it was removed in mvp-06 (every publish is encrypted); this type
 * and its reader stay only for the pull engine's plaintext path, which encrypted pull removes in the next change.
 */
export interface Manifest {
  readonly version: typeof MANIFEST_VERSION;
  /** CID of the `current/` vault tree, read before the manifest is written. */
  readonly rootCID: string;
  /** UTC ISO-8601. */
  readonly publishedAt: string;
  readonly device: string;
  readonly files: Readonly<Record<string, ManifestFile>>;
  readonly excludesHash: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export interface ManifestInput {
  readonly rootCid: string;
  readonly publishedAt: string;
  readonly device: string;
  readonly files: Readonly<Record<string, ManifestFile>>;
  readonly excludesHash: string;
}

export function buildManifest(input: ManifestInput): Manifest {
  return {
    version: MANIFEST_VERSION,
    rootCID: input.rootCid,
    publishedAt: input.publishedAt,
    device: input.device,
    files: input.files,
    excludesHash: input.excludesHash,
  };
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFile(path: string, value: unknown): ManifestFile {
  if (!isRecord(value)) throw new ManifestError(`manifest entry "${path}" is not an object`);
  const { sha256, size, cid } = value;
  if (typeof sha256 !== "string" || !HEX_SHA256.test(sha256)) throw new ManifestError(`manifest entry "${path}" has an invalid sha256`);
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) throw new ManifestError(`manifest entry "${path}" has an invalid size`);
  if (typeof cid !== "string" || cid === "") throw new ManifestError(`manifest entry "${path}" has no cid`);
  return { sha256, size, cid };
}

/** Validate an untrusted manifest object (from disk or from the node). */
export function validateManifest(value: unknown): Manifest {
  if (!isRecord(value)) throw new ManifestError("manifest is not an object");
  const { version, rootCID, publishedAt, device, files, excludesHash } = value;
  if (version !== MANIFEST_VERSION) throw new ManifestError(`unsupported manifest version ${String(version)}`);
  if (typeof rootCID !== "string" || rootCID === "") throw new ManifestError("manifest has no rootCID");
  if (typeof publishedAt !== "string" || typeof device !== "string") throw new ManifestError("manifest has no publishedAt or device");
  if (typeof excludesHash !== "string" || !HEX_SHA256.test(excludesHash)) throw new ManifestError("manifest has an invalid excludesHash");
  if (!isRecord(files)) throw new ManifestError("manifest files is not an object");
  const parsed = Object.entries(files).map(([path, entry]) => [path, parseFile(path, entry)] as const);
  return { version, rootCID, publishedAt, device, files: Object.fromEntries(parsed), excludesHash };
}

export function parseManifest(text: string): Manifest {
  try {
    return validateManifest(JSON.parse(text));
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
