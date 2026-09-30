import {
  CryptoError,
  createKeySlots,
  parseKeySlots,
  prepareTriedSlots,
  unlockKeySlots,
  utf8,
  type Bytes,
  type CanonicalPassphrase,
  type GeneratedPassphrase,
  type CostPolicy,
  type KdfParams,
  type KdfProgress,
  type ParsedKeySlots,
  type VaultKeys,
} from "../crypto";
import type { HostFs, HostKv } from "../core/host-bridge";
import { ABANDON_HOW } from "./abandon-hint";
import { sha256Hex } from "./hash";
import { LATCH_KEY, recordEncryptedSeen } from "./pull-latch";

/*
 * Vault-key orchestration (mvp-06 task 3.2): unlock and first-time setup over supplied bytes and callbacks.
 * It decides WHEN a key derivation may run; the crypto core decides how. Rules, in order of authority:
 *   1. A local copy of keyslots.json (per MFS root) is the authority. With a copy, unlock is local first: a wrong
 *      passphrase fails before any request. The node's file is compared to the copy byte for byte, and a difference
 *      stops the operation with no derivation on the node's parameters.
 *   2. Without a copy, the recorded state hash (if the state knows this root) is checked against the node's bytes
 *      BEFORE any derivation.
 *   3. A device that knows nothing about the root never derives on node-supplied parameters unless the user asks for
 *      recovery and confirms the cost first. A device with no knowledge, and a manifest.enc on the node, is a new
 *      device and is refused.
 *   4. A vault is created only when the caller says so; a lost node file never leads to a new key.
 * Nothing here tells the user to delete local state.
 */
export const STATE_DIR = ".ipfs-sync";
export const ABANDON_CONFIRMATION = "abandon this vault";

export type VaultKeysErrorCode =
  | "creation-not-requested"
  | "new-device"
  | "slots-without-manifest"
  | "lost-slots"
  | "vault-mismatch"
  | "recover-declined"
  | "abandon-not-confirmed"
  | "locked";

/** An orchestration refusal. Messages are fixed text; they never contain a passphrase, key or path. */
export class VaultKeysError extends Error {
  readonly code: VaultKeysErrorCode;

  constructor(code: VaultKeysErrorCode, message: string) {
    super(message);
    this.name = "VaultKeysError";
    this.code = code;
  }
}

/** First 16 hex characters of sha256(mfsRoot): the per-root suffix of every local file name. */
export async function rootDigest(mfsRoot: string): Promise<string> {
  return (await sha256Hex(utf8(mfsRoot))).slice(0, 16);
}

export async function keySlotsCopyPath(mfsRoot: string): Promise<string> {
  return `${STATE_DIR}/keyslots.${await rootDigest(mfsRoot)}.json`;
}

/** What the local state (task 3.3) knows about this MFS root. */
export interface LocalRootKnowledge {
  /** The state for this root exists: the root held a vault published from this device. */
  readonly hasState: boolean;
  /** Recorded in the state. */
  readonly vaultId?: string;
  readonly keyslotsSha256?: string;
}

/** Node reads, supplied by the caller. Each is a request; they are called only when the rules allow one. */
export interface NodeAccess {
  /** `keyslots.json` of the root, already size-bounded by the caller (stat before read, 16 KiB cap), or `undefined`. */
  fetchKeySlots(): Promise<Uint8Array | undefined>;
  manifestPresent(): Promise<boolean>;
}

/**
 * An already unlocked vault, held by a plugin session (mvp-06 task 4.2). It carries the non-extractable key set and the
 * exact key-slot bytes it was unlocked from; nothing here is a passphrase or raw key material. Public data only, apart
 * from the `VaultKeys` object itself.
 */
export interface UnlockedVault {
  readonly keys: VaultKeys;
  readonly vaultId: string;
  /** The canonical bytes of `keyslots.json` the keys were unlocked from. */
  readonly keySlots: Bytes;
  readonly keySlotsSha256: string;
}

/**
 * Every UnlockedVault that `openVault` may trust was minted by `toUnlockedVault`. The registry is module-private, so a
 * structurally identical object (a spread copy, a cast literal) is not accepted in its place (mvp-06 review 5, R5-06).
 */
