import type { HostFs } from "../core/host-bridge";
import { isExcluded } from "./exclusions";
import { hashFile } from "./hash";
import { HostReadCapError } from "./host-errors";
import type { Manifest, ManifestFile } from "./manifest";
import type { LocalState } from "./state";
import { findSymlink, type SymlinkCache } from "./symlink-guard";
import { evaluatePathPolicy, type PathPolicyOptions } from "./path-policy";
import { decideThreeWay, type ThreeWayOutcome } from "./three-way";

import { STATE_FOLDER, untrustedPathReason } from "./manifest-paths";

export { STATE_FOLDER, untrustedPathReason };

/** Plugin code and data are device-local. Refused whatever the local exclusion list says (case-insensitive volumes). */
const DEVICE_LOCAL_PREFIX = ".obsidian/plugins";
/** Obsidian's configuration folder (themes, snippets, hotkeys, core settings): not written from a pulled manifest either. */
const CONFIG_FOLDER = ".obsidian";

/**
 * Why a manifest path must not be written although it is well formed: it lies under `.obsidian/` (configuration and,
 * above all, plugins), or it matches the effective exclusion list (defaults plus this device's additions). A legitimate manifest never
 * contains such paths, because publish applies the same list; one that does is forged or from a divergent build.
 */
export function excludedPathReason(path: string, extraExclusions: readonly string[]): string | undefined {
  const lower = path.toLowerCase();
  if (lower === DEVICE_LOCAL_PREFIX || lower.startsWith(`${DEVICE_LOCAL_PREFIX}/`)) return "device-local plugin path (.obsidian/plugins/)";
  // Obsidian's own configuration must not arrive from the network: a forged theme, snippet or hotkey file changes what the app runs.
  if (lower === CONFIG_FOLDER || lower.startsWith(`${CONFIG_FOLDER}/`)) return "Obsidian configuration folder (.obsidian/)";
  return isExcluded(path, extraExclusions) ? "matches the exclusion list; a legitimate manifest never contains it" : undefined;
}

// The decision table moved to three-way.ts (mvp-07a task 4.5) so the encrypted planner shares it; re-exported so existing imports keep working.
export { decideThreeWay, type ThreeWayOutcome };

export type PullDecision =
  | { readonly kind: "unchanged"; readonly path: string; readonly entry: ManifestFile; readonly mtimeMs: number }
  | { readonly kind: "fetch"; readonly path: string; readonly entry: ManifestFile }
  | { readonly kind: "replace"; readonly path: string; readonly entry: ManifestFile }
  | { readonly kind: "conflict"; readonly path: string; readonly entry: ManifestFile; readonly localSha256: string }
  | { readonly kind: "locally-modified"; readonly path: string; readonly entry: ManifestFile }
  | { readonly kind: "refused"; readonly path: string; readonly reason: string };

export interface PullPlan {
  /** One decision per manifest path, sorted by path. */
  readonly decisions: readonly PullDecision[];
  /** Paths in the previous record that the manifest no longer lists (reported, never deleted). */
  readonly remoteDeleted: readonly string[];
  /** How many local files had to be hashed. */
  readonly hashed: number;
}

export interface PlanInput {
  readonly fs: Pick<HostFs, "stat" | "lstat" | "read" | "readRange">;
  readonly manifest: Manifest;
  /** The applicable local record (already checked against the destination), or undefined. */
  readonly previous: LocalState | undefined;
  /** Ignore the record's mtime shortcut and hash every local file (exclusion-list divergence). */
  readonly forceVerify: boolean;
  /** This device's additions to the default exclusions; manifest paths matching the effective list are refused. */
  readonly extraExclusions?: readonly string[];
  /** The host's configuration folder name when it is not `.obsidian` (the plugin's `vault.configDir`); the path policy protects it too. */
  readonly configDir?: string;
}

/** The options the path policy is evaluated with, for the plan and for the write-time re-check. */
export function policyOptionsFor(input: { readonly configDir?: string; readonly extraExclusions?: readonly string[] }): PathPolicyOptions {
  return { configDir: input.configDir, extraExclusions: input.extraExclusions };
}

