import type { Bytes } from "../core/host-bridge";
import { CryptoError, OversizeInputError, type VaultKeys } from "../crypto";
import { KuboHttpError, KuboResponseTooLargeError, type MfsEntry } from "../kubo";
import { decodeManifestFile, ManifestFormatError, type EncryptedManifest } from "./encrypted-manifest";
import { guardKv } from "./guarded-kv";
import { junkNames } from "./history-check";
import { historyFileName, parseHistoryName, prefixMatchesSequence, sortHistoryNames, type HistoryName } from "./history-names";
import { isUnreadableManifest } from "./manifest-auth";
import { openCurrentVault, pendingMaintenance, type KeyManagementDeps, type KeyManagementInput } from "./key-management";
import {
  assertNoPublishJournal,
  buildPruneJournal,
  discardMaintenanceJournal,
  reached,
  writeMaintenanceJournal,
  type MaintenanceJournal,
  type MaintenancePhase,
  type PruneJournal,
} from "./maintenance-journal";
import { escapeForDisplay } from "./path-policy";
import { MAINTENANCE_WAYS_OUT, PublishRefusedError, ReadBackError, historyJunk, maintenancePending, publicationKeyMissing } from "./publish-refusals";
import { beginMaintenance, driveMaintenance, type MaintenanceStart, type RepublishDeps } from "./republish-root";
import { readFloor } from "./sequence-floor";
import type { OpenedVault } from "./vault-keys";

/**
 * `prune-history` (mvp-07b task 1.6): remove the oldest files under `manifests/` of the working MFS tree, then republish the tree through the shared
 * primitive (`republish-root.ts`) without a new manifest, a new sequence or a new history file. WebView-safe: no Node imports, every effect goes through
 * a port in `PruneDeps`; `cli/prune-command.ts` is a thin caller.
 *
 * What may be removed is decided by NAMES alone (`planPrune`, a pure function): the order of the names is the order of the publishes (07a, `history-names.ts`),
 * so no old file is decrypted. What makes that safe is decided by AUTHENTICATION of the newest files, before anything is removed: a node that lists crafted
 * names, withholds the newest files or plants a future one is refused, because the names it lists are then not a statement about what was published.
 *
 *   prepare  (reads only)  no pending journal of either kind; the device is up to date and not below its floor (`beginMaintenance`); `manifests/` is listed
 *                          (a folder too large to list, or one holding anything but history files, is refused); the plan; then the newest 20 prefixed
 *                          files are decrypted: the newest one carries the node manifest's sequence, every one authenticates for this vault and agrees
 *                          with its prefix. A plan that removes nothing needs none of that and stops there.
 *   execute                the maintenance journal at `journaled`, then `driveMaintenance` (one history name removed at a time, snapshot, read-back through
 *                          the immutable path, pin, name re-check, `name/publish`, `state.rootCid`), then the journal is removed.
 *   resume                 reads the phase. Before `published` it finishes the republish (the vault key is needed to check the snapshot); from `published`
 *                          on it needs no passphrase and only removes the journal.
 *
 * The caller holds `publish.lock` for the whole operation; every local write is behind `assertHeld`, every node write behind the node's `beforeWrite`.
 */

/** The newest entries that are always kept, and the newest prefixed entries that must authenticate before anything is removed. */
export const HISTORY_KEEP_FLOOR = 20;

/* ---------- the removal set ---------- */

export interface PrunePlanOptions {
  /** The count the person asked to keep (files). Raised to `HISTORY_KEEP_FLOOR`. A positive whole number. */
  readonly keep: number;
  /** Prefixed entries at these sequences are never removed (every file at the sequence, a fork leaves more than one). */
  readonly protectedSequences?: readonly number[];
  /** These names are never removed. */
  readonly protectedNames?: readonly string[];
}

export interface PrunePlan {
  /** History names to remove, oldest first. Every one is a validated history name (`parseHistoryName`); nothing else can be in it. */
  readonly removals: readonly string[];
  /** History names that stay, oldest first. */
  readonly kept: readonly string[];
  readonly keepRequested: number;
  readonly keepEffective: number;
  /** The request was below the floor and was raised. */
  readonly floorApplied: boolean;
  /** History files considered (distinct names that are history names). */
  readonly total: number;
  readonly prefixed: number;
  readonly legacyTotal: number;
  readonly legacyRemoved: number;
  readonly legacyKept: number;
  /** Prefixed files beyond the first at their sequence (what a fork leaves); counted as files, not a refusal. */
  readonly duplicateFiles: number;
  /** Distinct names in the listing that are not history names. They are never removed and never counted. */
  readonly ignored: number;
}

