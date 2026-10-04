import { createKeySlots, generatePassphrase, wipe } from "../crypto";
import { sha256Hex } from "../sync/hash";
import type { MeasurementRecord } from "./measure-notice";

/**
 * The work behind "IPFS Sync: Measure key derivation time" (mvp-07b spec "Measure key derivation time"). It times ONE Argon2id derivation at the
 * default cost in the foreground and reports what the phone did. It touches no vault, no settings, no node and no passphrase of the user's: the input
 * is a passphrase generated here and thrown away, and the only file it reads is the installed plugin `main.js`, so the recorder can check which build
 * produced the number.
 *
 * The derivation goes through the public key-slot creation path (`generatePassphrase` and `createKeySlots`, which runs exactly one derivation at
 * `DEFAULT_KDF_PARAMS`). No crypto internals are imported and no allow-list entry is needed. The result of `createKeySlots` is dropped unread.
 */

/** The heartbeat interval. A stalled event loop shows up as a gap far longer than this between two ticks. */
export const HEARTBEAT_MS = 10;

/** Hex characters of the build hash that are kept: sixteen, shown in four groups of four. */
const BUILD_HASH_CHARS = 16;

/** The two timer functions the heartbeat needs, so a test can drive them by hand. */
export interface HeartbeatTimers {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface MeasureDeps {
  /** The bytes of the installed plugin `main.js`, read through the vault adapter. Rejects when the file cannot be read. */
  readonly readBuild: () => Promise<ArrayBuffer>;
  /** The device platform label, for example `ios`. */
  readonly platform: string;
  /** Milliseconds on a monotonic clock. Defaults to `performance.now`. */
  readonly now?: () => number;
  /** The derivation to time. Defaults to one key-slot creation at the default cost on a freshly generated passphrase. */
  readonly derive?: () => Promise<void>;
  /** Defaults to the global timers. */
  readonly timers?: HeartbeatTimers;
}

const globalTimers: HeartbeatTimers = {
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

/** One derivation at the default cost on a passphrase nobody will ever see again. */
async function deriveOnce(): Promise<void> {
  const passphrase = generatePassphrase();
  try {
    await createKeySlots({ passphrase });
  } finally {
    wipe(passphrase);
  }
}

/** The first sixteen hex characters of the sha256 of the installed `main.js`, or `undefined` when the file cannot be read. */
async function buildHashPrefix(readBuild: MeasureDeps["readBuild"]): Promise<string | undefined> {
  try {
    return (await sha256Hex(new Uint8Array(await readBuild()))).slice(0, BUILD_HASH_CHARS);
  } catch {
    // The record says the hash is unavailable; the cause (a missing or unreadable file) changes nothing the reader can do.
    return undefined;
  }
}

/** Measure one derivation. Never throws for a failed derivation: that is `completed: false` in the record. */
export async function measureDerivation(deps: MeasureDeps): Promise<MeasurementRecord> {
  const now = deps.now ?? ((): number => performance.now());
  const timers = deps.timers ?? globalTimers;
  const derive = deps.derive ?? deriveOnce;
  // Read before the clock starts: the file read is not part of the number being measured.
  const hash = await buildHashPrefix(deps.readBuild);
  let lastTick = now();
  let longestGap = 0;
  const heartbeat = timers.setInterval(() => {
    const tick = now();
    longestGap = Math.max(longestGap, tick - lastTick);
    lastTick = tick;
  }, HEARTBEAT_MS);
  const started = now();
  let completed = false;
  try {
    await derive();
    completed = true;
  } catch {
    // A derivation that did not finish (out of memory on a small phone, for one) is the finding; the record carries `completed: no`.
  } finally {
    timers.clearInterval(heartbeat);
  }
  const ended = now();
  // The stretch from the last tick to the end counts: a loop blocked for the whole derivation never ticked at all.
  longestGap = Math.max(longestGap, ended - lastTick);
  return { seconds: (ended - started) / 1000, platform: deps.platform, completed, longestGapMs: longestGap, buildHashPrefix: hash };
}
