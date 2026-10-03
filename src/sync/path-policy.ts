/**
 * Path policy for pulled manifests (mvp-07a design decision 11, spec `path-hardening`). Pure: no I/O.
 *
 * The pull evaluates it over the whole authenticated manifest before any blob is requested and again at write time. It is
 * NOT applied inside the manifest decoder (`manifest-paths.ts` `untrustedPathReason` is unchanged): the publisher decodes
 * its own manifests, and an honest Linux vault may hold names such as `CON.md` that a pull must refuse. The publisher gets
 * `adviseUnrestorablePaths` instead, a warning that never refuses.
 *
 * Every refusal carries a severity and, for `unsafe`, a class:
 * - `expected`: the configuration folder, or a match of the effective exclusion list (what an older build's manifest holds);
 * - `unsafe`/`shape`: a shape an honest publisher never produces (empty, absolute, backslash, control character, empty or
 *   dot segment, a protected folder name by fold key including the plugins folder, the state folder);
 * - `unsafe`/`platform`: a path an honest publisher on another platform can produce (Windows forms, reserved names, 8.3
 *   shapes, collision groups, file and directory prefix groups).
 *
 * Reasons are fixed strings that never echo the path, so a hostile path cannot reach a message through them. Paths that
 * are shown go through `escapeForDisplay`.
 */
import { createSegmentMatcher, effectiveExclusions, type ExclusionMatcher } from "./exclusions";
import { STATE_FOLDER } from "./manifest-paths";
import { foldKey } from "./path-fold";
import { DEFAULT_IGNORABLE_RANGES } from "./path-fold-table";
import { PATH_LIMITS, pathLimitViolation, type PathLimitViolation } from "./path-limits";

export type PolicyCode =
  | "empty-path"
  | "absolute-path"
  | "backslash"
  | "control-character"
  | PathLimitViolation
  | "dot-segment"
  | "state-folder"
  | "vcs-folder"
  | "config-folder-name"
  | "plugin-folder"
  | "config-folder"
  | "excluded"
  | "trailing-dot-or-space"
  | "stream-syntax"
  | "reserved-name"
  | "short-name"
  | "case-collision"
  | "file-directory-prefix";

interface RefusalBase {
  readonly path: string;
  readonly code: PolicyCode;
  /** A fixed sentence about the rule; it does not contain the path. */
  readonly reason: string;
  /** For the two group rules: the first three members of the group by UTF-16 code unit order (frozen, shared by the whole group), this path not necessarily among them. */
  readonly group?: readonly string[];
  /** For the two group rules: how many paths the group holds. */
  readonly groupSize?: number;
}
export type PolicyRefusal =
  | (RefusalBase & { readonly severity: "expected" })
  | (RefusalBase & { readonly severity: "unsafe"; readonly class: "shape" | "platform" });

export interface PathPolicyOptions {
  /** The host's configuration folder name (`vault.configDir` in the plugin). `.obsidian` is always protected. */
  readonly configDir?: string;
  /** This device's additions to the default exclusion list (matched with the fold key, by the pull-only matcher). */
  readonly extraExclusions?: readonly string[];
}

export interface PathPolicyResult {
  /** Paths the policy lets through, sorted by UTF-16 code unit. */
  readonly accepted: readonly string[];
  /** One refusal per refused path, sorted by path. */
  readonly refusals: readonly PolicyRefusal[];
}

const VCS_FOLDER = ".git";
const OBSIDIAN_FOLDER = ".obsidian";
const PLUGINS_SEGMENT = "plugins";
const C0_C1_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DRIVE_LETTER = /^[A-Za-z]:/;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
/** Design decision 11 (Q-09): a short name of at most six characters, `~`, digits, an optional extension of at most three. */
const SHORT_NAME = /^([^.~/]{1,6})~[0-9]+(\.[^./]{0,3})?$/iu;
/** The most names a summary shows; the rest are a count. */
export const SUMMARY_NAME_LIMIT = 3;

/** UTF-16 code unit ranges (inclusive) that are escaped when a path or node text is shown. Written as numbers so no invisible character sits in the source. */
const DISPLAY_ESCAPE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and the C1 controls (0x9b is the control sequence introducer)
  [0x061c, 0x061c], // Arabic letter mark
  [0x200e, 0x200f], // left-to-right and right-to-left marks
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2066, 0x2069], // bidirectional isolates
];

const compareUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- output ---------------------------------------------------------------------------------------------------

/** Unicode general category Cf (format): joiners, bidi marks, soft hyphen, byte order mark, tag characters, the Arabic number signs. */
const FORMAT_CHARACTER = /^\p{Cf}$/u;

const inRanges = (ranges: readonly (readonly [number, number])[], codePoint: number): boolean =>
  ranges.some(([low, high]) => codePoint >= low && codePoint <= high);