/**
 * The files to remove so that `keep` remain, from the names in `manifests/`. Pure: it reads no node and decrypts nothing. Order: legacy names (`<cid>.enc`)
 * before every prefixed name and unordered among themselves, then prefixed names by sequence; the oldest go first. The newest `max(keep, 20)` stay. A name
 * that is not a history name is ignored (never removed, never counted), so a listing of crafted names cannot put a path, `..` or `keyslots.json` into
 * the result. Protected names and sequences stay even when that keeps more than `keep`.
 */
export function planPrune(names: readonly string[], options: PrunePlanOptions): PrunePlan {
  if (!Number.isSafeInteger(options.keep) || options.keep < 1) throw new RangeError("the number of history files to keep must be a positive whole number");
  const distinct = [...new Set(names)];
  const sorted = sortHistoryNames(distinct);
  const keepEffective = Math.max(options.keep, HISTORY_KEEP_FLOOR);
  const protectedNames = new Set(options.protectedNames ?? []);
  const protectedSequences = new Set(options.protectedSequences ?? []);
  const isProtected = (entry: HistoryName): boolean => protectedNames.has(entry.name) || (entry.sequence !== undefined && protectedSequences.has(entry.sequence));
  const removed = sorted.slice(0, Math.max(0, sorted.length - keepEffective)).filter((entry) => !isProtected(entry));
  const removedNames = new Set(removed.map((entry) => entry.name));
  const kept = sorted.filter((entry) => !removedNames.has(entry.name));
  const legacy = (entry: HistoryName): boolean => entry.sequence === undefined;
  return {
    removals: removed.map((entry) => entry.name),
    kept: kept.map((entry) => entry.name),
    keepRequested: options.keep,
    keepEffective,
    floorApplied: options.keep < HISTORY_KEEP_FLOOR,
    total: sorted.length,
    prefixed: sorted.filter((entry) => !legacy(entry)).length,
    legacyTotal: sorted.filter(legacy).length,
    legacyRemoved: removed.filter(legacy).length,
    legacyKept: kept.filter(legacy).length,
    duplicateFiles: sorted.filter((entry, index) => entry.sequence !== undefined && sorted[index - 1]?.sequence === entry.sequence).length,
    ignored: distinct.length - sorted.length,
  };
}

/* ---------- errors ---------- */

export type PruneHistoryErrorCode =
  | "history-too-large"
  | "newest-sequence-mismatch"
  | "entry-unauthentic"
  | "entry-prefix-mismatch"
  | "current-entry-missing"
  | "journal-out-of-bounds";

/** A refusal of this module. Messages are fixed text built from counts and sequences; they never contain a name, a path or any other text a node chose. */
export class PruneHistoryError extends Error {
  readonly code: PruneHistoryErrorCode;

  constructor(code: PruneHistoryErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PruneHistoryError";
    this.code = code;
  }
}

const NOTHING_REMOVED = "Nothing was removed.";

const historyTooLarge = (): PruneHistoryError =>
  new PruneHistoryError(
    "history-too-large",
    "manifests/ on the node holds more than 2,000 entries, which this tool refuses to list, so it cannot choose what to remove. " +
      `${NOTHING_REMOVED} Remove the oldest history files on the node yourself (the entries of manifests/ with the lowest sequence numbers, with the node's own tools) until fewer than 1,999 remain, then run prune-history; or publish to a new MFS root.`,
  );

const newestMismatch = (found: number | undefined, wanted: number): PruneHistoryError =>
  new PruneHistoryError(
    "newest-sequence-mismatch",
    found === undefined
      ? `the node's manifest has sequence ${wanted} but manifests/ holds no sequence-prefixed history file at all: the history may be withheld. ${NOTHING_REMOVED}`
      : `the node's manifest has sequence ${wanted} but the newest history file in manifests/ is sequence ${found}: the history may be withheld, or a file was planted. ${NOTHING_REMOVED}`,
  );

