import type { Bytes, HostKv } from "../core/host-bridge";

/**
 * The `encryptedSeen` latch of the pull side (spec: encrypted-publish, "Pull of an encrypted root"). Once a root, a key
 * or a destination has been seen to hold encrypted content, the plaintext reader is refused for it from then on, so an
 * open-write node cannot downgrade a device by serving an old plaintext manifest.
 *
 * The latch lives in the destination's `.ipfs-sync/` folder, so it is a property of the destination. It is set by a
 * pull that meets an encrypted root (`encrypted-seen.json`), and it is implied by the files an encrypted publish
 * leaves there (`state.<h>.json`, `journal.<h>.json`, `keyslots.<h>.json`, each of which carries or proves it) and by an `abandoned-<h>-<ms>` backup folder. Abandon also records
 * the latch file itself before it moves anything. A latch
 * file that cannot be read still counts as set. Deleting `.ipfs-sync/` resets it; the documentation says so.
 */

export const LATCH_KEY = "encrypted-seen.json";
const LATCH_VERSION = 1;
const MAX_SIGHTINGS = 20;
const ENCRYPTED_PUBLISH_FILE = /^(?:state|journal|keyslots)\.[0-9a-f]{16}\.json$/;
/** The backup folder `abandon` leaves behind: proof that this destination held an encrypted vault. */
export const ABANDONED_BACKUP = /^abandoned-[0-9a-f]{16}-\d+$/;

export interface Sighting {
  /** The IPNS name whose root was encrypted. */
  readonly ipnsName: string;
  readonly mfsRoot: string;
  readonly key: string;
  /** ISO-8601 UTC. */
  readonly at: string;
}

interface LatchFile {
  readonly version: typeof LATCH_VERSION;
  readonly encryptedSeen: true;
  readonly sightings: readonly Sighting[];
}

/** Is this destination latched? Any evidence counts. */
export async function isLatched(kv: Pick<HostKv, "get" | "list">): Promise<boolean> {
  if ((await kv.get(LATCH_KEY)) !== undefined) return true;
  return (await kv.list("")).some((key) => ENCRYPTED_PUBLISH_FILE.test(key) || ABANDONED_BACKUP.test(key));
}

function parseSightings(bytes: Bytes | undefined): readonly Sighting[] {
  if (bytes === undefined) return [];
  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as { sightings?: unknown };
    return Array.isArray(raw.sightings) ? (raw.sightings as Sighting[]) : [];
  } catch {
    // An unreadable latch stays latched: it is rewritten with this sighting and nothing is lost that mattered.
    return [];
  }
}

/** Set the latch. Earlier sightings are kept (the most recent 20); nothing secret is stored. */
export async function recordEncryptedSeen(kv: Pick<HostKv, "get" | "set">, sighting: Sighting): Promise<void> {
  const earlier = parseSightings(await kv.get(LATCH_KEY));
  const file: LatchFile = { version: LATCH_VERSION, encryptedSeen: true, sightings: [...earlier, sighting].slice(-MAX_SIGHTINGS) };
  await kv.set(LATCH_KEY, new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`));
}
