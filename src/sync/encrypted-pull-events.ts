/**
 * The events of the decrypting pull (mvp-07a task 4.6c; design decision 7, spec encrypted-pull). WebView-safe: no Node imports.
 *
 * One `conflict` event per local file that was kept as a dated copy, then one `pull.complete` with the counts. The counts are
 * additive fields of `PullCompleteEvent` (a listener of the plaintext reader must not assume them). `pull.complete` carries no
 * path; `conflict` carries the two paths and the two hashes, as the plaintext reader's does. The paths reaching this point have
 * passed the path policy (a path with a control character or a bidirectional override is a skip, never a fetch), and the
 * payloads hold no passphrase, key, free text from the node or file bytes: the bus refuses a payload field with such a name.
 */
import type { HostFs } from "../core/host-bridge";
import type { PullCompleteEvent, SyncEventBus } from "../core/events";
import type { EncryptedManifestFile } from "./encrypted-manifest";
import type { EncryptedPullPlan, PullSettlement } from "./encrypted-pull-plan";
import { hashFile } from "./hash";

export interface PullEventInput {
  readonly bus: Pick<SyncEventBus, "emit">;
  readonly fs: Pick<HostFs, "stat" | "read" | "readRange">;
  /** The immutable root the target resolved to, and the tree the authenticated manifest names. */
  readonly rootCid: string;
  readonly manifestCid: string;
  readonly sequence: number;
  readonly plan: EncryptedPullPlan;
  readonly settlement: PullSettlement;
  /** What the state says after this pull: the new value, or for a restore the value it already had. */
  readonly complete: boolean;
  readonly forcedReverify: boolean;
  readonly durationMs: number;
}

/**
 * The hash of the local text a conflict copy holds. The plan has it for a path it decided was a conflict; a path planned as a
 * replace that the user edited while the fetch ran has no plan value, and its copy is hashed.
 */
async function localSha256Of(input: PullEventInput, planned: ReadonlyMap<string, string>, conflict: { readonly path: string; readonly conflictPath: string }): Promise<string> {
  const known = planned.get(conflict.path);
  if (known !== undefined) return known;
  const info = await input.fs.stat(conflict.conflictPath);
  return hashFile(input.fs, conflict.conflictPath, info?.size ?? 0);
}

export async function emitPullEvents(input: PullEventInput): Promise<void> {
  const { bus, settlement } = input;
  const planned = new Map(input.plan.paths.flatMap((decision) => (decision.kind === "conflict" ? [[decision.path, decision.localSha256] as const] : [])));
  for (const conflict of settlement.conflicts) {
    const remote = settlement.manifest.files[conflict.path] as EncryptedManifestFile; // a conflict is made for a manifest path, which the settlement keeps
    bus.emit("conflict", { path: conflict.path, conflictPath: conflict.conflictPath, localSha256: await localSha256Of(input, planned, conflict), remoteSha256: remote.sha256 });
  }
  const payload: PullCompleteEvent = {
    rootCid: input.rootCid,
    manifestCid: input.manifestCid,
    fetched: settlement.fetched.length,
    unchanged: settlement.unchanged.length,
    conflicted: settlement.conflicts.length,
    failed: settlement.integrityFailed.length + settlement.unfetched.length,
    remoteDeleted: settlement.remoteDeleted.length,
    locallyModified: settlement.locallyModified.length,
    forcedReverify: input.forcedReverify,
    durationMs: input.durationMs,
    sequence: input.sequence,
    complete: input.complete,
    integrityFailed: settlement.integrityFailed.length,
    unfetched: settlement.unfetched.length,
    policySkipped: settlement.skipped.length,
    restored: settlement.restored.length,
  };
  bus.emit("pull.complete", payload);
}
