import { sha256Hex } from "./hash";

/**
 * The one exclusion definition: publish, change detection and the manifest
 * hash all read it. `.ipfs-sync-fixture` is listed so the fixture marker is an
 * ordinary vault file that is never published. `.obsidian/plugins/ipfs-sync/data.json` is the
 * plugin's own data file: it holds the auth secrets and must never leave the device (mvp-04). `.obsidian/plugins/` (plugin code and plugin data) is device-local: it is never published, and pull refuses it (a pulled plugin file would be code execution).
 */
export const DEFAULT_EXCLUSIONS: readonly string[] = [
  ".trash/",
  ".ipfs-sync/",
  ".ipfs-sync-fixture",
  ".DS_Store",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/workspace.json.bak",
  ".obsidian/graph.json",
  ".obsidian/cache",
  ".obsidian/plugins/",
  ".obsidian/plugins/ipfs-sync/data.json",
  "node_modules/",
  ".git/",
];

/**
 * Matching rules (same as the sync-exclusions spec):
 * - `name/`  a directory called `name` at any depth, and everything beneath it
 * - `name`   a file or directory called `name` at any depth
 * - `a/b`    anchored at the vault root; matches that path (and beneath it, when a directory)
 * - `a/b/`   anchored directory
 * Paths are vault-relative with `/` separators; backslashes are normalised first.
 */
interface Rule {
  readonly anchored: boolean;
  readonly directoryOnly: boolean;
  readonly value: string;
}

function toSlashes(text: string): string {
  return text.replaceAll("\\", "/");
}

function normalizeEntry(entry: string): string {
  return toSlashes(entry.trim());
}

function parseRule(entry: string): Rule {
  const directoryOnly = entry.endsWith("/");
  const value = entry.replace(/\/+$/, "");
  return { anchored: value.includes("/"), directoryOnly, value };
}

function segmentsOf(path: string): readonly string[] {
  return toSlashes(path)
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
}

function ruleMatches(rule: Rule, prefix: string, segment: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  return rule.anchored ? prefix === rule.value : segment === rule.value;
}

/** Sorted, de-duplicated effective list: the defaults plus `extra`. */
export function effectiveExclusions(extra: readonly string[] = []): readonly string[] {
  const entries = [...DEFAULT_EXCLUSIONS, ...extra].map(normalizeEntry).filter((entry) => entry !== "");
  return [...new Set(entries)].sort();
}

export type ExclusionMatcher = (path: string, isDirectory?: boolean) => boolean;

/** Build a matcher once and reuse it across a scan. A path is excluded when it or any ancestor directory matches. */
export function createExclusionMatcher(extra: readonly string[] = []): ExclusionMatcher {
  const rules = effectiveExclusions(extra).map(parseRule);
  return (path, isDirectory = false) => {
    const segments = segmentsOf(path);
    return segments.some((segment, index) => {
      const prefix = segments.slice(0, index + 1).join("/");
      const isDir = index < segments.length - 1 || isDirectory;
      return rules.some((rule) => ruleMatches(rule, prefix, segment, isDir));
    });
  };
}

export function isExcluded(path: string, extra: readonly string[] = [], isDirectory = false): boolean {
  return createExclusionMatcher(extra)(path, isDirectory);
}

/**
 * sha256 (lowercase hex) of the effective list sorted by UTF-16 code unit and joined
 * with a single `\n`, no trailing newline. This exact form is what mvp-03 compares
 * across devices.
 */
export async function excludesHash(extra: readonly string[] = []): Promise<string> {
  return sha256Hex(new TextEncoder().encode(effectiveExclusions(extra).join("\n")));
}
