/**
 * Pull verdicts (mvp-07a design decision 4): the authenticated candidate manifest against the effective record.
 * Pure: no I/O, no clocks, no imports from the host. Every message is fixed text built from sequence numbers and flag
 * names; none carries an identity, a path, a key or a passphrase.
 *
 * Order of evaluation, first match wins:
 *   0. flag combinations that are never valid (refused before any request is made);
 *   1. a failed `--expect-vault-id` or `--expect-min-sequence`;
 *   2. no record: first pull;
 *   3. a different `vaultId`;
 *   4. a lower sequence: `restore` only for an explicit target with `--allow-rollback`, otherwise refused;
 *   5. an equal sequence with a different identity (or a record whose state and floor disagree): fork, resolved only
 *      for a name target with `--resolve-fork`; `--allow-rollback` has no effect;
 *   6. an equal sequence and identity: same;
 *   7. a higher sequence: newer.
 *
 * The record is raised by `newer` and `first-pull` and never lowered by any verdict (`recordAfterVerdict`).
 */

export type PullTargetKind = "name" | "root-cid" | "manifest";

export interface PullFlags {
  /** Only valid with an explicit target (`root-cid`, `manifest`). */
  readonly allowRollback?: boolean;
  /** Only valid with a name target. */
  readonly resolveFork?: boolean;
  readonly expectMinSequence?: number;
  readonly expectVaultId?: string;
}

/** The authenticated manifest being considered. */
export interface PullCandidate {
  readonly vaultId: string;
  readonly sequence: number;
  /** Manifest identity (64 lowercase hex), never a hash of `manifest.enc` bytes. */
  readonly identity: string;
}

/** What the directory's `.ipfs-sync` state says it has accepted. */
export interface StateRecord {
  readonly vaultId: string;
  /** `highestSequence` of the state. */
  readonly sequence: number;
  /** `highestIdentity` of the state. */
  readonly identity: string;
  /**
   * True when the state was written by an adopted publish: the manifest at `sequence` is this device's own and the
   * floor has not yet caught up. The caller derives it; it only has an effect while the state is above the floor.
   */
  readonly pendingPublish: boolean;
}

/** What the device-local floor says for a vault. */
export interface FloorRecord {
  readonly vaultId: string;
  readonly sequence: number;
  readonly identity: string;
}

export interface EffectiveRecord {
  readonly vaultId: string;
  readonly sequence: number;
  readonly identity: string;
  readonly source: "state" | "floor" | "both";
  /** The state and the floor hold the same sequence with different identities. Any candidate at that sequence is a fork. */
  readonly conflict: boolean;
  /** The record's sequence comes from an adopted publish that the floor does not confirm yet. */
  readonly pendingPublish: boolean;
}

/**
 * The effective record: the higher sequence of the directory's state and the floor. A floor entry for another vault
 * than the state's is ignored: the state binds the directory to its vault. At an equal sequence with different
 * identities the record is flagged `conflict` (the verdict is a fork). The identity reported on a conflict is the
 * state's.
 */
export function effectiveRecord(state: StateRecord | undefined, floor: FloorRecord | undefined): EffectiveRecord | undefined {
  const usableFloor = state !== undefined && floor !== undefined && floor.vaultId !== state.vaultId ? undefined : floor;
  if (state === undefined && usableFloor === undefined) return undefined;
  if (state === undefined) {
    // `usableFloor` is defined here.
    const only = usableFloor as FloorRecord;
    return { vaultId: only.vaultId, sequence: only.sequence, identity: only.identity, source: "floor", conflict: false, pendingPublish: false };
  }
  if (usableFloor === undefined) {
    return { vaultId: state.vaultId, sequence: state.sequence, identity: state.identity, source: "state", conflict: false, pendingPublish: state.pendingPublish };
  }
  if (usableFloor.sequence > state.sequence) {
    return { vaultId: usableFloor.vaultId, sequence: usableFloor.sequence, identity: usableFloor.identity, source: "floor", conflict: false, pendingPublish: false };
  }
  if (usableFloor.sequence < state.sequence) {
    return { vaultId: state.vaultId, sequence: state.sequence, identity: state.identity, source: "state", conflict: false, pendingPublish: state.pendingPublish };
  }
  const agree = usableFloor.identity === state.identity;
  return { vaultId: state.vaultId, sequence: state.sequence, identity: state.identity, source: "both", conflict: !agree, pendingPublish: false };
}

export type PullRefusalReason = "flag-combination" | "expectation-failed" | "other-vault" | "older" | "unfinished-publish" | "fork";

export type PullVerdict =
  | { readonly kind: "first-pull" }
  | { readonly kind: "same" }
  | { readonly kind: "newer"; readonly from: number; readonly to: number }
  | { readonly kind: "restore"; readonly recordedSequence: number; readonly candidateSequence: number }
  | { readonly kind: "fork-resolution"; readonly sequence: number }
  | { readonly kind: "refused"; readonly reason: PullRefusalReason; readonly message: string };

export type PullRefusal = Extract<PullVerdict, { kind: "refused" }>;

const refuse = (reason: PullRefusalReason, message: string): PullRefusal => ({ kind: "refused", reason, message });