const unauthentic = (position: number): PruneHistoryError =>
  new PruneHistoryError(
    "entry-unauthentic",
    `${which(position)} does not authenticate for this vault (it is damaged, forged, too large or belongs to another vault), so the names in manifests/ cannot be trusted. ${NOTHING_REMOVED}`,
  );

const prefixMismatch = (position: number): PruneHistoryError =>
  new PruneHistoryError(
    "entry-prefix-mismatch",
    `${which(position)} decrypts to a sequence other than the one its name claims, so the names in manifests/ cannot be trusted. ${NOTHING_REMOVED}`,
  );

const currentEntryMissing = (sequence: number): PruneHistoryError =>
  new PruneHistoryError(
    "current-entry-missing",
    `manifests/ holds no history file under the name of the node's current manifest (sequence ${sequence}), so it was withheld or renamed. ${NOTHING_REMOVED}`,
  );

const outOfBounds = (): PruneHistoryError =>
  new PruneHistoryError(
    "journal-out-of-bounds",
    `the pending prune lists a history file that the current manifest, or the base a fork resolution needs, depends on; it was not carried out and nothing was removed. ${MAINTENANCE_WAYS_OUT}`,
  );

/** Which history file a refusal is about, counted from the newest (0 is the newest). */
function which(position: number): string {
  return position === 0 ? "the newest history file" : `the history file ${position + 1} places from the newest`;
}

