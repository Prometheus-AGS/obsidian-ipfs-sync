/**
 * Generated-passphrase vectors (spec: key-slots, "Generated passphrases only, with a check").
 *
 * The check is the first 10 bits of SHA-256(UTF-8("ipfs-sync/passphrase/check/v1") || ASCII(23 body symbols)) as two
 * base32 symbols. This is a project-defined construction, so there is no external known answer: the values below are
 * fixed-output REGRESSION PINS. Each was computed at authoring time with node:crypto's SHA-256 (not the module under
 * test), and HC and YK also agree with the values the lead's independent reading of the specification produced
 * (`HEZVI-DN7IB-GLQIX-B5L7V-ARDHC` valid; `CorrectHorseBatteryStaple` expected check YK, presented LE).
 */
export const CHECK_VECTORS = [
  { body: "AAAAAAAAAAAAAAAAAAAAAAA", check: "J6" },
  { body: "ABCDEFGHIJKLMNOPQRSTUVW", check: "5M" },
  { body: "77777777777777777777777", check: "EJ" },
  { body: "HEZVIDN7IBGLQIXB5L7VARD", check: "HC" },
  { body: "CORRECTHORSEBATTERYSTAP", check: "YK" },
] as const;

export const VALID_PASSPHRASE = {
  display: "HEZVI-DN7IB-GLQIX-B5L7V-ARDHC",
  canonical: "HEZVIDN7IBGLQIXB5L7VARDHC",
} as const;

/** Rejected by the check: 25 letters that form a plausible phrase; expected check YK, presented LE. */
export const REJECTED_PHRASES = [
  { text: "CorrectHorseBatteryStaple", expectedCheck: "YK", presentedCheck: "LE" },
  { text: "Correct Horse Battery Staple", expectedCheck: "YK", presentedCheck: "LE" },
] as const;
