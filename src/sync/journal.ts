import type { Bytes, HostKv } from "../core/host-bridge";
import type { EncryptedManifest } from "./encrypted-manifest";
import {
  HEX32,
  HEX64,
  RootStateError,
  isJsonRecord,
  parseJsonObject,
  parseManifestField,
  parseMtimes,
  requireText,
} from "./local-record";
import { rootFileNames } from "./root-files";
import { stableStringify } from "./stable-json";

/**
 * The journal of a publish in flight, kept as `.ipfs-sync/journal.<h>.json`. It is written BEFORE `manifest.enc`
 * and removed as the last step of a completed publish. If the process dies in between, the next publish reads it
 * to decide whether the manifest reached the node and how to finish or reconcile (see `publish-resume.ts`).
 *
 * It holds the plaintext pending manifest (paths included), so like the state file it is plaintext at rest and
 * the `.ipfs-sync/` folder must stay out of third-party sync and backups. It holds hashes wherever a hash is
 * enough: the manifest file is identified by its sha256, never stored.
 */

export const JOURNAL_VERSION = 1;

export interface PublishJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly mfsRoot: string;
  /** IPNS key name the publish was going to use. */
  readonly key: string;
  readonly vaultId: string;
  /** Lowercase hex sha256 of the local key-slot copy the publish ran under. */
  readonly keyslotsSha256: string;
  /** The sequence the pending manifest carries. */
  readonly sequence: number;
  /** Lowercase hex sha256 of the exact `manifest.enc` bytes about to be written. */
  readonly manifestSha256: string;
  /** The state to adopt if the publish is reconciled: the plaintext manifest and the modification times. */
  readonly pending: {
    readonly manifest: EncryptedManifest;
    readonly mtimes: Readonly<Record<string, number>>;
  };
  /** ISO-8601 UTC time the publish reached the journal step. */
  readonly startedAt: string;
}

export type PublishJournalInput = Omit<PublishJournal, "version">;

export function buildJournal(input: PublishJournalInput): PublishJournal {
  return { version: JOURNAL_VERSION, ...input };
}

export function encodeJournal(journal: PublishJournal): Bytes {
  return new TextEncoder().encode(`${stableStringify(journal, 2)}\n`);
}

export function decodeJournal(bytes: Bytes): PublishJournal {
  const record = parseJsonObject(bytes, "journal");
  if (record["version"] !== JOURNAL_VERSION) throw new RootStateError(`journal format ${String(record["version"])} is not supported by this version`);
  const pending = record["pending"];
  if (!isJsonRecord(pending)) throw new RootStateError("journal has no pending state");
  const manifest = parseManifestField(pending["manifest"], "journal");
  const sequence = record["sequence"];
  if (typeof sequence !== "number" || sequence !== manifest.sequence) throw new RootStateError("journal sequence does not match its pending manifest");
  const vaultId = requireText(record, "vaultId", HEX32, "journal");
  if (vaultId !== manifest.vaultId) throw new RootStateError("journal vaultId does not match its pending manifest");
  return buildJournal({
    mfsRoot: requireText(record, "mfsRoot", undefined, "journal"),
    key: requireText(record, "key", undefined, "journal"),
    vaultId,
    keyslotsSha256: requireText(record, "keyslotsSha256", HEX64, "journal"),
    sequence,
    manifestSha256: requireText(record, "manifestSha256", HEX64, "journal"),
    pending: { manifest, mtimes: parseMtimes(pending["mtimes"], "journal") },
    startedAt: requireText(record, "startedAt", undefined, "journal"),
  });
}

/** What the journal file holds: nothing, a usable journal, or a file that cannot be read (torn write or damage). */
export type JournalRead =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly journal: PublishJournal }
  | { readonly kind: "damaged" };

/**
 * The journal for `mfsRoot`. An unreadable file is reported as `damaged`, not thrown: the journal is written
 * before `manifest.enc`, so a torn journal means the manifest was never written, and the resume step decides
 * from the node whether that is so. Callers compare `journal.mfsRoot` themselves (a copied file is a mismatch).
 */
export async function readJournal(kv: Pick<HostKv, "get">, mfsRoot: string): Promise<JournalRead> {
  const bytes = await kv.get(rootFileNames(mfsRoot).journal);
  if (bytes === undefined) return { kind: "none" };
  try {
    return { kind: "ok", journal: decodeJournal(bytes) };
  } catch (error) {
    if (error instanceof RootStateError) return { kind: "damaged" };
    throw error;
  }
}

export async function writeJournal(kv: Pick<HostKv, "set">, journal: PublishJournal): Promise<void> {
  await kv.set(rootFileNames(journal.mfsRoot).journal, encodeJournal(journal));
}

export async function deleteJournal(kv: Pick<HostKv, "delete">, mfsRoot: string): Promise<void> {
  await kv.delete(rootFileNames(mfsRoot).journal);
}
