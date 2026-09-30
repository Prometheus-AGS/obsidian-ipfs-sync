import type { HostBridge } from "../core/host-bridge";
import { KuboHttpError, type KuboClient } from "../kubo";
import { EncryptedVaultError, PlaintextV1RefusedError } from "./pull-errors";
import { abandon } from "./pull-fetch";
import { isLatched, recordEncryptedSeen } from "./pull-latch";

/**
 * What a pull decides about the resolved root before it reads any manifest: is it an encrypted vault, and may the
 * plaintext reader be used at all. Only read-only, bounded requests are made here: a one-byte range of
 * `keyslots.json` and of `manifest.enc`, never a whole object.
 */

export type ProbeClient = Pick<KuboClient, "gatewayStream">;

const ENCRYPTED_MARKERS = ["keyslots.json", "manifest.enc"] as const;
const HTTP_NOT_FOUND = 404;
const HTTP_RANGE_NOT_SATISFIABLE = 416;

/** Does `<root>/<path>` exist? A 416 answer (an empty file cannot satisfy a range) still proves it does. */
async function exists(client: ProbeClient, rootCid: string, path: string): Promise<boolean> {
  try {
    await abandon(await client.gatewayStream(rootCid, path, { start: 0, length: 1 }));
    return true;
  } catch (error) {
    if (error instanceof KuboHttpError && error.status === HTTP_NOT_FOUND) return false;
    if (error instanceof KuboHttpError && error.status === HTTP_RANGE_NOT_SATISFIABLE) return true;
    throw error;
  }
}

/** True when the root holds key slots or an encrypted manifest. Any other failure to ask stops the pull: silence is not "absent". */
export async function rootIsEncrypted(client: ProbeClient, rootCid: string): Promise<boolean> {
  for (const path of ENCRYPTED_MARKERS) if (await exists(client, rootCid, path)) return true;
  return false;
}

export interface ScreenInput {
  readonly client: ProbeClient;
  readonly host: Pick<HostBridge, "fs" | "kv" | "timeNow">;
  readonly rootCid: string;
  readonly ipnsName: string;
  readonly mfsRoot: string;
  readonly keyName: string;
  readonly allowPlaintextV1: boolean;
}

/**
 * Encrypted root: set the latch (when the destination exists, so the probe never creates a folder) and stop with the
 * typed error. Plaintext root: refused when the destination is latched (a downgrade), then refused unless the flag
 * was given. Returns only when the plaintext reader may go on.
 */
export async function screenRoot(input: ScreenInput): Promise<void> {
  const { host } = input;
  if (await rootIsEncrypted(input.client, input.rootCid)) {
    if ((await host.fs.stat(""))?.kind === "directory") {
      await recordEncryptedSeen(host.kv, { ipnsName: input.ipnsName, mfsRoot: input.mfsRoot, key: input.keyName, at: new Date(host.timeNow()).toISOString() });
    }
    throw new EncryptedVaultError();
  }
  if (await isLatched(host.kv)) throw new PlaintextV1RefusedError("downgrade");
  if (!input.allowPlaintextV1) throw new PlaintextV1RefusedError("flag-required");
}
