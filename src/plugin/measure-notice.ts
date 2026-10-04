import { DEFAULT_KDF_PARAMS, describeKdfCost } from "../crypto";
import { escapeForDisplay } from "../sync/path-policy";

/**
 * The words of the "IPFS Sync: Measure key derivation time" command (mvp-07b spec "Measure key derivation time"). The command itself
 * (task 2.2) runs one derivation at the default cost on random input and hands this module the record; nothing here touches a vault or a
 * passphrase. The build hash prefix is the first 16 hex characters of the sha256 of the installed `main.js`; it is shown in groups of four
 * because a 64-character hash is error-prone to read off a phone screen.
 */

export interface MeasurementRecord {
  /** Elapsed seconds of the derivation. */
  readonly seconds: number;
  /** The device platform label. */
  readonly platform: string;
  /** True only after the derivation returned. */
  readonly completed: boolean;
  /** The longest event-loop gap in milliseconds seen by the heartbeat; absent when it was not measured. */
  readonly longestGapMs: number | undefined;
  /** The first 16 hex characters of the installed plugin file's sha256; absent when the file could not be read. */
  readonly buildHashPrefix: string | undefined;
}

export const MEASURE_START_NOTICE =
  "Measuring key derivation time at the default cost. It uses no vault data and no passphrase. Please keep the app open until it finishes.";

const HASH_PREFIX = /^[0-9a-fA-F]{16}$/;

/** `a1b2c3d4e5f60718` as `a1b2 c3d4 e5f6 0718`; undefined when the prefix is not exactly sixteen hex characters. */
export function groupBuildHash(prefix: string | undefined): string | undefined {
  if (prefix === undefined || !HASH_PREFIX.test(prefix)) return undefined;
  return prefix.replace(/(.{4})(?=.)/g, "$1 ");
}

const secondsText = (seconds: number): string => (Number.isFinite(seconds) && seconds >= 0 ? seconds.toFixed(2) : "unknown");

export function measurementNoticeText(record: MeasurementRecord): string {
  const hash = groupBuildHash(record.buildHashPrefix);
  const gap = record.longestGapMs === undefined || !Number.isFinite(record.longestGapMs) ? "not measured" : `${Math.round(record.longestGapMs)} ms`;
  return [
    `Key derivation measured at ${describeKdfCost(DEFAULT_KDF_PARAMS)}.`,
    `Seconds: ${secondsText(record.seconds)}`,
    `Platform: ${escapeForDisplay(record.platform)}`,
    `Completed: ${record.completed ? "yes" : "no"}`,
    `Longest event-loop gap: ${gap}`,
    hash === undefined ? "Build hash: unavailable" : `Build hash (first 16 characters): ${hash}`,
  ].join("\n");
}
