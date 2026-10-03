import type { CommitNode, NameReading, NameStart } from "./commit-ports";
import type { EncryptedManifest } from "./encrypted-manifest";
import { manifestIdentity } from "./manifest-identity";
import { PublishRefusedError, nameRoutingFailed, overlappingPublish } from "./publish-refusals";

/**
 * The publisher's name re-check (mvp-07 design decision 10.3). A publish with work reads the publication name before its
 * first write and again right before `name/publish`; a publish that is resumed compares the name with the root the
 * interrupted run started from. The rules live here, in one place, so the fresh and the resumed path cannot drift apart:
 *
 *  - a value at the start needs the same value at the end;
 *  - `not-found` at the start needs `not-found` at the end;
 *  - `failed` at either point refuses and names routing, except that a routing timeout on the FIRST publish of a vault
 *    (no manifest on the node, no local state) counts as `not-found`;
 *  - a key created by this run is never read (the callers skip the read);
 *  - the root this publish is about to publish is also an acceptable value at the end: it means a previous attempt of this
 *    very publish already moved the name.
 *
 * The sequence decision itself reads `manifest.enc` before the name start, so `manifest.enc` is read once more right after the start
 * and compared byte for byte (publish.ts), and the commit looks at it again before it overwrites it (`assertNoLaterPublication`): a
 * publisher that completed in between is then seen, not compared with itself. What remains is the time between the second name read and
 * `name/publish`, and between the commit's look and its write. This is not a compare-and-swap: kubo has none, and a write race on the
 * shared MFS tree is not detected at all.
 */

/**
 * The `overlapping-publish` refusal of an end-of-publish check that read the name and found it moved. It carries the root the name
 * resolved to now (null when it no longer resolves), so the commit can look inside exactly that root (review-final A-03). Same code,
 * name and text as `overlappingPublish()`; only the commit protocol reads `movedTo`.
 */
export class NameMovedError extends PublishRefusedError {
  readonly movedTo: string | null;

  constructor(movedTo: string | null) {
    const base = overlappingPublish();
    super(base.code, base.message);
    this.movedTo = movedTo;
  }
}

/** The root a reading stands for: a CID, or `null` for "no record". Throws the routing refusal for a failed reading. */
export function rootOfReading(reading: NameReading | undefined, firstPublish: boolean): string | null {
  if (reading === undefined) return null;
  switch (reading.kind) {
    case "value":
      return reading.root;
    case "not-found":
      return null;
    case "failed":
      if (reading.timedOut && firstPublish) return null;
      throw nameRoutingFailed();
  }
}

/** The end-of-publish check: `now` must equal the start root, or be the root about to be published. Throws `overlappingPublish`. */
export function assertNameUnmoved(start: NameStart, reading: NameReading | undefined, publishing: string): void {
  const now = rootOfReading(reading, start.firstPublish);
  if (now === start.root) return;
  if (now !== null && now === publishing) return;
  throw new NameMovedError(now);
}

/**
 * The commit's look at the `manifest.enc` on the node, just before this publish overwrites it (review-final A-01). `found` is that file
 * decoded under our key (undefined when absent or not authentic). It is another publisher's publication when it belongs to this vault, carries
 * this publish's sequence or a later one, and is not this publish's own manifest (another identity): the publish stops with
 * `overlapping-publish` before it writes to the node. Anything older, absent or unreadable is not a publication this one lost to.
 */
export function assertNoLaterPublication(found: EncryptedManifest | undefined, manifest: EncryptedManifest): void {
  if (found === undefined || found.vaultId !== manifest.vaultId || found.sequence < manifest.sequence) return;
  if (manifestIdentity(found) === manifestIdentity(manifest)) return;
  throw overlappingPublish();
}

/** The start-of-publish reading: the root to remember. Throws the routing refusal when the name cannot be read. */
export async function readNameStart(node: Pick<CommitNode, "resolveName">, firstPublish: boolean): Promise<NameStart> {
  return { root: rootOfReading(await node.resolveName(), firstPublish), firstPublish };
}

/**
 * The resume-time check: before an interrupted publish is adopted, re-encrypted or finished, the name must still be where
 * that publish started. `ours` is true when the node holds the manifest the journal announced; then the root of the
 * snapshot (which a previous attempt may already have published) is acceptable too. No key id yet means no name to read:
 * the key check right before `name/publish` still stands, and an adoption publishes nothing.
 */
export async function assertNameStillAt(node: Pick<CommitNode, "resolveName" | "rootCid">, expected: string | null, ours: boolean): Promise<void> {
  const reading = await node.resolveName();
  if (reading === undefined) return;
  const now = rootOfReading(reading, false);
  if (now === expected) return;
  if (ours && now !== null && now === (await node.rootCid())) return;
  throw overlappingPublish();
}
