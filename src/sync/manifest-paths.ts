/**
 * Untrusted-path rules for manifest paths (pure: no I/O, no imports). Shared by the plaintext-era pull planner
 * and the encrypted manifest codec. Moved verbatim from pull-plan.ts; behaviour is unchanged.
 *
 * This is the decoder's rule and it stays minimal on purpose: the publisher decodes its own manifests with it, so it must
 * keep accepting names an honest Linux vault can hold (for example `CON.md`). The state-folder comparison uses
 * `toLowerCase()`, which does not fold every alias a case-insensitive volume may treat as equal, and Windows trailing
 * dots and spaces, `::$DATA` and 8.3 names are not covered here. They are covered by the pull's path policy
 * (`path-policy.ts`, mvp-07a 3.1b: fold key, Windows forms, reserved names, collision groups, C1 controls, the
 * exclusion list through a fold-aware pull-only matcher), which the pull applies over the whole manifest; the
 * publisher only warns through `adviseUnrestorablePaths`. The exclusion list and `.obsidian/plugins/` are applied by
 * the pull planner, not here.
 */

/** Vault-relative folder that holds the sync record and temporary files. Manifest paths may never point into it. */
export const STATE_FOLDER = ".ipfs-sync";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Why a manifest path must not be written, or `undefined` when it is acceptable. Manifest paths come from
 * the network: absolute paths, empty, `.` or `..` segments, backslashes, control characters and anything
 * inside the state folder (compared case-insensitively, because macOS and Windows volumes are) are refused.
 */
export function untrustedPathReason(path: string): string | undefined {
  if (path === "") return "empty path";
  if (path.startsWith("/") || DRIVE_LETTER.test(path)) return "absolute path";
  if (path.includes("\\")) return "backslash in path";
  if (CONTROL_CHARACTERS.test(path)) return "control character in path";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "empty, . or .. path segment";
  if (segments[0]?.toLowerCase() === STATE_FOLDER) return `inside the ${STATE_FOLDER} state folder`;
  return undefined;
}
