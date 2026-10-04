import type { HostFs, HostKv } from "../core/host-bridge";
import { CryptoError, OversizeInputError, type CanonicalPassphrase, type KdfParams, type KdfProgress, type VaultKeys } from "../crypto";
import type { KuboClient, MfsEntry } from "../kubo";
import type { DeviceStore } from "../sync/device-store";
import { stateRecordOf } from "../sync/encrypted-pull";
import { ManifestFormatError, decodeManifestFile, type EncryptedManifest } from "../sync/encrypted-manifest";
import { prefixMatchesSequence, sortHistoryNames, type HistoryName } from "../sync/history-names";
import { KEYSLOTS_READ_CAP, MANIFEST_READ_CAP, readRemoteFile } from "../sync/node-reader";
import { PublishRefusedError } from "../sync/publish-refusals";
import { recordLookup, unlockForPull } from "../sync/pull-unlock";
import { readRootState } from "../sync/root-state";
import type { UnlockedVault } from "../sync/vault-keys";
import type { RestoreEntry } from "./restore-dialog-model";

/**
 * What the Restore action reads from the node's version history (task 5.3; spec plugin-pull-ui "Restore an older
 * version"). Everything here is a read, and nothing is written.
 *
 * The names in `manifests/` are a claim made by the node. They order the list and nothing else: the date and device of an
 * entry are shown only when its file is at most 8 MiB and decrypts under this vault's key with a sequence that agrees
 * with its name, and the entry the user chooses is loaded and authenticated again before the confirmation. A file that
 * does not authenticate is listed as unchecked, not hidden, so a withheld or damaged entry stays visible.
 */

/** At most this many names are listed: the newest prefixed ones, then legacy names (no order) while there is room. */
export const RESTORE_LIST_MAX = 20;
/** A history file above this size is listed by name only; it is still authenticated when it is chosen. */
export const RESTORE_DECRYPT_MAX_BYTES = 8 * 1024 * 1024;

export interface HistoryFile {
  readonly parsed: HistoryName;
  readonly entry: MfsEntry;
}

export interface RestoreReader {
  readonly client: Pick<KuboClient, "ipfsLs" | "gatewayStream">;
  readonly keys: VaultKeys;
  readonly vaultId: string;
}

/** The history files of the root, listed: newest first among prefixed names, legacy names after them, at most `RESTORE_LIST_MAX`. */
export async function listHistoryFiles(client: Pick<KuboClient, "ipfsLs">, rootCid: string): Promise<readonly HistoryFile[]> {
  const root = await client.ipfsLs(`/ipfs/${rootCid}`);
  if (!root.some((entry) => entry.name === "manifests" && entry.type === "directory")) return [];
  const files = new Map<string, MfsEntry>();
  for (const entry of await client.ipfsLs(`/ipfs/${rootCid}/manifests`)) if (entry.type === "file" && !files.has(entry.name)) files.set(entry.name, entry);
  const sorted = sortHistoryNames([...files.keys()]);
  const ordered = [...sorted.filter((name) => name.sequence !== undefined).reverse(), ...sorted.filter((name) => name.sequence === undefined)];
  return ordered.slice(0, RESTORE_LIST_MAX).flatMap((parsed) => {
    const entry = files.get(parsed.name);
    return entry === undefined ? [] : [{ parsed, entry }];
  });
}

const DATA_CODES: readonly string[] = ["authentication-failed", "malformed-input", "unsupported-format", "oversize-input"];

/** A node object that is damaged, forged or not ours: a result to show. Anything else (a network or platform failure) is thrown. */
function isDataProblem(error: unknown): boolean {
  if (error instanceof ManifestFormatError || error instanceof OversizeInputError) return true;
  if (error instanceof CryptoError) return DATA_CODES.includes(error.code);
  return error instanceof PublishRefusedError && (error.code === "remote-object-too-large" || error.code === "remote-object-invalid");
}

async function readManifest(reader: RestoreReader, file: HistoryFile): Promise<EncryptedManifest> {
  const bytes = await readRemoteFile(reader.client, file.entry, "a history entry", MANIFEST_READ_CAP);
  return decodeManifestFile(reader.keys, bytes);
}