/** Flag combinations that are refused before any request. `undefined` when the combination is valid. */
export function checkPullFlags(target: PullTargetKind, flags: PullFlags): PullRefusal | undefined {
  if (flags.resolveFork === true && flags.allowRollback === true) {
    return refuse("flag-combination", "--resolve-fork cannot be combined with --allow-rollback");
  }
  if (flags.allowRollback === true && target === "name") {
    return refuse("flag-combination", "--allow-rollback needs an explicit target: pass --root-cid or --manifest; it is never accepted for a name-resolved pull");
  }
  if (flags.resolveFork === true && target !== "name") {
    return refuse("flag-combination", "--resolve-fork works only on a name target; it cannot be combined with --root-cid or --manifest");
  }
  return undefined;
}

function expectationRefusal(vaultId: string | undefined, sequence: number | undefined, flags: PullFlags): PullRefusal | undefined {
  if (flags.expectVaultId !== undefined && vaultId !== undefined && flags.expectVaultId !== vaultId) {
    return refuse("expectation-failed", "the vault id is not the one expected by --expect-vault-id; nothing was changed");
  }
  if (flags.expectMinSequence !== undefined && sequence !== undefined && sequence < flags.expectMinSequence) {
    return refuse("expectation-failed", `the manifest has sequence ${sequence}, below the ${flags.expectMinSequence} required by --expect-min-sequence; nothing was changed`);
  }
  return undefined;
}

const otherVaultRefusal = (): PullRefusal =>
  refuse("other-vault", "this directory (or this device's sequence floor) records a different vault than the one being pulled; nothing was changed");

/**
 * The checks that need only the key-slot file's `vaultId`, run before any key derivation: the vault expectation, and
 * the record's vault (state or floor) against the slot file. `undefined` when both pass.
 */
export function checkVaultBeforeDerivation(input: { readonly slotVaultId: string; readonly record: EffectiveRecord | undefined; readonly flags: PullFlags }): PullRefusal | undefined {
  const expected = expectationRefusal(input.slotVaultId, undefined, input.flags);
  if (expected !== undefined) return expected;
  if (input.record !== undefined && input.record.vaultId !== input.slotVaultId) return otherVaultRefusal();
  return undefined;
}

function olderRefusal(record: EffectiveRecord, candidate: PullCandidate, target: PullTargetKind): PullRefusal {
  if (target === "name") {
    if (record.pendingPublish) {
      return refuse("unfinished-publish", `an unfinished publish of sequence ${record.sequence} is pending; run publish`);
    }
    return refuse(
      "older",
      `the node serves sequence ${candidate.sequence} but this device has recorded sequence ${record.sequence}; the node may be serving an older state or may be hostile, so nothing was changed`,
    );
  }
  return refuse(
    "older",
    `the target has sequence ${candidate.sequence} but this device has recorded sequence ${record.sequence}; to restore this older state deliberately, repeat the pull with --allow-rollback`,
  );
}

function forkRefusal(sequence: number, target: PullTargetKind): PullRefusal {
  const head = `sequence ${sequence} exists here with different content than this device recorded; another device may have published at the same time`;
  return target === "name"
    ? refuse("fork", `${head}; to merge the node's state with this device's, run the pull with --resolve-fork`)
    : refuse("fork", `${head}; a fork cannot be accepted through an explicit target or --allow-rollback`);
}

export interface PullVerdictInput {
  readonly record: EffectiveRecord | undefined;
  readonly candidate: PullCandidate;
  readonly target: PullTargetKind;
  readonly flags: PullFlags;
}

export function evaluatePullVerdict(input: PullVerdictInput): PullVerdict {
  const { record, candidate, target, flags } = input;
  const badFlags = checkPullFlags(target, flags);
  if (badFlags !== undefined) return badFlags;
  const unmet = expectationRefusal(candidate.vaultId, candidate.sequence, flags);
  if (unmet !== undefined) return unmet;
  if (record === undefined) return { kind: "first-pull" };
  if (record.vaultId !== candidate.vaultId) return otherVaultRefusal();
  if (candidate.sequence < record.sequence) {
    if (target !== "name" && flags.allowRollback === true) {
      return { kind: "restore", recordedSequence: record.sequence, candidateSequence: candidate.sequence };
    }
    return olderRefusal(record, candidate, target);
  }
  if (candidate.sequence === record.sequence) {
    if (record.conflict || record.identity !== candidate.identity) {
      return target === "name" && flags.resolveFork === true ? { kind: "fork-resolution", sequence: record.sequence } : forkRefusal(record.sequence, target);
    }
    return { kind: "same" };
  }
  return { kind: "newer", from: record.sequence, to: candidate.sequence };
}

export interface RecordPoint {
  readonly vaultId: string;
  readonly sequence: number;
  readonly identity: string;
}

/**
 * What the record (state `highest*` and floor) holds after `verdict` is applied. `first-pull`, `newer` and
 * `fork-resolution` take the candidate; `same`, `restore` and every refusal leave the record as it was. A candidate
 * below the record never replaces it, whatever the verdict says: the record is never lowered.
 */
export function recordAfterVerdict(record: EffectiveRecord | undefined, candidate: PullCandidate, verdict: PullVerdict): RecordPoint | undefined {
  const current: RecordPoint | undefined = record === undefined ? undefined : { vaultId: record.vaultId, sequence: record.sequence, identity: record.identity };
  const takesCandidate = verdict.kind === "first-pull" || verdict.kind === "newer" || verdict.kind === "fork-resolution";
  if (!takesCandidate) return current;
  if (current !== undefined && candidate.sequence < current.sequence) return current;
  return { vaultId: candidate.vaultId, sequence: candidate.sequence, identity: candidate.identity };
}