function needsEscape(character: string, codePoint: number): boolean {
  return inRanges(DISPLAY_ESCAPE_RANGES, codePoint) || inRanges(DEFAULT_IGNORABLE_RANGES, codePoint) || FORMAT_CHARACTER.test(character);
}

const hex = (codePoint: number): string =>
  codePoint > 0xffff ? `\\u{${codePoint.toString(16)}}` : `\\u${codePoint.toString(16).padStart(4, "0")}`;

/**
 * Escape what a reader cannot see or that rewrites what they see, for any path or node text that is shown: C0, DEL and C1
 * control characters (U+009B included), bidirectional controls, Default_Ignorable_Code_Point characters (zero-width, soft
 * hyphen, variation selectors, tag characters, fillers) and the Cf category. A character in the basic plane becomes a
 * backslash, `u` and four hex digits; one above it becomes `\u{` and its hex digits `}`. This is display only: it changes
 * which paths are refused in no way (mvp-07a final review B1-05).
 */
export function escapeForDisplay(text: string): string {
  let out = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    out += needsEscape(character, codePoint) ? hex(codePoint) : character;
  }
  return out;
}

/** `"a" (reason), "b" (reason), "c" (reason) and N more`: at most three names, the rest a count. Escaped. */
export function summarizeRefusals(refusals: readonly PolicyRefusal[]): string {
  const shown = refusals.slice(0, SUMMARY_NAME_LIMIT).map((refusal) => `"${escapeForDisplay(refusal.path)}" (${refusal.reason})`);
  const more = refusals.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

// ---- pull-only exclusion matcher ----------------------------------------------------------------------------

interface FoldedRule {
  readonly anchored: boolean;
  readonly directoryOnly: boolean;
  readonly value: string;
}

function foldRule(entry: string): FoldedRule {
  const directoryOnly = entry.endsWith("/");
  const value = entry.replace(/\/+$/, "");
  return { anchored: value.includes("/"), directoryOnly, value: value.split("/").map(foldKey).join("/") };
}

/**
 * The exclusion matcher the PULL uses: the same rules and the same effective list as `createExclusionMatcher`, but a
 * segment and a rule are compared by fold key, so `Private/` also matches `private/`. Used only by the pull (and by the
 * policy in this module). The publisher, the scan and the idle check keep the case-sensitive `createExclusionMatcher`,
 * so what is published does not change.
 */
export function createPullExclusionMatcher(extra: readonly string[] = []): ExclusionMatcher {
  return createSegmentMatcher(effectiveExclusions(extra).map(foldRule), (path) =>
    path
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment !== "" && segment !== ".")
      .map(foldKey),
  );
}

// ---- single-path rules ------------------------------------------------------------------------------------------

interface PolicyContext {
  /** Fold keys of the protected configuration folder names (`.obsidian`, the host's); a key may hold `/` when the host's folder is nested. */
  readonly configKeys: readonly string[];
  /** Protected folder names without the leading dot, as fold keys: the 8.3 prefix check compares against these. */
  readonly shortNameTargets: readonly string[];
  readonly excluded: ExclusionMatcher;
}

function buildContext(options: PathPolicyOptions): PolicyContext {
  const names = [OBSIDIAN_FOLDER, ...(options.configDir === undefined ? [] : [options.configDir])];
  const configKeys = [
    ...new Set(
      names
        .map((name) => name.replaceAll("\\", "/").split("/").filter((part) => part !== "").map(foldKey).join("/"))
        .filter((key) => key !== ""),
    ),
  ];
  const protectedKeys = [foldKey(STATE_FOLDER), foldKey(VCS_FOLDER), ...configKeys];
  const shortNameTargets = protectedKeys.map((key) => key.replace(/^\./, ""));
  return { configKeys, shortNameTargets, excluded: createPullExclusionMatcher(options.extraExclusions) };
}

function unsafe(path: string, cls: "shape" | "platform", code: PolicyCode, reason: string): PolicyRefusal {
  return { path, severity: "unsafe", class: cls, code, reason };
}

const LIMIT_REASONS: Readonly<Record<PathLimitViolation, string>> = {
  "path-too-long": `path is longer than ${PATH_LIMITS.maxPathBytes} bytes`,
  "segment-too-long": `a path segment is longer than ${PATH_LIMITS.maxSegmentBytes} bytes`,
  "too-many-segments": `path has more than ${PATH_LIMITS.maxSegments} segments`,
};