async function describeOne(reader: RestoreReader, file: HistoryFile): Promise<RestoreEntry> {
  const base = { name: file.parsed.name, sequence: file.parsed.sequence, legacy: file.parsed.sequence === undefined };
  if (file.entry.size > RESTORE_DECRYPT_MAX_BYTES) return { ...base, detail: undefined };
  try {
    const manifest = await readManifest(reader, file);
    if (manifest.vaultId !== reader.vaultId || !prefixMatchesSequence(file.parsed, manifest.sequence)) return { ...base, detail: undefined };
    return { ...base, detail: { publishedAt: manifest.publishedAt, device: manifest.device } };
  } catch (error) {
    if (!isDataProblem(error)) throw error;
    return { ...base, detail: undefined };
  }
}

/** The rows of the list. One file at a time: a file is at most 8 MiB and the plugin's transport holds a whole response. */
export async function describeHistory(reader: RestoreReader, files: readonly HistoryFile[]): Promise<readonly RestoreEntry[]> {
  const rows: RestoreEntry[] = [];
  for (const file of files) rows.push(await describeOne(reader, file));
  return rows;
}

export type ChosenEntry =
  | { readonly kind: "ok"; readonly manifest: EncryptedManifest }
  /** The name says `listed` and the authenticated manifest says `found`: planted or swapped. */
  | { readonly kind: "mismatch"; readonly listed: number; readonly found: number }
  /** It does not authenticate under this vault's key, belongs to another vault, or cannot be read as a manifest. */
  | { readonly kind: "unreadable" };

/** Load and authenticate the chosen entry. Called before the confirmation, so the dialog shows authenticated values only. */
export async function loadChosenEntry(reader: RestoreReader, file: HistoryFile): Promise<ChosenEntry> {
  let manifest: EncryptedManifest;
  try {
    manifest = await readManifest(reader, file);
  } catch (error) {
    if (isDataProblem(error)) return { kind: "unreadable" };
    throw error;
  }
  if (manifest.vaultId !== reader.vaultId) return { kind: "unreadable" };
  const listed = file.parsed.sequence;
  if (listed !== undefined && listed !== manifest.sequence) return { kind: "mismatch", listed, found: manifest.sequence };
  return { kind: "ok", manifest };
}

export interface RestoreUnlockInput {
  readonly client: Pick<KuboClient, "ipfsLs" | "gatewayStream">;
  readonly fs: Pick<HostFs, "read" | "stat">;
  readonly kv: Pick<HostKv, "get">;
  readonly deviceStore: DeviceStore;
  readonly mfsRoot: string;
  /** The root the pull name resolves to. */
  readonly rootCid: string;
  /** A session-held vault: byte-identical slots need no derivation. */
  readonly unlocked?: UnlockedVault;
  readonly passphrase?: CanonicalPassphrase;
  /** Task 2.4: shows the cost of a slot above the default and asks. Absent: such a slot is refused before any derivation. */
  readonly confirmCost?: (costs: readonly KdfParams[]) => Promise<boolean>;
  readonly onProgress?: KdfProgress;
}

/**
 * Unlock the vault for the Restore action's listing, with the same rules as the pull (`unlockForPull`: the local copy
 * first, the node's slots compared byte for byte, a refusal before any derivation). Nothing is written; the pull that
 * follows the confirmation re-opens the vault with the returned `UnlockedVault`, so the passphrase is derived once.
 */
export async function unlockForRestore(input: RestoreUnlockInput): Promise<UnlockedVault> {
  const state = await readRootState(input.kv, input.mfsRoot);
  let listing: Promise<readonly MfsEntry[]> | undefined;
  const entries = (): Promise<readonly MfsEntry[]> => (listing ??= input.client.ipfsLs(`/ipfs/${input.rootCid}`));
  const unlock = await unlockForPull({
    fs: input.fs,
    mfsRoot: input.mfsRoot,
    passphrase: input.passphrase,
    unlocked: input.unlocked,
    local: state === undefined ? { hasState: false } : { hasState: true, vaultId: state.vaultId, keyslotsSha256: state.keyslotsSha256 },
    node: {
      fetchKeySlots: async () => {
        const slots = (await entries()).find((entry) => entry.name === "keyslots.json");
        return slots === undefined ? undefined : readRemoteFile(input.client, slots, "keyslots.json", KEYSLOTS_READ_CAP);
      },
      manifestPresent: async () => (await entries()).some((entry) => entry.name === "manifest.enc" && entry.type === "file"),
    },
    recordFor: recordLookup({ state: stateRecordOf(state, undefined, undefined), deviceStore: input.deviceStore }),
    confirmCost: input.confirmCost,
    onProgress: input.onProgress,
  });
  return unlock.vault;
}
