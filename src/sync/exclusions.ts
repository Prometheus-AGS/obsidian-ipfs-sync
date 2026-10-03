import { sha256Hex } from "./hash";

/**
 * The one exclusion definition: publish, change detection and the manifest
 * hash all read it. `.ipfs-sync-fixture` is listed so the fixture marker is an
 * ordinary vault file that is never published. `.obsidian/plugins/ipfs-sync/data.json` is the
 * plugin's own data file: it holds the auth secrets and must never leave the device (mvp-04). The whole `.obsidian/` configuration folder is device-local (mvp-07a 1.3): it is never published, and pull refuses it (a pulled plugin file would be code execution). It contains plugin code, plugin data and the plugin's own `data.json`. A vault whose configuration folder is renamed adds that folder as an extra exclusion (`exclusionsWithConfigDir`). `.smart-env/` is the Smart Connections embeddings folder: it is rewritten about every 13 s while editing, which would defeat the idle path and consume the history cap, and the plugin's author advises excluding it from third-party sync. It is rebuilt locally on each device.
 */
export const DEFAULT_EXCLUSIONS: readonly string[] = [
  ".trash/",
  ".ipfs-sync/",
  ".ipfs-sync-fixture",
  ".DS_Store",
  ".obsidian/",
  "node_modules/",
  ".git/",
  ".smart-env/",
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

function ruleMatches(rule: Rule, prefix: string | undefined, segment: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  return rule.anchored ? prefix === rule.value : segment === rule.value;
}

/** Sorted, de-duplicated effective list: the defaults plus `extra`. */
export function effectiveExclusions(extra: readonly string[] = []): readonly string[] {
  const entries = [...DEFAULT_EXCLUSIONS, ...extra].map(normalizeEntry).filter((entry) => entry !== "");
  return [...new Set(entries)].sort();
}

export type ExclusionMatcher = (path: string, isDirectory?: boolean) => boolean;

/**
 * A matcher over already-split segments. The anchored prefix is built incrementally (one concatenation per segment, and only
 * while it can still be as long as the longest anchored rule), so a path of any depth costs time linear in its segments
 * (mvp-07a final review B1-01: the old `segments.slice(0, index + 1).join("/")` per segment was quadratic in depth).
 */
export function createSegmentMatcher(
  rules: readonly { readonly anchored: boolean; readonly directoryOnly: boolean; readonly value: string }[],
  split: (path: string) => readonly string[],
): ExclusionMatcher {
  const longestAnchored = rules.reduce((longest, rule) => (rule.anchored ? Math.max(longest, rule.value.length) : longest), -1);
  return (path, isDirectory = false) => {
    const segments = split(path);
    let prefix: string | undefined = "";
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index] as string;
      if (prefix !== undefined) {
        prefix = index === 0 ? segment : `${prefix}/${segment}`;
        if (prefix.length > longestAnchored) prefix = undefined;
      }
      const isDir = index < segments.length - 1 || isDirectory;
      if (rules.some((rule) => ruleMatches(rule, prefix, segment, isDir))) return true;
    }
    return false;
  };
}

/** Build a matcher once and reuse it across a scan. A path is excluded when it or any ancestor directory matches. */
export function createExclusionMatcher(extra: readonly string[] = []): ExclusionMatcher {
  return createSegmentMatcher(effectiveExclusions(extra).map(parseRule), segmentsOf);
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
