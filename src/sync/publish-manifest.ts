import { blobNameFor, hasLoneSurrogate, type VaultKeys } from "../crypto";
import {
  MANIFEST_DEVICE_MAX_CHARS,
  MANIFEST_V2_VERSION,
  createFilesMap,
  type EncryptedManifest,
  type EncryptedManifestFile,
} from "./encrypted-manifest";
import { DEVICE_LABEL_MAX_CHARS, deviceSuffix } from "./device-store";
import type { WrittenBlob } from "./encrypted-transfer";

/**
 * Building the manifest a publish writes. Two builds share one shape: the PROVISIONAL manifest, made before any blob
 * is written with placeholders where a value only exists after the write (file identifier, blob CID, tree CID),
 * which the caller runs through the same encoder as the real one so every cap and format is checked while
 * nothing has been sent; and the FINAL manifest, made from what was actually written.
 */

const DEFAULT_DEVICE = "cli";

/** A CIDv1 base32 string of the length kubo returns for a sha2-256 CID (59 characters), used only in the provisional build. */
const PLACEHOLDER_CID = `b${"a".repeat(58)}`;
const PLACEHOLDER_FILE_ID = "0".repeat(32);

/**
 * The manifest `device`. The label (from the environment, or the host default) is made valid: no control characters and
 * no lone surrogates, an unusable value becomes the default. With a device id the label is cut to
 * `DEVICE_LABEL_MAX_CHARS` code points and the first 12 hex characters of the id follow it (`<label>-<12 hex>`, at
 * most 64 code points); without one the label stands alone, cut to 64 (a host that has no device store).
 */
export function sanitizeDevice(raw: string | undefined, deviceId?: string): string {
  const limit = deviceId === undefined ? MANIFEST_DEVICE_MAX_CHARS : DEVICE_LABEL_MAX_CHARS;
  const cleaned = Array.from(raw ?? "")
    .filter((char) => !/[\u0000-\u001f\u007f]/.test(char) && !hasLoneSurrogate(char))
    .slice(0, limit)
    .join("")
    .trim();
  const label = cleaned === "" ? DEFAULT_DEVICE : cleaned;
  return deviceId === undefined ? label : `${label}-${deviceSuffix(deviceId)}`;
}

export function entryOf(blob: WrittenBlob): EncryptedManifestFile {
  return { sha256: blob.sha256, size: blob.size, blob: blob.blob, fileId: blob.fileId, cid: blob.cid };
}

export interface ManifestFrame {
  readonly vaultId: string;
  readonly sequence: number;
  readonly publishedAt: string;
  readonly device: string;
  readonly excludesHash: string;
}

function assemble(frame: ManifestFrame, rootCID: string, entries: Iterable<readonly [string, EncryptedManifestFile]>): EncryptedManifest {
  return { version: MANIFEST_V2_VERSION, ...frame, rootCID, files: createFilesMap(entries) };
}

/** A planned write as the provisional manifest sees it. */
export interface PlannedEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export async function provisionalManifest(
  keys: VaultKeys,
  frame: ManifestFrame,
  kept: Readonly<Record<string, EncryptedManifestFile>>,
  planned: readonly PlannedEntry[],
): Promise<EncryptedManifest> {
  const entries: (readonly [string, EncryptedManifestFile])[] = Object.entries(kept);
  for (const item of planned) {
    const blob = await blobNameFor(keys, item.path);
    entries.push([item.path, { sha256: item.sha256, size: item.size, blob, fileId: PLACEHOLDER_FILE_ID, cid: PLACEHOLDER_CID }]);
  }
  return assemble(frame, PLACEHOLDER_CID, entries);
}

export function finalManifest(
  frame: ManifestFrame,
  currentCid: string,
  kept: Readonly<Record<string, EncryptedManifestFile>>,
  written: readonly WrittenBlob[],
): EncryptedManifest {
  const entries: (readonly [string, EncryptedManifestFile])[] = [...Object.entries(kept), ...written.map((blob) => [blob.path, entryOf(blob)] as const)];
  return assemble(frame, currentCid, entries);
}