/** Own-property lookup, so a manifest path such as `constructor` cannot match an inherited member. */
function lookup<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

interface Local {
  readonly sha256: string | undefined;
  readonly mtimeMs: number;
  readonly hashed: boolean;
}

/** The local sha256 of `path`, or undefined when missing; trusts the record when size and mtime still match. */
async function inspectLocal(
  input: PlanInput,
  path: string,
  base: ManifestFile | undefined,
): Promise<Local | { readonly refusal: string }> {
  const info = await input.fs.stat(path);
  if (info === undefined) return { sha256: undefined, mtimeMs: 0, hashed: false };
  if (info.kind !== "file") return { refusal: "a directory exists at this path" };
  const recorded = lookup(input.previous?.mtimes, path);
  if (!input.forceVerify && base !== undefined && base.size === info.size && recorded === info.mtimeMs) {
    return { sha256: base.sha256, mtimeMs: info.mtimeMs, hashed: false };
  }
  try {
    return { sha256: await hashFile(input.fs, path, info.size), mtimeMs: info.mtimeMs, hashed: true };
  } catch (error) {
    // A host with a read cap (Obsidian) refuses a file it cannot load: that file fails, the others go on.
    if (error instanceof HostReadCapError) return { refusal: error.message };
    throw error;
  }
}

async function decideFile(
  input: PlanInput,
  path: string,
  entry: ManifestFile,
  cache: SymlinkCache,
  policyReason: string | undefined,
): Promise<{ readonly decision: PullDecision; readonly hashed: boolean }> {
  const untrusted = untrustedPathReason(path) ?? excludedPathReason(path, input.extraExclusions ?? []) ?? policyReason;
  if (untrusted !== undefined) return { decision: { kind: "refused", path, reason: untrusted }, hashed: false };
  const link = await findSymlink(input.fs, path, cache);
  if (link !== undefined) return { decision: { kind: "refused", path, reason: `symlink at "${link}"` }, hashed: false };

  const base = lookup(input.previous?.manifest.files, path);
  const local = await inspectLocal(input, path, base);
  if ("refusal" in local) return { decision: { kind: "refused", path, reason: local.refusal }, hashed: false };

  const outcome = decideThreeWay(local.sha256, base?.sha256, entry.sha256);
  return { decision: toDecision(outcome, path, entry, local), hashed: local.hashed };
}

function toDecision(outcome: ThreeWayOutcome, path: string, entry: ManifestFile, local: Local): PullDecision {
  switch (outcome) {
    case "unchanged":
      return { kind: "unchanged", path, entry, mtimeMs: local.mtimeMs };
    case "conflict":
      // A conflict needs a local file, so `sha256` is set; the table returns "fetch" for a missing one.
      return { kind: "conflict", path, entry, localSha256: local.sha256 ?? "" };
    default:
      return { kind: outcome, path, entry };
  }
}

/**
 * Decide, for every manifest path, what pull does with it. Files are inspected one at a time so memory
 * stays bounded. Nothing is written; refusals (untrusted path, symlink) are decisions, not exceptions.
 */
export async function planPull(input: PlanInput): Promise<PullPlan> {
  const cache: SymlinkCache = new Map();
  const paths = Object.keys(input.manifest.files).sort();
  // The same path policy the decrypting pull applies, over the whole manifest before anything is read from disk or fetched: alias
  // forms of the protected folders, Windows forms, short names and the collision groups. Every refusal is a failed path here.
  const policyReasons = new Map(evaluatePathPolicy(paths, policyOptionsFor(input)).refusals.map((refusal) => [refusal.path, refusal.reason] as const));
  const decisions: PullDecision[] = [];
  let hashed = 0;
  for (const path of paths) {
    const entry = input.manifest.files[path] as ManifestFile;
    const result = await decideFile(input, path, entry, cache, policyReasons.get(path));
    decisions.push(result.decision);
    if (result.hashed) hashed += 1;
  }
  const remoteDeleted = Object.keys(input.previous?.manifest.files ?? {})
    .filter((path) => !Object.hasOwn(input.manifest.files, path))
    .sort();
  return { decisions, remoteDeleted, hashed };
}