function shapeRefusal(path: string): PolicyRefusal | undefined {
  // First, before any scan or split: a path of a million segments must cost O(1) here (mvp-07a final review B1-01).
  const limit = pathLimitViolation(path);
  if (limit !== undefined) return unsafe(path, "shape", limit, LIMIT_REASONS[limit]);
  if (path === "") return unsafe(path, "shape", "empty-path", "empty path");
  if (path.startsWith("/") || DRIVE_LETTER.test(path)) return unsafe(path, "shape", "absolute-path", "absolute path");
  if (path.includes("\\")) return unsafe(path, "shape", "backslash", "backslash in path");
  if (C0_C1_CONTROL.test(path)) return unsafe(path, "shape", "control-character", "control character in path");
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return unsafe(path, "shape", "dot-segment", "empty, . or .. path segment");
  }
  return undefined;
}

/** The state folder, a VCS folder, the configuration folder and its plugins folder, all compared by fold key. */
function protectedRefusal(path: string, keys: readonly string[], context: PolicyContext): PolicyRefusal | undefined {
  if (keys[0] === foldKey(STATE_FOLDER)) return unsafe(path, "shape", "state-folder", "inside the state folder");
  if (keys.includes(foldKey(VCS_FOLDER))) return unsafe(path, "shape", "vcs-folder", "inside a version-control folder");
  for (const folder of context.configKeys) {
    const depth = folder.split("/").length;
    if (keys.slice(0, depth).join("/") !== folder) continue;
    if (keys.length === depth) return unsafe(path, "shape", "config-folder-name", "names the configuration folder itself");
    if (keys[depth] === PLUGINS_SEGMENT) return unsafe(path, "shape", "plugin-folder", "inside the plugins folder of the configuration folder");
    return { path, severity: "expected", code: "config-folder", reason: "inside the configuration folder" };
  }
  return undefined;
}

function isReservedDeviceName(segmentKey: string): boolean {
  const dot = segmentKey.indexOf(".");
  const base = (dot < 0 ? segmentKey : segmentKey.slice(0, dot)).replace(/ +$/, "");
  return RESERVED_DEVICE_NAME.test(base);
}

function isProtectedShortName(segment: string, context: PolicyContext): boolean {
  const captured = SHORT_NAME.exec(segment)?.[1];
  if (captured === undefined) return false;
  const prefix = foldKey(captured);
  return context.shortNameTargets.some((target) => target.startsWith(prefix));
}

/** Windows forms, refused on every host because the vault may be synced to Windows. Dot, space and `:` are tested on the raw segment (the characters NTFS itself treats specially). */
function platformRefusal(path: string, keys: readonly string[], context: PolicyContext): PolicyRefusal | undefined {
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment.endsWith(".") || segment.endsWith(" ")) return unsafe(path, "platform", "trailing-dot-or-space", "a segment ends in a dot or a space");
    if (segment.includes(":")) return unsafe(path, "platform", "stream-syntax", "a segment contains a colon");
    if (isReservedDeviceName(keys[index]!)) return unsafe(path, "platform", "reserved-name", "a segment is a reserved Windows device name");
    if (isProtectedShortName(segment, context)) return unsafe(path, "platform", "short-name", "a segment has the 8.3 short-name shape of a protected folder");
  }
  return undefined;
}

function refusePathWith(path: string, context: PolicyContext): PolicyRefusal | undefined {
  const shape = shapeRefusal(path);
  if (shape !== undefined) return shape;
  const keys = path.split("/").map(foldKey);
  const guarded = protectedRefusal(path, keys, context);
  if (guarded !== undefined) return guarded;
  if (context.excluded(path)) return { path, severity: "expected", code: "excluded", reason: "matches the exclusion list" };
  return platformRefusal(path, keys, context);
}

/**
 * The single-path rules only (no group rules): for the write-time re-check of one path. The group rules need the whole manifest;
 * a caller that has the plan keeps the refusals `evaluatePathPolicy` returned.
 */
export function refusePath(path: string, options: PathPolicyOptions = {}): PolicyRefusal | undefined {
  return refusePathWith(path, buildContext(options));
}

// ---- group rules ----------------------------------------------------------------------------------------------

const GROUP_REASONS = {
  "case-collision": "collides with another path that differs only in case or normalisation; rename one on the originating device",
  "file-directory-prefix": "is a file and also a directory of the same name; rename one on the originating device",
} as const;

/**
 * One group, built once per key: the first `SUMMARY_NAME_LIMIT` members by code unit order and a count. Nothing else is kept
 * per group, so building a group of n members costs O(n) time and O(1) memory (mvp-07a final review B1-02: the old
 * copy-per-insert and copy-and-sort-per-member code was quadratic and gave a 20,000-member group about 3 GB of arrays).
 */
interface GroupAccumulator {
  readonly names: string[];
  count: number;
}

function newGroup(): GroupAccumulator {
  return { names: [], count: 0 };
}

