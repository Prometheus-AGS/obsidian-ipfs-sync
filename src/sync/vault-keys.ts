import {
  CryptoError,
  createKeySlots,
  exceedsDefaultCost,
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
import type { DeviceStore } from "./device-store";
import { sha256Hex } from "./hash";
import { PLAINTEXT_UNSUPPORTED_MESSAGE } from "./pull-errors";
import { SequenceFloorError, readFloor } from "./sequence-floor";

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
  | "locked"
  | "no-key-slots"
  /** The root lists a `manifest.json` and holds no key slots: a plaintext publication, which no code path of this version reads. */
  | "plaintext-root";

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
  /**
   * Whether the root's listing names a `manifest.json`. Pull-mode only, asked when the root holds no key slots, to tell a plaintext
   * publication from an empty or unknown root. A listing check: the file is never requested, and nothing it holds is read.
   */
  plaintextManifestPresent?(): Promise<boolean>;
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
export function toUnlockedVault(opened: Pick<OpenedVault, "keys" | "vaultId" | "keySlots" | "keySlotsSha256">): UnlockedVault {
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

async function readCopy(fs: Pick<HostFs, "read" | "stat">, path: string): Promise<Bytes | undefined> {
  return (await fs.stat(path))?.kind === "file" ? fs.read(path) : undefined;
}

async function persistCopy(fs: OpenVaultInput["fs"], path: string, bytes: Bytes): Promise<void> {
  await fs.write(path, bytes);
}

async function finish(parsedBytes: Bytes, document: ParsedKeySlots, keys: VaultKeys, origin: VaultOrigin, writeToNode: boolean): Promise<OpenedVault> {
  return { keys, vaultId: document.vaultId, keySlots: parsedBytes, keySlotsSha256: await sha256Hex(parsedBytes), origin, writeKeySlotsToNode: writeToNode };
}

async function unlockBytes(
  input: Pick<OpenVaultInput, "unlocked" | "passphrase" | "onProgress">,
  bytes: Bytes,
  policy: CostPolicy | undefined,
): Promise<{ document: ParsedKeySlots; keys: VaultKeys }> {
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

/** The copy must be the one the state recorded: same vault, same digest. Checked before any derivation or request. */
async function assertCopyMatchesRecord(recorded: LocalRootKnowledge, parsed: ParsedKeySlots, copy: Bytes): Promise<void> {
  if ((recorded.vaultId !== undefined && recorded.vaultId !== parsed.vaultId) || (recorded.keyslotsSha256 !== undefined && recorded.keyslotsSha256 !== (await sha256Hex(copy)))) {
    throw new VaultKeysError("vault-mismatch", "the local key-slot copy does not match the recorded vault; nothing was sent to the node");
  }
}

async function openWithCopy(input: OpenVaultInput, copy: Bytes): Promise<OpenedVault> {
  const parsed = parseKeySlots(copy);
  await assertCopyMatchesRecord(input.local, parsed, copy);
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
    throw new VaultKeysError("new-device", 'this device is not the publisher of the vault in this root; to restore it here, run "ipfs-sync pull" (plugin: the Pull command) with the vault passphrase; nothing was derived or written');
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

/* ---------- pull: open a vault without writing anything (mvp-07a task 4.1) ---------- */

/** How a refusal names the key-management action that replaces the local copy with changed slots. */
export const ACCEPT_SLOTS_HOW = 'accept them with the accept-slots action of key management ("ipfs-sync keys accept-slots") before pulling';

const PULL_SLOTS_DIFFER = `the node's key slots differ from this device's copy; no derivation was run on the node's parameters and nothing was written. If the change is expected (a passphrase change on another device), ${ACCEPT_SLOTS_HOW}`;
const PULL_SLOTS_RECORDED_DIFFER = `the node's key slots differ from the ones this device recorded; no derivation was run and nothing was written. If the change is expected, ${ACCEPT_SLOTS_HOW}`;
const PULL_NO_SLOTS = "the target holds no key slots: it is not an encrypted vault, or it lost its key slots; nothing was derived or written";

/** The refusal for a root without key slots: a plaintext publication when the listing names `manifest.json`, otherwise an empty, unknown or slot-less root. */
async function absentSlotsError(node: NodeAccess): Promise<VaultKeysError> {
  if ((await node.plaintextManifestPresent?.()) === true) return new VaultKeysError("plaintext-root", PLAINTEXT_UNSUPPORTED_MESSAGE);
  return new VaultKeysError("no-key-slots", PULL_NO_SLOTS);
}

const PULL_NO_MANIFEST ="the root holds key slots but no manifest.enc: the manifest is withheld or not yet published; the vault was treated as neither empty nor creatable, and nothing was derived or written";

export interface PullOpenInput {
  /** Read-only on purpose: the pull-mode open never persists the key-slot copy. */
  readonly fs: Pick<HostFs, "read" | "stat">;
  readonly mfsRoot: string;
  /** Required unless `unlocked` covers the slots being opened; never logged or stored. */
  readonly passphrase?: CanonicalPassphrase;
  /** A session-held vault: byte-identical slots bypass the derivation exactly as in `openVault`. */
  readonly unlocked?: UnlockedVault;
  readonly local: LocalRootKnowledge;
  readonly node: NodeAccess;
  /**
   * Runs on the parsed slots of whichever file will be derived from (the local copy, or the node's file) BEFORE any
   * request that depends on it and before any derivation. A throw stops the open with the counter untouched. This is
   * where `--expect-vault-id` and the sequence floor are compared with the slot file's `vaultId`.
   */
  readonly beforeDerivation?: (document: ParsedKeySlots) => void | Promise<void>;
  /**
   * Interactive hosts only: shows the cost of every slot that will be tried and asks once. Without it (non-interactive
   * hosts), or on `false` or a throw, a slot file above the default cost is refused before any derivation.
   */
  readonly confirmCost?: (costs: readonly KdfParams[]) => Promise<boolean>;
  readonly onProgress?: KdfProgress;
}

export type PullOrigin = "local-copy" | "state-hash" | "node-slots";

export interface PulledVault {
  readonly keys: VaultKeys;
  readonly vaultId: string;
  /** The canonical bytes of the `keyslots.json` the keys were unlocked from. */
  readonly keySlots: Bytes;
  readonly keySlotsSha256: string;
  readonly origin: PullOrigin;
  /**
   * The bytes the caller stores as this device's key-slot copy, and only after the manifest authenticated and any
   * confirmation was given. `undefined` when the device already holds a copy (and it equals the node's file).
   */
  readonly copyToStore: Bytes | undefined;
}

/** Cost confirmation for the slots about to be derived. A held vault that covers the bytes derives nothing and asks nothing. */
async function pullCostPolicy(input: PullOpenInput, document: ParsedKeySlots, bytes: Bytes): Promise<CostPolicy | undefined> {
  if (input.unlocked !== undefined && sameBytes(input.unlocked.keySlots, bytes)) return undefined;
  // No passphrase: nothing will be derived (the open ends as `locked`), so there is nothing to approve. A host that prompts for the passphrase
  // after a `locked` stop would otherwise show the cost question twice, the first time before it has even asked for the passphrase.
  if (input.passphrase === undefined) return undefined;
  const costs = prepareTriedSlots(document).map((slot) => slot.params);
  if (!costs.some(exceedsDefaultCost) || input.confirmCost === undefined) return undefined;
  let approved = false;
  try {
    approved = (await input.confirmCost(costs)) === true;
  } catch {
    approved = false; // a callback that throws is a refusal, never an approval
  }
  return approved ? { approveCost: async () => true } : undefined;
}

async function pullWithCopy(input: PullOpenInput, copy: Bytes): Promise<PulledVault> {
  const parsed = parseKeySlots(copy);
  await assertCopyMatchesRecord(input.local, parsed, copy);
  await input.beforeDerivation?.(parsed);
  // Local first: a wrong passphrase fails here, before any request to the node.
  const { keys } = await unlockBytes(input, copy, await pullCostPolicy(input, parsed, copy));
  const remote = await input.node.fetchKeySlots();
  if (remote === undefined) throw await absentSlotsError(input.node);
  if (!sameBytes(remote, copy)) throw new VaultKeysError("vault-mismatch", PULL_SLOTS_DIFFER);
  if (!(await input.node.manifestPresent())) throw new VaultKeysError("slots-without-manifest", PULL_NO_MANIFEST);
  return { keys, vaultId: parsed.vaultId, keySlots: copy, keySlotsSha256: await sha256Hex(copy), origin: "local-copy", copyToStore: undefined };
}

async function pullFromNode(input: PullOpenInput, remote: Uint8Array): Promise<PulledVault> {
  const bytes = new Uint8Array(remote);
  const parsed = parseKeySlots(bytes);
  await input.beforeDerivation?.(parsed);
  const recorded = input.local.hasState ? input.local : undefined;
  if (recorded?.vaultId !== undefined && recorded.vaultId !== parsed.vaultId) {
    throw new VaultKeysError("vault-mismatch", "the node's key slots belong to a different vault than the one this directory recorded; no derivation was run and nothing was written");
  }
  const sha = await sha256Hex(bytes);
  if (recorded?.keyslotsSha256 !== undefined && recorded.keyslotsSha256 !== sha) throw new VaultKeysError("vault-mismatch", PULL_SLOTS_RECORDED_DIFFER);
  // Slots without a manifest are refused before any derivation on node-supplied parameters (review 0.2, N-08).
  if (!(await input.node.manifestPresent())) throw new VaultKeysError("slots-without-manifest", PULL_NO_MANIFEST);
  const { keys } = await unlockBytes(input, bytes, await pullCostPolicy(input, parsed, bytes));
  return { keys, vaultId: parsed.vaultId, keySlots: bytes, keySlotsSha256: sha, origin: recorded?.keyslotsSha256 === undefined ? "node-slots" : "state-hash", copyToStore: bytes };
}

/**
 * Unlock the vault for a pull. Same authority order as `openVault` (a local copy first, a wrong passphrase makes no
 * request; the node's file is compared byte for byte; a difference stops with no derivation on the node's parameters),
 * with these differences: nothing is written (the copy to store is returned, not persisted); a root without a
 * manifest is refused before any derivation; the new-device case is allowed, subject to the format bounds, the
 * `beforeDerivation` checks and the cost confirmation. Errors: `VaultKeysError`, `CryptoError`, and whatever
 * `beforeDerivation` throws.
 */
export async function openVaultForPull(input: PullOpenInput): Promise<PulledVault> {
  const copy = await readCopy(input.fs, await keySlotsCopyPath(input.mfsRoot));
  if (copy !== undefined) return pullWithCopy(input, copy);
  const remote = await input.node.fetchKeySlots();
  if (remote === undefined) throw await absentSlotsError(input.node);
  return pullFromNode(input, remote);
}

/** Write the key-slot copy of a pull. Separate from the open so that the caller decides when (task 4.1: after authentication). */
export async function persistKeySlotsCopy(fs: Pick<HostFs, "write">, mfsRoot: string, bytes: Bytes): Promise<void> {
  await fs.write(await keySlotsCopyPath(mfsRoot), bytes);
}

/* ---------- abandon ---------- */

export interface AbandonInput {
  /** `read` is for the vault id the local files name (to look up the floor); abandon writes nothing, it only renames. */
  readonly fs: Pick<HostFs, "stat" | "rename" | "read">;
  readonly mfsRoot: string;
  /** Must equal `ABANDON_CONFIRMATION`, typed by the user. */
  readonly confirmation: string;
  readonly nowMs: number;
  /** The device-local store. Only read, to report the sequence floor that abandon keeps; abandon never writes or moves it. */
  readonly deviceStore?: DeviceStore;
}

/**
 * The sequence floor for the abandoned vault, as found in the device store before anything moved. `not-looked-up`: the files name no vault id,
 * so no floor was asked for. `unavailable`: the device store could not be opened or read (any error); the move went on.
 */
export type AbandonFloor =
  | { readonly status: "kept"; readonly vaultId: string; readonly sequence: number }
  | { readonly status: "none" }
  | { readonly status: "not-looked-up" }
  | { readonly status: "unavailable" }
  | { readonly status: "unreadable" };

/** The line the CLI prints and the plugin notice repeats: one wording for both. Fixed text: no error message is read. */
export function describeAbandonFloor(floor: AbandonFloor): string {
  if (floor.status === "kept") return `sequence floor kept: ${floor.sequence}`;
  if (floor.status === "none") return "sequence floor kept: none (this device has no floor for the vault)";
  if (floor.status === "not-looked-up") return "sequence floor kept: not looked up (the vault id is no longer on this device)";
  if (floor.status === "unavailable") return "sequence floor kept: not read (the floor could not be read from the device store; abandon did not change it)";
  return "sequence floor kept: unreadable (the floor file is damaged and could not be read; abandon did not change it)";
}

/** The fixed statement for a move that stopped part-way: counts only, never an operating-system message. */
export function partialMoveLine(moved: number, total: number): string {
  return `${moved} of ${total} files were moved. Run abandon again to move the rest.`;
}

/**
 * A rename failed after at least one file had moved: this device's files for the root are split between the live folder and the backup. It carries
 * the counts and the kind names that moved (`keyslots`, `state`, `journal`, `maintenance`), and no cause or message from the failure.
 */
export class AbandonPartialMoveError extends Error {
  readonly moved: number;
  readonly total: number;
  readonly kinds: readonly string[];

  constructor(kinds: readonly string[], total: number) {
    super(partialMoveLine(kinds.length, total));
    this.name = "AbandonPartialMoveError";
    this.moved = kinds.length;
    this.total = total;
    this.kinds = kinds;
  }
}

const HEX32 = /^[0-9a-f]{32}$/;

/** The vault id this root's files name: the key-slot copy first, else the state. `undefined` when neither parses (the files are about to be moved, not trusted). */
async function localVaultId(fs: AbandonInput["fs"], digest: string, present: readonly string[]): Promise<string | undefined> {
  if (present.includes("keyslots")) {
    try {
      return parseKeySlots(await fs.read(`${STATE_DIR}/keyslots.${digest}.json`)).vaultId;
    } catch {
      // Not a key-slot document: fall through to the state.
    }
  }
  if (!present.includes("state")) return undefined;
  try {
    const vaultId = (JSON.parse(new TextDecoder().decode(await fs.read(`${STATE_DIR}/state.${digest}.json`))) as { vaultId?: unknown }).vaultId;
    return typeof vaultId === "string" && HEX32.test(vaultId) ? vaultId : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only: the floor for the vault these files belong to. A damaged floor file is reported, never repaired. */
async function floorKept(input: AbandonInput, digest: string, present: readonly string[]): Promise<AbandonFloor> {
  if (input.deviceStore === undefined) return { status: "none" };
  const vaultId = await localVaultId(input.fs, digest, present);
  if (vaultId === undefined) return { status: "not-looked-up" };
  try {
    const entry = await readFloor(input.deviceStore, vaultId);
    return entry === undefined ? { status: "none" } : { status: "kept", vaultId, sequence: entry.sequence };
  } catch (error) {
    if (error instanceof SequenceFloorError) return { status: "unreadable" };
    // Any other failure of the store (no home directory, a permission error, a damaged entry) must not stop the escape hatch: its message is not read.
    return { status: "unavailable" };
  }
}

/**
 * Move this root's local key-slot copy, state and journal into a backup folder. The node is never touched (there is no
 * node parameter), and the user can then start a new vault in an empty MFS root. No latch is recorded: no code path
 * reads a plaintext manifest, and the sequence floor is the downgrade evidence. The floor lives in the device store,
 * which abandon only reads (before moving anything) to report it.
 */
export async function abandonVault(
  input: AbandonInput,
): Promise<{ readonly backupDir: string; readonly moved: readonly string[]; readonly floor: AbandonFloor }> {
  if (input.confirmation !== ABANDON_CONFIRMATION) throw new VaultKeysError("abandon-not-confirmed", `type "${ABANDON_CONFIRMATION}" to confirm; nothing was moved`);
  const digest = await rootDigest(input.mfsRoot);
  const backupDir = `${STATE_DIR}/abandoned-${digest}-${input.nowMs}`;
  const present: string[] = [];
  // `maintenance` too: a pending key-management journal that stayed behind would block publish and pull on the new vault in the same root.
  for (const kind of ["keyslots", "state", "journal", "maintenance"]) {
    if ((await input.fs.stat(`${STATE_DIR}/${kind}.${digest}.json`)) !== undefined) present.push(kind);
  }
  if (present.length === 0) return { backupDir, moved: [], floor: { status: "none" } };
  const floor = await floorKept(input, digest, present);
  const moved: string[] = [];
  for (const kind of present) {
    const from = `${STATE_DIR}/${kind}.${digest}.json`;
    try {
      await input.fs.rename(from, `${backupDir}/${kind}.json`);
    } catch (error) {
      // After the first file the vault state has changed: say so with counts only. A failure before any move surfaces as it always did.
      if (moved.length === 0) throw error;
      throw new AbandonPartialMoveError(present.slice(0, moved.length), present.length);
    }
    moved.push(from);
  }
  return { backupDir, moved, floor };
}
