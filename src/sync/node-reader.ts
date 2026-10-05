import type { Bytes } from "../core/host-bridge";
import { KEY_SLOTS_MAX_BYTES, MANIFEST_MAX_FILE_BYTES } from "../crypto";
import { isMissingPathError, type KuboClient, type MfsEntry, type MfsStat } from "../kubo";
import { listHistory, type HistoryView } from "./history-check";
import { plaintextRoot, remoteObjectInvalid, remoteObjectTooLarge, unexpectedRootEntries } from "./publish-refusals";

/**
 * Read-only access to the node's copy of one MFS root, for a client that cannot trust it. Every remote object is
 * measured first (`files/stat` or a listing entry) and refused above its cap before any byte is read, and the cap
 * is enforced again while the bytes stream, so a node that understates a size is cut off. Listings and stats are
 * capped by the client itself (1 MiB, 2,000 entries). Files are fetched by their own CID, so what is read is
 * exactly the object that was measured, whatever the mutable path does in between.
 */

export type NodeReadClient = Pick<KuboClient, "filesLs" | "filesStat" | "gatewayStream">;

export const KEYSLOTS_READ_CAP = KEY_SLOTS_MAX_BYTES;
export const MANIFEST_READ_CAP = MANIFEST_MAX_FILE_BYTES;

/** What a bounded read needs to know about a remote object; it comes from a listing entry or a stat. */
export interface RemoteObject {
  readonly cid: string;
  readonly size: number;
  readonly type: "file" | "directory";
}

/** The four entries an encrypted vault root may hold. */
export const ROOT_ENTRY_NAMES: readonly string[] = ["current", "manifests", "manifest.enc", "keyslots.json"];

const PREFIX_FOLDER = /^[a-z2-7]{2}$/;

export async function listIfPresent(client: NodeReadClient, path: string): Promise<readonly MfsEntry[] | undefined> {
  try {
    return await client.filesLs(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

export async function statIfPresent(client: NodeReadClient, path: string): Promise<MfsStat | undefined> {
  try {
    return await client.filesStat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function joinChunks(parts: readonly Uint8Array[], total: number): Bytes {
  const whole = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }
  return whole;
}

/** Read one remote file: refused by its stated size before reading, and cut off at `cap` while streaming (whichever the node understates). */
export async function readRemoteFile(client: Pick<KuboClient, "gatewayStream">, object: RemoteObject, what: string, cap: number): Promise<Bytes> {
  if (object.type !== "file") throw remoteObjectInvalid(what);
  if (object.size > cap) throw remoteObjectTooLarge(what, cap);
  // Ask for at most cap + 1 bytes: a gateway that honours Range is bounded by the request, and one that does not is cut off below.
  // (On desktop the body streams from Node's http and this loop cuts it off; only the mobile requestUrl transport buffers a whole body first, a limit stated in the threat model.)
  const stream = await client.gatewayStream(object.cid, "", { start: 0, length: cap + 1 });
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream.chunks) {
    total += chunk.length;
    if (total > cap) throw remoteObjectTooLarge(what, cap);
    parts.push(chunk);
  }
  // The stated size is only a reason to refuse early. What was streamed is what counts, and every object read here is
  // then compared byte for byte with a local copy or authenticated, so a size that disagrees with the stream proves nothing more.
  return joinChunks(parts, total);
}

/** The file at an MFS or `/ipfs/` path, or undefined when it does not exist. */
export async function readFileIfPresent(client: NodeReadClient, path: string, what: string, cap: number): Promise<Bytes | undefined> {
  const stat = await statIfPresent(client, path);
  return stat === undefined ? undefined : readRemoteFile(client, stat, what, cap);
}

/** The state of one MFS root as far as listings show it: top-level entries and the prefix folders of `current/`. */
export interface RootView {
  readonly exists: boolean;
  /** CID of the MFS root itself (the value that would be pinned and published); undefined when the root does not exist. */
  readonly rootCid: string | undefined;
  readonly entries: ReadonlyMap<string, MfsEntry>;
  /** The children of `current/` (all directories named by two base32 characters), empty when it is absent. */
  readonly folders: readonly MfsEntry[];
}

export interface RootInspector {
  /** Lists the root and `current/` once; refuses a plaintext publication. */
  view(): Promise<RootView>;
  /** `keyslots.json` (at most 16 KiB), or undefined when absent. */
  readKeySlots(): Promise<Bytes | undefined>;
  /** The listing of `manifests/`, once. */
  history(): Promise<HistoryView>;
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}

/** A root that holds `manifest.json`, or a `current/` that is not a tree of two-character folders, is a plaintext publication. */
function assertNotPlaintext(entries: ReadonlyMap<string, MfsEntry>, folders: readonly MfsEntry[]): void {
  if (entries.has("manifest.json")) throw plaintextRoot();
  if (folders.some((entry) => entry.type !== "directory" || !PREFIX_FOLDER.test(entry.name))) throw plaintextRoot();
}

async function loadView(client: NodeReadClient, mfsRoot: string): Promise<RootView> {
  const root = await statIfPresent(client, mfsRoot);
  const listed = root === undefined ? undefined : await listIfPresent(client, mfsRoot);
  if (root === undefined || listed === undefined) return { exists: false, rootCid: undefined, entries: new Map(), folders: [] };
  const entries = new Map(listed.map((entry) => [entry.name, entry] as const));
  const current = entries.get("current");
  const folders = current === undefined || current.type !== "directory" ? [] : ((await listIfPresent(client, `${mfsRoot}/current`)) ?? []);
  assertNotPlaintext(entries, folders);
  if (current !== undefined && current.type !== "directory") throw plaintextRoot();
  return { exists: true, rootCid: root.cid, entries, folders };
}

/**
 * Lazy, memoised reads of the root: nothing is requested until a method is called, and each thing is fetched once.
 * `manifest.enc` is not memoised here: it changes during a publish, so its reads go through the commit node.
 */
export function createRootInspector(client: NodeReadClient, mfsRoot: string): RootInspector {
  const view = once(() => loadView(client, mfsRoot));
  const readKeySlots = async (): Promise<Bytes | undefined> => {
    const entry = (await view()).entries.get("keyslots.json");
    return entry === undefined ? undefined : readRemoteFile(client, entry, "keyslots.json", KEYSLOTS_READ_CAP);
  };
  return { view, readKeySlots: once(readKeySlots), history: once(() => listHistory(client, mfsRoot)) };
}

/**
 * The root may hold exactly `current`, `manifests`, `manifest.enc` and `keyslots.json`, each of the right kind. Anything else
 * is refused before a write (the read-back would refuse it later, after the upload), naming the entries, which are node
 * names and not vault paths. This tool never removes anything outside `current/`.
 */
export function assertRootLayout(view: RootView): void {
  const extra = [...view.entries.keys()].filter((name) => !ROOT_ENTRY_NAMES.includes(name)).sort();
  if (extra.length > 0) throw unexpectedRootEntries(extra);
  const folders = new Set(["current", "manifests"]);
  for (const entry of view.entries.values()) {
    if (entry.type !== (folders.has(entry.name) ? "directory" : "file")) throw remoteObjectInvalid("an entry of the MFS root");
  }
}