/** At most three names, quoted and escaped, then a count: the names are the node's. */
function summarize(names: readonly string[]): string {
  const shown = names.slice(0, 3).map((name) => `"${escapeForDisplay(name.length > 64 ? `${name.slice(0, 64)}...` : name)}"`);
  return `${shown.join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
}

/* ---------- ports ---------- */

/** What a prune needs from the outside: the key-management ports, without the cryptography. */
export type PruneDeps = Pick<KeyManagementDeps, "node" | "fs" | "kv" | "deviceStore" | "now" | "snapshotVerifier" | "assertHeld" | "beforeFirstWrite">;

export interface PruneInput extends KeyManagementInput {
  /** The count to keep, from the command line. Raised to `HISTORY_KEEP_FLOOR`. */
  readonly keep: number;
}

export interface PreparedPrune {
  /** The vault as the local copy opens it. */
  readonly vault: OpenedVault;
  readonly start: MaintenanceStart;
  readonly plan: PrunePlan;
  /** History files decrypted and checked; 0 when the plan removes nothing. */
  readonly checked: number;
}

/* ---------- prepare ---------- */

/** A node object that is damaged, forged, absent or not ours: a result, not a failure to reach the node. */
function isDataProblem(error: unknown): boolean {
  if (error instanceof KuboHttpError) return error.status === 404;
  if (error instanceof PublishRefusedError) return error.code === "remote-object-too-large" || error.code === "remote-object-invalid";
  if (error instanceof ManifestFormatError || error instanceof OversizeInputError || isUnreadableManifest(error)) return true;
  return error instanceof CryptoError && ["authentication-failed", "malformed-input", "unsupported-format", "oversize-input", "vault-mismatch"].includes(error.code);
}

interface WindowEntry {
  readonly entry: MfsEntry;
  readonly parsed: HistoryName;
}

/** The newest `HISTORY_KEEP_FLOOR` prefixed files of the listing, newest first. */
function newestWindow(entries: readonly MfsEntry[]): readonly WindowEntry[] {
  const prefixed = entries.flatMap((entry) => {
    const parsed = entry.type === "file" ? parseHistoryName(entry.name) : undefined;
    return parsed === undefined || parsed.sequence === undefined ? [] : [{ entry, parsed }];
  });
  const order = sortHistoryNames(prefixed.map((item) => item.entry.name));
  const byName = new Map(prefixed.map((item) => [item.entry.name, item] as const));
  return order
    .slice(-HISTORY_KEEP_FLOOR)
    .reverse()
    .flatMap((parsed) => {
      const item = byName.get(parsed.name);
      return item === undefined ? [] : [item];
    });
}

async function authenticate(deps: Pick<PruneDeps, "node">, keys: VaultKeys, item: WindowEntry, position: number, node: EncryptedManifest): Promise<void> {
  let manifest: EncryptedManifest;
  try {
    manifest = await decodeManifestFile(keys, await deps.node.readHistoryEntry(item.entry));
  } catch (error) {
    if (isDataProblem(error)) throw unauthentic(position);
    throw error;
  }
  if (manifest.vaultId !== node.vaultId) throw unauthentic(position);
  if (!prefixMatchesSequence(item.parsed, manifest.sequence)) throw prefixMismatch(position);
}

/**
 * The checks that make the names in `manifests/` believable, all before anything is removed: the newest prefixed file carries the node manifest's sequence,
 * the newest 20 each authenticate for this vault and agree with their prefix, and the node's current manifest has its own history file. Returns how many
 * files were decrypted.
 */
async function authenticateNewest(deps: Pick<PruneDeps, "node">, keys: VaultKeys, entries: readonly MfsEntry[], node: EncryptedManifest): Promise<number> {
  const window = newestWindow(entries);
  const newest = window[0];
  if (newest === undefined || newest.parsed.sequence !== node.sequence) throw newestMismatch(newest?.parsed.sequence, node.sequence);
  for (const [position, item] of window.entries()) await authenticate(deps, keys, item, position, node);
  const current = historyFileName(node.sequence, node.rootCID);
  if (!entries.some((entry) => entry.type === "file" && entry.name === current)) throw currentEntryMissing(node.sequence);
  return window.length;
}

/**
 * Everything a prune checks before it asks anything: reads only, one derivation (opening the local copy), no write. Refuses while a publish journal or any
 * maintenance journal is pending, when the device is behind or below its floor, when the publication key does not exist, when `manifests/` is too large
 * to list or holds anything but history files, and when the names cannot be believed (see the header). Errors: `PruneHistoryError`, `PublishRefusedError`,
 * `KeyManagementError`, and whatever the node throws.
 */
export async function preparePrune(deps: PruneDeps, input: PruneInput): Promise<PreparedPrune> {
  const pending = await pendingMaintenance(deps, input.mfsRoot);
  if (pending !== undefined) throw maintenancePending(pending.type);
  await assertNoPublishJournal(deps.kv, input.mfsRoot);
  const { vault, state } = await openCurrentVault(deps, input, { rewrap: false });
  const floor = deps.deviceStore === undefined ? undefined : await readFloor(deps.deviceStore, state.vaultId);
  const start = await beginMaintenance(
    { node: deps.node, decodeManifest: (bytes) => decodeManifestFile(vault.keys, bytes) },
    {
      target: { mfsRoot: input.mfsRoot, key: input.keyName, vaultId: vault.vaultId, keyslotsSha256: vault.keySlotsSha256 },
      state,
      floor,
      key: input.key,
      startedAt: deps.now(),
    },
  );
  const view = await deps.node.listHistory();
  if (view.overflow) throw historyTooLarge();
  const junk = junkNames(view);
  if (junk.length > 0) throw historyJunk(summarize(junk), false);
  const sequence = start.manifest.sequence;
  // The current manifest's own file and the two sequences a fork resolution looks at (the ancestor is the entry at `sequence - 1`) are never removed.
  const plan = planPrune(
    view.entries.map((entry) => entry.name),
    { keep: input.keep, protectedSequences: [sequence, sequence - 1], protectedNames: [historyFileName(sequence, start.manifest.rootCID)] },
  );
  if (plan.removals.length === 0) return { vault, start, plan, checked: 0 };
  return { vault, start, plan, checked: await authenticateNewest(deps, vault.keys, view.entries, start.manifest) };
}

/* ---------- execute ---------- */

/**
 * A removal list may name legacy files and prefixed files up to two sequences below the manifest the operation was based on, never the current entry or the
 * one before it. The plan cannot produce anything else; a journal that does was not written by this tool, or was changed afterwards.
 */
function assertWithinBounds(nodeSequence: number, removals: readonly string[]): void {
  for (const name of removals) {
    const parsed = parseHistoryName(name);
    if (parsed === undefined || (parsed.sequence !== undefined && parsed.sequence > nodeSequence - 2)) throw outOfBounds();
  }
}

/** The base read-back, then the one thing only a prune can check: every name it removed is gone from the snapshot. */
function pruneVerifier(deps: Pick<PruneDeps, "node" | "snapshotVerifier">, vault: OpenedVault, removals: readonly string[]): RepublishDeps["verifySnapshot"] {
  const base = deps.snapshotVerifier(vault.keySlots);
  return async (rootCid, expected) => {
    await base(rootCid, expected);
    let listed: readonly MfsEntry[] | undefined;
    try {
      listed = await deps.node.listHistoryAt(rootCid);
    } catch (error) {
      if (error instanceof KuboResponseTooLargeError) throw new ReadBackError("manifests/ in the snapshot is too large to list");
      throw error;
    }
    if (listed === undefined) throw new ReadBackError("manifests/ is missing from the snapshot");
    const present = new Set(listed.map((entry) => entry.name));
    if (removals.some((name) => present.has(name))) throw new ReadBackError("a history file the prune removed is still in the snapshot");
  };
}

function republishDeps(deps: PruneDeps, vault: OpenedVault, journal: PruneJournal): RepublishDeps {
  return {
    node: deps.node,
    kv: guardKv(deps.kv, deps.assertHeld),
    decodeManifest: (bytes) => decodeManifestFile(vault.keys, bytes),
    verifySnapshot: pruneVerifier(deps, vault, journal.removals),
  };
}

export interface PruneOutcome {
  /** `unchanged`: the plan removed nothing, and nothing was written. */
  readonly kind: "pruned" | "unchanged";
  readonly removed: number;
  readonly kept: number;
  /** The root CID that was read back, pinned and published (`state.rootCid`); null when nothing was published. */
  readonly snapshotRoot: string | null;
}

/**
 * Remove what the plan names, republish, and remove the journal. The caller showed the plan and the person confirmed it. After the journal exists a failure
 * leaves it for a rerun (`resumePrune`); before it exists nothing was written.
 */
export async function executePrune(deps: PruneDeps, prepared: PreparedPrune): Promise<PruneOutcome> {
  const { plan, start, vault } = prepared;
  if (plan.removals.length === 0) return { kind: "unchanged", removed: 0, kept: plan.kept.length, snapshotRoot: null };
  assertWithinBounds(start.facts.nodeSequence, plan.removals);
  const kv = guardKv(deps.kv, deps.assertHeld);
  const journal = buildPruneJournal(start.facts, plan.removals);
  await deps.beforeFirstWrite?.();
  await writeMaintenanceJournal(kv, journal);
  const driven = await driveMaintenance(republishDeps(deps, vault, journal), journal);
  await discardMaintenanceJournal(kv, journal.mfsRoot);
  return { kind: "pruned", removed: journal.removals.length, kept: plan.kept.length, snapshotRoot: driven.snapshotRoot };
}

/* ---------- resume ---------- */

export interface PruneResumeOutcome {
  readonly kind: "finished";
  /** The phase the journal was in when the rerun started. */
  readonly phaseFound: MaintenancePhase;
  readonly removed: number;
  readonly snapshotRoot: string;
}

/**
 * Finish a prune this device started and did not complete. Before `published` it needs the passphrase (or a held vault) to check the snapshot and republish; from
 * `published` on it needs nothing and only removes the journal. The journal's phase and the node decide; the list of removals is the journal's own, checked
 * against the bounds first, and each name is checked again as a history name where it becomes a path (`removeHistoryFile`).
 */
export async function resumePrune(deps: PruneDeps, journal: MaintenanceJournal, input: KeyManagementInput): Promise<PruneResumeOutcome> {
  if (journal.type !== "prune") throw maintenancePending(journal.type);
  assertWithinBounds(journal.nodeSequence, journal.removals);
  await assertNoPublishJournal(deps.kv, input.mfsRoot);
  const kv = guardKv(deps.kv, deps.assertHeld);
  let current: PruneJournal = journal;
  if (!reached(journal, "published")) {
    const { vault } = await openCurrentVault(deps, input, { localOnly: true, rewrap: false });
    if (input.key.absent) throw publicationKeyMissing(input.keyName);
    await deps.beforeFirstWrite?.();
    const driven = await driveMaintenance(republishDeps(deps, vault, journal), journal);
    current = driven.journal as PruneJournal;
  } else {
    await deps.beforeFirstWrite?.();
  }
  await discardMaintenanceJournal(kv, journal.mfsRoot);
  return { kind: "finished", phaseFound: journal.phase, removed: current.removals.length, snapshotRoot: current.snapshotRoot as string };
}
