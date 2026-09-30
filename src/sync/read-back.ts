import type { Bytes } from "../core/host-bridge";
import { KuboResponseTooLargeError, isMissingPathError, type KuboClient, type MfsEntry } from "../kubo";
import type { SnapshotExpectation } from "./commit-ports";
import { ROOT_ENTRY_NAMES, readRemoteFile } from "./node-reader";
import { PublishRefusedError, ReadBackError } from "./publish-refusals";
import { sameBytes } from "./same-bytes";

/**
 * The read-back before pinning (spec: encrypted-publish, "Read-back before pinning and publishing"). The snapshot is
 * read through its immutable path `/ipfs/<root CID>/...`, so nothing that happens to the mutable MFS afterwards
 * can change what is checked, and the CID that passes is the CID that is pinned and published. It verifies:
 *
 *  - the root lists exactly `current`, `manifests`, `manifest.enc` and `keyslots.json`, each of the right kind;
 *  - `manifest.enc` equals the bytes just written (so it authenticates with the expected sequence);
 *  - `keyslots.json` equals this device's copy, byte for byte;
 *  - the CID of `current` equals the manifest's `rootCID`;
 *  - every name in `manifests/` is `<cid>.enc`, and the history file for this snapshot has the manifest's bytes;
 *  - every prefix folder touched in this run shows each blob written in this run with the CID recorded when it
 *    was written.
 *
 * Blobs that were not touched in this run are not re-verified. Errors carry opaque node names and counts only.
 */

export interface ReadBackContext {
  /** `ipfsLs` lists the immutable snapshot; `gatewayStream` reads its files by CID. */
  readonly client: Pick<KuboClient, "ipfsLs" | "gatewayStream">;
  /** The local copy of the key slots. */
  readonly keySlots: Bytes;
  /** Blobs written in this run: node name to the CID recorded at write time. Empty for a resumed publish. */
  readonly written: ReadonlyMap<string, string>;
}

const CID_SHAPE = /^[A-Za-z0-9]{10,128}$/;
const HISTORY_NAME = /^([A-Za-z0-9]{10,128})\.enc$/;

async function listSnapshot(ctx: ReadBackContext, path: string, what: string): Promise<ReadonlyMap<string, MfsEntry>> {
  let entries: readonly MfsEntry[];
  try {
    entries = await ctx.client.ipfsLs(path);
  } catch (error) {
    // A folder the snapshot should have and does not is a verdict about the snapshot, not a failure to read.
    if (isMissingPathError(error)) throw new ReadBackError(`${what} is missing from the snapshot`);
    // A listing the client refuses (over 2,000 entries) is a verdict about the snapshot too: a cap must never wedge a journal.
    if (error instanceof KuboResponseTooLargeError) throw new ReadBackError(`${what} is too large to list (${error.message})`);
    throw error;
  }
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new ReadBackError(`${what} lists a name twice`);
  return new Map(entries.map((entry) => [entry.name, entry] as const));
}

function topLevel(root: ReadonlyMap<string, MfsEntry>): ReadonlyMap<string, MfsEntry> {
  const extra = [...root.keys()].filter((name) => !ROOT_ENTRY_NAMES.includes(name));
  if (extra.length > 0) throw new ReadBackError(`the snapshot root holds ${extra.length} unexpected top-level ${extra.length === 1 ? "entry" : "entries"}`);
  for (const name of ROOT_ENTRY_NAMES) {
    const entry = root.get(name);
    if (entry === undefined) throw new ReadBackError(`the snapshot root has no ${name}`);
    const wanted = name === "current" || name === "manifests" ? "directory" : "file";
    if (entry.type !== wanted) throw new ReadBackError(`${name} in the snapshot root is not a ${wanted}`);
  }
  return root;
}

/** The expected bytes are known, so their length is the read cap: a node cannot make the check pull more than that. */
async function assertFileEquals(ctx: ReadBackContext, entry: MfsEntry, expected: Bytes, what: string): Promise<void> {
  let bytes: Bytes;
  try {
    bytes = await readRemoteFile(ctx.client, entry, what, expected.length);
  } catch (error) {
    // A file larger than what was written, or of the wrong kind, is a verdict about the snapshot (a resumed publish can adopt
    // on it), not a reason to keep the journal. Transport failures and other errors propagate unchanged.
    if (error instanceof PublishRefusedError && (error.code === "remote-object-too-large" || error.code === "remote-object-invalid")) {
      throw new ReadBackError(`${what} in the snapshot is not the file that was written (wrong kind or size)`);
    }
    throw error;
  }
  if (!sameBytes(bytes, expected)) throw new ReadBackError(`${what} in the snapshot differs from what was written`);
}

async function checkHistory(ctx: ReadBackContext, base: string, manifestEntry: MfsEntry, expected: SnapshotExpectation): Promise<void> {
  const history = await listSnapshot(ctx, `${base}/manifests`, "manifests/");
  for (const [name, entry] of history) {
    if (!HISTORY_NAME.test(name) || entry.type !== "file") throw new ReadBackError("manifests/ holds an entry that is not a history file");
  }
  const mine = history.get(`${expected.manifest.rootCID}.enc`);
  if (mine === undefined) throw new ReadBackError("the history file for this snapshot is missing");
  // Identical bytes imported the same way have the same CID; only when the CIDs differ are the bytes compared.
  if (mine.cid !== manifestEntry.cid) await assertFileEquals(ctx, mine, expected.manifestFile, "the history file");
}

/** Group the blobs written in this run by their two-character prefix folder. */
function byPrefix(written: ReadonlyMap<string, string>): ReadonlyMap<string, readonly [string, string][]> {
  const groups = new Map<string, [string, string][]>();
  for (const [name, cid] of written) {
    const prefix = name.slice(0, 2);
    groups.set(prefix, [...(groups.get(prefix) ?? []), [name, cid]]);
  }
  return groups;
}

async function checkTouched(ctx: ReadBackContext, base: string): Promise<void> {
  for (const [prefix, blobs] of byPrefix(ctx.written)) {
    const folder = await listSnapshot(ctx, `${base}/current/${prefix}`, "a touched prefix folder");
    for (const [name, cid] of blobs) {
      const entry = folder.get(name);
      if (entry === undefined) throw new ReadBackError(`blob ${name} written in this run is missing from the snapshot`);
      if (entry.cid !== cid) throw new ReadBackError(`blob ${name} in the snapshot is not the object that was written`);
    }
  }
}

/** The verifier the commit protocol calls with the root CID it is about to pin. */
export function createSnapshotVerifier(ctx: ReadBackContext): (rootCid: string, expected: SnapshotExpectation) => Promise<void> {
  return async (rootCid, expected) => {
    if (!CID_SHAPE.test(rootCid)) throw new ReadBackError("the snapshot root identifier is not a CID");
    const base = `/ipfs/${rootCid}`;
    const root = topLevel(await listSnapshot(ctx, base, "the snapshot root"));
    const current = root.get("current") as MfsEntry;
    if (current.cid !== expected.manifest.rootCID) throw new ReadBackError("current/ in the snapshot is not the tree the manifest describes");
    const manifestEntry = root.get("manifest.enc") as MfsEntry;
    await assertFileEquals(ctx, manifestEntry, expected.manifestFile, "manifest.enc");
    await assertFileEquals(ctx, root.get("keyslots.json") as MfsEntry, ctx.keySlots, "keyslots.json");
    await checkHistory(ctx, base, manifestEntry, expected);
    await checkTouched(ctx, base);
  };
}
