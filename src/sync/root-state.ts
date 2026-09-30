import type { Bytes, HostKv } from "../core/host-bridge";
import type { EncryptedManifest } from "./encrypted-manifest";
import { CID_TOKEN, HEX32, HEX64, RootStateError, parseJsonObject, parseManifestField, parseMtimes, requireText } from "./local-record";
import { rootFileNames } from "./root-files";
import { stableStringify } from "./stable-json";

/**
 * Per-root local state of an encrypted publish (format 2), kept as `.ipfs-sync/state.<h>.json`. It records what the
 * last completed publish to one MFS root left behind. It is plaintext at rest (it holds vault paths), so the
 * `.ipfs-sync/` folder must stay out of third-party sync and backups. Deleting the folder resets it, including
 * the `encryptedSeen` latch. Format 1 (`state.json`, the pull record) is a different file and is ignored here.
 */

export const ROOT_STATE_VERSION = 2;

export interface RootState {
  readonly version: typeof ROOT_STATE_VERSION;
  readonly mfsRoot: string;
  /** IPNS key name the root was last published under. */
  readonly key: string;
  /** CID of `<mfsRoot>` last published to IPNS by this device; null until the first publish completes (or after adopting an interrupted one). */
  readonly rootCid: string | null;
  /** 32 lowercase hex characters. */
  readonly vaultId: string;
  /** Lowercase hex sha256 of the local key-slot copy this state was written under. */
  readonly keyslotsSha256: string;
  /** Sequence of `manifest`; equals `manifest.sequence`. */
  readonly sequence: number;
  /** Plaintext manifest v2 including blob CIDs. */
  readonly manifest: EncryptedManifest;
  /** Modification time of every published file, for the size/mtime pre-filter. */
  readonly mtimes: Readonly<Record<string, number>>;
  /** Latch: this root held encrypted content. Set by every write of this state and never cleared by code. */
  readonly encryptedSeen: true;
}

export { RootStateError };

export type RootStateInput = Omit<RootState, "version" | "encryptedSeen">;

export function buildRootState(input: RootStateInput): RootState {
  return { version: ROOT_STATE_VERSION, encryptedSeen: true, ...input };
}

export function encodeRootState(state: RootState): Bytes {
  return new TextEncoder().encode(`${stableStringify(state, 2)}\n`);
}

export function decodeRootState(bytes: Bytes): RootState {
  const record = parseJsonObject(bytes, "state");
  if (record["version"] !== ROOT_STATE_VERSION) throw new RootStateError(`state format ${String(record["version"])} is not supported by this version`);
  if (record["encryptedSeen"] !== true) throw new RootStateError("state does not carry the encryptedSeen latch");
  const rootCid = record["rootCid"];
  if (rootCid !== null && (typeof rootCid !== "string" || !CID_TOKEN.test(rootCid))) throw new RootStateError('state field "rootCid" is malformed');
  const manifest = parseManifestField(record["manifest"], "state");
  const sequence = record["sequence"];
  if (typeof sequence !== "number" || sequence !== manifest.sequence) throw new RootStateError("state sequence does not match its manifest");
  const vaultId = requireText(record, "vaultId", HEX32, "state");
  if (vaultId !== manifest.vaultId) throw new RootStateError("state vaultId does not match its manifest");
  return buildRootState({
    mfsRoot: requireText(record, "mfsRoot", undefined, "state"),
    key: requireText(record, "key", undefined, "state"),
    rootCid,
    vaultId,
    keyslotsSha256: requireText(record, "keyslotsSha256", HEX64, "state"),
    sequence,
    manifest,
    mtimes: parseMtimes(record["mtimes"], "state"),
  });
}

/**
 * The state file for `mfsRoot`, or undefined when there is none. A file that names another root (copied by
 * hand) is refused rather than trusted.
 */
export async function readRootState(kv: Pick<HostKv, "get">, mfsRoot: string): Promise<RootState | undefined> {
  const bytes = await kv.get(rootFileNames(mfsRoot).state);
  if (bytes === undefined) return undefined;
  const state = decodeRootState(bytes);
  if (state.mfsRoot !== mfsRoot) throw new RootStateError("the state file names a different MFS root");
  return state;
}

export async function writeRootState(kv: Pick<HostKv, "set">, state: RootState): Promise<void> {
  await kv.set(rootFileNames(state.mfsRoot).state, encodeRootState(state));
}