const MINTED = new WeakSet<object>();

/** What a session keeps of an opened vault: the keys and the identity of the slots, never the passphrase. */
export function toUnlockedVault(opened: OpenedVault): UnlockedVault {
  const vault: UnlockedVault = { keys: opened.keys, vaultId: opened.vaultId, keySlots: new Uint8Array(opened.keySlots), keySlotsSha256: opened.keySlotsSha256 };
  MINTED.add(vault);
  return vault;
}

/** The held keys are used only when the vault was minted here and its keys belong to the slots being opened. */
function assertHeldVaultApplies(unlocked: UnlockedVault, document: ParsedKeySlots): void {
  if (!MINTED.has(unlocked)) throw new VaultKeysError("vault-mismatch", "the held vault was not produced by an unlock in this module; it was refused and nothing was derived");
  if (unlocked.keys.vaultId !== document.vaultId || unlocked.vaultId !== document.vaultId) {
    throw new VaultKeysError("vault-mismatch", "the held vault's keys belong to a different vault than these key slots; it was refused and nothing was derived");
  }
}

export interface OpenVaultInput {
  readonly fs: Pick<HostFs, "read" | "write" | "stat">;
  readonly mfsRoot: string;
  /** Required unless `unlocked` covers the slots being opened; never logged or stored. */
  readonly passphrase?: CanonicalPassphrase;
  /**
   * Keys the host unlocked earlier in this session. When the key-slot bytes to open are byte-identical to
   * `unlocked.keySlots`, these keys are used and no Argon2id derivation runs; every comparison and refusal rule
   * above still applies. Any other slot bytes need `passphrase`.
   */
  readonly unlocked?: UnlockedVault;
  readonly local: LocalRootKnowledge;
  readonly node: NodeAccess;
  /**
   * The explicit request to create a vault (`--init`, or the setup dialog), carrying the passphrase that
   * `generatePassphrase` produced. It must be the same secret as `passphrase`.
   */
  readonly create?: GeneratedPassphrase;
  /** The explicit recovery request (`--recover-slots`). */
  readonly recoverSlots?: boolean;
  /** Shows the cost of the slots to be derived and asks; recovery proceeds only on `true`. Required for recovery. */
  readonly confirmRecover?: (costs: readonly KdfParams[]) => Promise<boolean>;
  /** Slots above the default cost are refused unless `approveCost` allows them (interactive hosts only). */
  readonly costPolicy?: CostPolicy;
  readonly createParams?: KdfParams;
  readonly onProgress?: KdfProgress;
}

export type VaultOrigin = "local-copy" | "state-hash" | "recovered" | "created" | "resumed-creation";

