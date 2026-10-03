/**
 * Shape limits for a vault path (mvp-07a final review B1-01). Pure; no imports, so the manifest decoder, the pull policy and
 * the publisher share one definition.
 *
 * A path that comes out of an authenticated manifest is still attacker-shaped when a device that holds the vault key is
 * compromised. Every later rule (fold keys, exclusion prefixes, collision groups) costs time per segment, so these limits are
 * checked FIRST and the check itself is linear in a length it bounds before it splits anything.
 */
export const PATH_LIMITS = Object.freeze({
  /** The whole path in UTF-8 bytes (Linux PATH_MAX). */
  maxPathBytes: 4096,
  /** One segment in UTF-8 bytes (the NAME_MAX of ext4, APFS and NTFS-in-UTF-8). */
  maxSegmentBytes: 255,
  /** The number of `/`-separated segments. */
  maxSegments: 128,
});

export type PathLimitViolation = "path-too-long" | "segment-too-long" | "too-many-segments";

/** UTF-8 length of `text` without allocating; a lone surrogate counts 3 bytes, as `TextEncoder` encodes U+FFFD. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The first limit `path` breaks, or `undefined`. Nothing is split or copied before the path length is bounded. */
export function pathLimitViolation(path: string): PathLimitViolation | undefined {
  // A UTF-16 unit is at least one byte, so a longer string cannot fit: no scan of a huge path is needed.
  if (path.length > PATH_LIMITS.maxPathBytes) return "path-too-long";
  if (utf8Length(path) > PATH_LIMITS.maxPathBytes) return "path-too-long";
  let segments = 0;
  let start = 0;
  for (;;) {
    const slash = path.indexOf("/", start);
    const end = slash < 0 ? path.length : slash;
    segments += 1;
    if (segments > PATH_LIMITS.maxSegments) return "too-many-segments";
    if (utf8Length(path.slice(start, end)) > PATH_LIMITS.maxSegmentBytes) return "segment-too-long";
    if (slash < 0) return undefined;
    start = slash + 1;
  }
}
