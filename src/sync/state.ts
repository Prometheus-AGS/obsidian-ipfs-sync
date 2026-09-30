import type { Bytes, HostKv } from "../core/host-bridge";
import { validateManifest, type Manifest } from "./manifest";
import { stableStringify } from "./stable-json";

/** KV key of the last-published record; the Node host stores it as `<vault>/.ipfs-sync/state.json`. */
export const STATE_KEY = "state.json";

const STATE_VERSION = 1;

/**
 * What the last successful publish left behind. Holds no credentials.
 * `mtimes` feeds the size/mtime pre-filter; `mfsRoot` and `key` tie the record to
 * the destination it describes, so publishing elsewhere does not trust it.
 */
export interface LocalState {
  readonly version: typeof STATE_VERSION;
  readonly mfsRoot: string;
  readonly key: string;
  /** CID of `<mfsRoot>` that was published to the key. */
  readonly rootCid: string;
  readonly manifest: Manifest;
  readonly mtimes: Readonly<Record<string, number>>;
}

export class StateError extends Error {
  constructor(message: string) {
    super(`${message} (${STATE_KEY} in the vault's .ipfs-sync folder)`);
    this.name = "StateError";
  }
}

export type LocalStateInput = Omit<LocalState, "version">;

export function buildState(input: LocalStateInput): LocalState {
  return { version: STATE_VERSION, ...input };
}

export function encodeState(state: LocalState): Bytes {
  return new TextEncoder().encode(`${stableStringify(state, 2)}\n`);
}

function parseMtimes(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StateError("state mtimes is not an object");
  const entries = Object.entries(value).map(([path, mtime]) => {
    if (typeof mtime !== "number" || !Number.isFinite(mtime)) throw new StateError(`state mtime for "${path}" is not a number`);
    return [path, mtime] as const;
  });
  return Object.fromEntries(entries);
}

export function decodeState(bytes: Bytes): LocalState {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new StateError(`state is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof raw !== "object" || raw === null) throw new StateError("state is not an object");
  const record = raw as Readonly<Record<string, unknown>>;
  if (record["version"] !== STATE_VERSION) throw new StateError(`unsupported state version ${String(record["version"])}`);
  const { mfsRoot, key, rootCid } = record;
  if (typeof mfsRoot !== "string" || typeof key !== "string" || typeof rootCid !== "string") {
    throw new StateError("state lacks mfsRoot, key or rootCid");
  }
  return buildState({ mfsRoot, key, rootCid, manifest: validateManifest(record["manifest"]), mtimes: parseMtimes(record["mtimes"]) });
}

export async function readState(kv: Pick<HostKv, "get">): Promise<LocalState | undefined> {
  const bytes = await kv.get(STATE_KEY);
  return bytes === undefined ? undefined : decodeState(bytes);
}

export async function writeState(kv: Pick<HostKv, "set">, state: LocalState): Promise<void> {
  await kv.set(STATE_KEY, encodeState(state));
}