export interface OpenedVault {
  readonly keys: VaultKeys;
  readonly vaultId: string;
  /** The canonical bytes of `keyslots.json`. */
  readonly keySlots: Bytes;
  readonly keySlotsSha256: string;
  readonly origin: VaultOrigin;
  /** True when the node has no `keyslots.json` yet: the publisher must write these bytes FIRST. */
  readonly writeKeySlotsToNode: boolean;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function readCopy(fs: OpenVaultInput["fs"], path: string): Promise<Bytes | undefined> {
  return (await fs.stat(path))?.kind === "file" ? fs.read(path) : undefined;
}

async function persistCopy(fs: OpenVaultInput["fs"], path: string, bytes: Bytes): Promise<void> {
  await fs.write(path, bytes);
}

async function finish(parsedBytes: Bytes, document: ParsedKeySlots, keys: VaultKeys, origin: VaultOrigin, writeToNode: boolean): Promise<OpenedVault> {
  return { keys, vaultId: document.vaultId, keySlots: parsedBytes, keySlotsSha256: await sha256Hex(parsedBytes), origin, writeKeySlotsToNode: writeToNode };
}

async function unlockBytes(input: OpenVaultInput, bytes: Bytes, policy: CostPolicy | undefined): Promise<{ document: ParsedKeySlots; keys: VaultKeys }> {
  const document = parseKeySlots(bytes);
  if (input.unlocked !== undefined && sameBytes(input.unlocked.keySlots, bytes)) {
    assertHeldVaultApplies(input.unlocked, document);
    return { document, keys: input.unlocked.keys };
  }
  if (input.passphrase === undefined) throw new VaultKeysError("locked", "the vault is locked and no passphrase was supplied; nothing was derived");
  const { keys } = await unlockKeySlots({ document, passphrase: input.passphrase, onProgress: input.onProgress, costPolicy: policy });
  return { document, keys };
}

/* ---------- with a local copy ---------- */

async function openWithCopy(input: OpenVaultInput, copy: Bytes): Promise<OpenedVault> {
  const parsed = parseKeySlots(copy);
  const recorded = input.local;
  if ((recorded.vaultId !== undefined && recorded.vaultId !== parsed.vaultId) || (recorded.keyslotsSha256 !== undefined && recorded.keyslotsSha256 !== (await sha256Hex(copy)))) {
    throw new VaultKeysError("vault-mismatch", "the local key-slot copy does not match the recorded vault; nothing was sent to the node");
  }
  // Local first: a wrong passphrase fails here, before any request to the node.
  const { keys } = await unlockBytes(input, copy, input.costPolicy);
  const remote = await input.node.fetchKeySlots();
  if (remote === undefined) return resumeOrLost(input, copy, parsed, keys);
  if (!sameBytes(remote, copy)) {
    throw new VaultKeysError("vault-mismatch", "the node's key slots differ from this device's copy; no derivation was run on the node's parameters and nothing was written");
  }
  return finish(copy, parsed, keys, "local-copy", false);
}

async function resumeOrLost(input: OpenVaultInput, copy: Bytes, parsed: ParsedKeySlots, keys: VaultKeys): Promise<OpenedVault> {
  if (input.local.hasState || (await input.node.manifestPresent())) {
    throw new VaultKeysError("lost-slots", "the node no longer holds this vault's key slots; no new key was generated. To start a new vault in an empty root, " + ABANDON_HOW + " first");
  }
  // First publish interrupted before the slots reached the node: same key, write the same bytes again.
  return finish(copy, parsed, keys, "resumed-creation", true);
}

/* ---------- without a local copy ---------- */

async function openFromNode(input: OpenVaultInput, copyPath: string, remote: Uint8Array): Promise<OpenedVault> {
  const bytes = new Uint8Array(remote);
  const recordedHash = input.local.hasState ? input.local.keyslotsSha256 : undefined;
  if (recordedHash !== undefined) {
    if (recordedHash !== (await sha256Hex(bytes))) {
      throw new VaultKeysError("vault-mismatch", "the node's key slots differ from the recorded ones; no derivation was run and nothing was written");
    }
    return unlockAndKeep(input, copyPath, bytes, "state-hash", input.costPolicy);
  }
  if (await input.node.manifestPresent()) {
    throw new VaultKeysError("new-device", "this device is not the publisher of the vault in this root, and pulling encrypted vaults arrives in the next change; nothing was derived or written");
  }
  if (input.recoverSlots !== true || input.confirmRecover === undefined) {
    throw new VaultKeysError("slots-without-manifest", "the root holds key slots but no manifest and this device knows nothing about it; use a new MFS root, or ask for recovery explicitly (--recover-slots)");
  }
  const costs = prepareTriedSlots(parseKeySlots(bytes)).map((slot) => slot.params);
  if ((await input.confirmRecover(costs)) !== true) throw new VaultKeysError("recover-declined", "recovery was not confirmed; no derivation was run");
  return unlockAndKeep(input, copyPath, bytes, "recovered", { approveCost: async () => true });
}

async function unlockAndKeep(input: OpenVaultInput, copyPath: string, bytes: Bytes, origin: VaultOrigin, policy: CostPolicy | undefined): Promise<OpenedVault> {
  const { document, keys } = await unlockBytes(input, bytes, policy);
  await persistCopy(input.fs, copyPath, bytes);
  return finish(bytes, document, keys, origin, false);
}

async function createVault(input: OpenVaultInput, copyPath: string): Promise<OpenedVault> {
  const generated = input.create as GeneratedPassphrase;
  const typed = input.passphrase;
  if (typed === undefined || generated.length !== typed.length || generated.some((byte, index) => byte !== typed[index])) {
    throw new CryptoError("invalid-argument", "the passphrase to create a vault with is not the generated one");
  }
  const created = await createKeySlots({ passphrase: generated, params: input.createParams, onProgress: input.onProgress });
  // The local copy goes first: if the node write then fails, the rerun resumes with this same key.
  await persistCopy(input.fs, copyPath, created.bytes);
  return finish(created.bytes, created.document, created.keys, "created", true);
}

/**
 * Unlock or create the vault for one MFS root. The order of requests and derivations is the security property; see the
 * header. Errors: `VaultKeysError` for orchestration refusals, `CryptoError` for wrong passphrase, format or cost.
 */
export async function openVault(input: OpenVaultInput): Promise<OpenedVault> {
  const copyPath = await keySlotsCopyPath(input.mfsRoot);
  const copy = await readCopy(input.fs, copyPath);
  if (copy !== undefined) return openWithCopy(input, copy);
  const remote = await input.node.fetchKeySlots();
  if (remote !== undefined) return openFromNode(input, copyPath, remote);
  if (input.local.hasState || (await input.node.manifestPresent())) {
    throw new VaultKeysError("lost-slots", "the node no longer holds this vault's key slots; no new key was generated. To start a new vault in an empty root, " + ABANDON_HOW + " first");
  }
  if (input.create === undefined) throw new VaultKeysError("creation-not-requested", "this root holds no vault; creating one needs an explicit request (--init, or the setup dialog)");
  return createVault(input, copyPath);
}

/* ---------- abandon ---------- */

export interface AbandonInput {
  /** `read` and `write` are for the downgrade latch (`encrypted-seen.json` in the same `.ipfs-sync/` folder the hosts' key-value store uses). */
  readonly fs: Pick<HostFs, "stat" | "rename" | "read" | "write">;
  readonly mfsRoot: string;
  /** Must equal `ABANDON_CONFIRMATION`, typed by the user. */
  readonly confirmation: string;
  readonly nowMs: number;
}

/** The latch file, reached through the file capability at the path the hosts' key-value store uses. */
function latchStore(fs: AbandonInput["fs"]): Pick<HostKv, "get" | "set"> {
  const path = `${STATE_DIR}/${LATCH_KEY}`;
  return {
    get: async () => ((await fs.stat(path))?.kind === "file" ? fs.read(path) : undefined),
    set: async (_key, value) => fs.write(path, value),
  };
}

/**
 * Move this root's local key-slot copy, state and journal into a backup folder. The node is never touched (there is no
 * node parameter), and the user can then start a new vault in an empty MFS root. Before anything moves, the
 * encrypted-seen latch is recorded, so abandoning cannot re-open the plaintext-v1 reader for this destination (R5-02).
 */
export async function abandonVault(input: AbandonInput): Promise<{ readonly backupDir: string; readonly moved: readonly string[] }> {
  if (input.confirmation !== ABANDON_CONFIRMATION) throw new VaultKeysError("abandon-not-confirmed", `type "${ABANDON_CONFIRMATION}" to confirm; nothing was moved`);
  const digest = await rootDigest(input.mfsRoot);
  const backupDir = `${STATE_DIR}/abandoned-${digest}-${input.nowMs}`;
  const present: string[] = [];
  for (const kind of ["keyslots", "state", "journal"]) {
    if ((await input.fs.stat(`${STATE_DIR}/${kind}.${digest}.json`)) !== undefined) present.push(kind);
  }
  if (present.length === 0) return { backupDir, moved: [] };
  await recordEncryptedSeen(latchStore(input.fs), { ipnsName: "", mfsRoot: input.mfsRoot, key: "abandon", at: new Date(input.nowMs).toISOString() });
  const moved: string[] = [];
  for (const kind of present) {
    const from = `${STATE_DIR}/${kind}.${digest}.json`;
    await input.fs.rename(from, `${backupDir}/${kind}.json`);
    moved.push(from);
  }
  return { backupDir, moved };
}
