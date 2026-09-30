/**
 * Typed, fail-closed errors for the crypto module (spec: crypto-primitives, "Typed fail-closed errors").
 *
 * Messages are fixed text plus, where useful, non-secret numbers such as a parameter name and its value.
 * A message never carries a passphrase, key bytes or plaintext, and callers must not add any.
 */
export type CryptoErrorCode =
  /** `crypto.subtle` or the secure random generator is missing. There is no fallback. */
  | "crypto-unavailable"
  /** The first-use known-answer check of HKDF or AES-GCM disagreed with the published value. */
  | "self-test-failed"
  /** The commitment or the wrap authentication failed: wrong passphrase or damaged key slot (one outcome). */
  | "wrong-passphrase-or-damaged-slot"
  /** A stored Argon2id parameter is outside the floors and ceilings, or is not the fixed value. */
  | "kdf-params-out-of-bounds"
  /** A version, magic, exponent, algorithm string or slot type this build does not know. */
  | "unsupported-format"
  /** AES-GCM authentication failed: the bytes were altered, or belong to another key, vault, name or position. */
  | "authentication-failed"
  /** Truncated, over-long, misplaced or otherwise structurally invalid input. */
  | "malformed-input"
  /** A size or count cap was exceeded. */
  | "oversize-input"
  /** The object belongs to another vault or does not match the recorded identity. */
  | "vault-mismatch"
  /** The text is not a valid generated passphrase (wrong length, alphabet or checksum). Not secret: the check is public. */
  | "passphrase-format"
  /** The key-slot file has no passphrase slot this build can use (unknown slot types are skipped, not tried). */
  | "no-usable-slot"
  /** A platform cryptography call failed for a reason other than a failed authentication (for example an unsupported algorithm). */
  | "platform-failure"
  /** The device cannot afford the key derivation a slot demands (memory allocation failed). Not a wrong passphrase. */
  | "kdf-unaffordable"
  /** A key slot costs more than the default and the host did not approve it. */
  | "kdf-cost-refused"
  /** A programming error: wrong key length, wrong nonce length, bad range. Never caused by remote data alone. */
  | "invalid-argument";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

export type KdfParameterName = "memory" | "iterations" | "parallelism" | "salt" | "version" | "output-length";

/** An Argon2id parameter outside its bounds. Names the parameter; the value is a public number, not a secret. */
export class KdfParamsError extends CryptoError {
  readonly parameter: KdfParameterName;

  constructor(parameter: KdfParameterName, message: string) {
    super("kdf-params-out-of-bounds", message);
    this.name = "KdfParamsError";
    this.parameter = parameter;
  }
}

/** A cap was exceeded; `cap` names which one, so a caller can refuse "by name of cap". */
export class OversizeInputError extends CryptoError {
  readonly cap: string;

  constructor(cap: string, message: string) {
    super("oversize-input", message);
    this.name = "OversizeInputError";
    this.cap = cap;
  }
}

export function malformed(message: string): CryptoError {
  return new CryptoError("malformed-input", message);
}

export function invalidArgument(message: string): CryptoError {
  return new CryptoError("invalid-argument", message);
}

/**
 * A key slot costs more than the allowed cost and the host did not approve it. `slots` are the tried slots above the limit
 * (public parameters), so an interface can show the cost before asking again.
 */
export class KdfCostRefusedError extends CryptoError {
  readonly slots: readonly { readonly m: number; readonly t: number; readonly p: number }[];

  constructor(slots: readonly { readonly m: number; readonly t: number; readonly p: number }[], message: string) {
    super("kdf-cost-refused", message);
    this.name = "KdfCostRefusedError";
    this.slots = slots.map((slot) => ({ m: slot.m, t: slot.t, p: slot.p }));
  }
}
