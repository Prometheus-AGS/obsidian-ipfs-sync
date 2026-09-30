import type { Bytes } from "../core/host-bridge";
import { ABANDON_HOW } from "./abandon-hint";
import type { EncryptedManifest } from "./encrypted-manifest";
import { LocalManifestError, parseLocalManifest } from "./local-manifest";

/**
 * Shared readers for the per-root local files (state and journal). They are read before any key exists, so they
 * check shapes and formats only. Messages never advise deleting the file: a record that cannot be used is
 * reported with the explicit recovery actions of the publish flow.
 */

/**
 * A local state or journal file that cannot be used. The message names the explicit recovery actions and never
 * advises deleting the file: `--repair` continues from the node when the node authenticates, and the abandon
 * action starts a new vault in a new MFS root.
 */
export class RootStateError extends Error {
  constructor(what: string) {
    super(
      `the local record for this MFS root is unusable: ${what}. Run publish with --repair to continue from the node (changes made by any other publisher will be discarded), ` +
        `or abandon this vault (${ABANDON_HOW}) and publish to a new MFS root.`,
    );
    this.name = "RootStateError";
  }
}

export const HEX32 = /^[0-9a-f]{32}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const CID_TOKEN = /^[A-Za-z0-9]{10,128}$/;

export type JsonRecord = Readonly<Record<string, unknown>>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(bytes: Bytes, what: string): JsonRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RootStateError(`${what} is not valid JSON`);
  }
  if (!isJsonRecord(raw)) throw new RootStateError(`${what} is not an object`);
  return raw;
}

export function requireText(record: JsonRecord, key: string, expected: RegExp | undefined, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "" || (expected !== undefined && !expected.test(value))) {
    throw new RootStateError(`${what} field "${key}" is missing or malformed`);
  }
  return value;
}

/** Modification times keyed by path. Built with `fromEntries`, so a path named `__proto__` is data. */
export function parseMtimes(value: unknown, what: string): Readonly<Record<string, number>> {
  if (!isJsonRecord(value)) throw new RootStateError(`${what} mtimes is not an object`);
  const entries = Object.entries(value).map(([path, mtime]) => {
    if (typeof mtime !== "number" || !Number.isFinite(mtime)) throw new RootStateError(`${what} has a modification time that is not a number`);
    return [path, mtime] as const;
  });
  return Object.fromEntries(entries);
}

export function parseManifestField(value: unknown, what: string): EncryptedManifest {
  try {
    return parseLocalManifest(value);
  } catch (error) {
    if (error instanceof LocalManifestError) throw new RootStateError(`${what} manifest: ${error.message}`);
    throw error;
  }
}