function addMember(group: GroupAccumulator, name: string): void {
  group.count += 1;
  const { names } = group;
  if (names.length === SUMMARY_NAME_LIMIT && compareUnits(name, names[SUMMARY_NAME_LIMIT - 1] as string) >= 0) return;
  let at = names.length;
  while (at > 0 && compareUnits(name, names[at - 1] as string) < 0) at -= 1;
  names.splice(at, 0, name);
  if (names.length > SUMMARY_NAME_LIMIT) names.pop();
}

function groupRefusal(path: string, code: keyof typeof GROUP_REASONS, group: GroupAccumulator): PolicyRefusal {
  return { ...unsafe(path, "platform", code, GROUP_REASONS[code]), group: group.names, groupSize: group.count };
}

/** The shortest proper prefix of `keys` that is the key of a file, found without building a prefix twice. */
function firstFilePrefix(keys: readonly string[], byKey: ReadonlyMap<string, GroupAccumulator>): string | undefined {
  let prefix = "";
  for (let index = 0; index < keys.length - 1; index++) {
    prefix = index === 0 ? (keys[0] as string) : `${prefix}/${keys[index] as string}`;
    if (byKey.has(prefix)) return prefix;
  }
  return undefined;
}

/**
 * Collision and file/directory-prefix groups over the paths that passed the single-path rules. All members of a group are
 * refused. Linear in the paths: one accumulator per fold key, then one accumulator per file prefix that has descendants.
 */
function groupRefusals(accepted: readonly string[]): Map<string, PolicyRefusal> {
  const keysOf = new Map(accepted.map((path) => [path, path.split("/").map(foldKey)] as const));
  const byKey = new Map<string, GroupAccumulator>();
  for (const [path, keys] of keysOf) {
    const key = keys.join("/");
    const group = byKey.get(key) ?? newGroup();
    byKey.set(key, group);
    addMember(group, path);
  }
  for (const group of byKey.values()) Object.freeze(group.names);

  const refused = new Map<string, PolicyRefusal>();
  for (const [path, keys] of keysOf) {
    const group = byKey.get(keys.join("/")) as GroupAccumulator;
    if (group.count > 1) refused.set(path, groupRefusal(path, "case-collision", group));
  }

  // A file prefix group holds every file with that key and every path beneath it. A path joins the group of its shortest file
  // prefix; a file that has none joins the group of its own key, when that key has descendants.
  const owner = new Map<string, string>();
  const prefixGroups = new Map<string, GroupAccumulator>();
  for (const [path, keys] of keysOf) {
    const prefix = firstFilePrefix(keys, byKey);
    if (prefix === undefined) continue;
    owner.set(path, prefix);
    let group = prefixGroups.get(prefix);
    if (group === undefined) {
      const files = byKey.get(prefix) as GroupAccumulator;
      group = { names: [...files.names], count: files.count };
      prefixGroups.set(prefix, group);
    }
    addMember(group, path);
  }
  for (const group of prefixGroups.values()) Object.freeze(group.names);
  for (const [path, keys] of keysOf) {
    if (refused.has(path)) continue;
    const group = prefixGroups.get(owner.get(path) ?? keys.join("/"));
    if (group !== undefined) refused.set(path, groupRefusal(path, "file-directory-prefix", group));
  }
  return refused;
}

// ---- the whole manifest -----------------------------------------------------------------------------------------

/**
 * The policy over every path of a manifest: the single-path rules, then the collision and file/directory-prefix groups over
 * the paths that passed them. Pure and independent of order and duplicates in the input.
 */
export function evaluatePathPolicy(paths: Iterable<string>, options: PathPolicyOptions = {}): PathPolicyResult {
  const context = buildContext(options);
  const unique = [...new Set(paths)].sort(compareUnits);
  const refusals = new Map<string, PolicyRefusal>();
  const passed: string[] = [];
  for (const path of unique) {
    const refusal = refusePathWith(path, context);
    if (refusal === undefined) passed.push(path);
    else refusals.set(path, refusal);
  }
  const grouped = groupRefusals(passed);
  for (const [path, refusal] of grouped) refusals.set(path, refusal);
  return {
    accepted: passed.filter((path) => !grouped.has(path)),
    refusals: unique.flatMap((path) => refusals.get(path) ?? []),
  };
}

// ---- publisher advisory -----------------------------------------------------------------------------------------

/**
 * Warnings for the publisher: paths it is about to publish that the pull policy would refuse on another device. At most
 * three are named and the rest are a count. Never refuses; an empty list means nothing to say.
 */
export function adviseUnrestorablePaths(paths: Iterable<string>, options: PathPolicyOptions = {}): readonly string[] {
  const { refusals } = evaluatePathPolicy(paths, options);
  if (refusals.length === 0) return [];
  return [
    `${refusals.length} path(s) in this vault will not be restored by a pull on another device (path policy): ${summarizeRefusals(refusals)}. They are published anyway; rename them to publish files every device restores.`,
  ];
}
