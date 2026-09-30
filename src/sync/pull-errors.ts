/** Failures a pull reports by name. Messages never carry credentials or file contents. */

/** The destination may not be written: a real (non-empty, unmarked) vault, not a directory, or a linked state folder. */
export class PullGuardError extends Error {
  /** `real-vault` is the plaintext guard (no encryption yet); `unsafe-destination` covers the rest, such as a linked state folder. */
  readonly reason: "real-vault" | "unsafe-destination";

  constructor(message: string, reason: "real-vault" | "unsafe-destination" = "unsafe-destination") {
    super(message);
    this.name = "PullGuardError";
    this.reason = reason;
  }
}

/** No pull target could be established (default key not owned, name cannot be resolved). */
export class PullTargetError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PullTargetError";
  }
}

/** The manifest could not be read or the resolved value is not a published root. */
export class PullSourceError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PullSourceError";
  }
}

/** The local copy of a conflicting file could not be preserved, so the file was not replaced. */
export class ConflictPreserveError extends Error {
  constructor(path: string, cause: unknown) {
    super(`could not preserve the local version of "${path}": ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ConflictPreserveError";
  }
}

/** Thrown when the resolved root holds an encrypted vault (key slots or an encrypted manifest): pulling one arrives with the next change. */
export class EncryptedVaultError extends Error {
  constructor() {
    super(
      "this root holds an encrypted vault, and pulling encrypted vaults is not supported yet (it arrives with the next change, mvp-07). " +
        "Nothing in the vault was written and no key derivation ran. This device has recorded that an encrypted vault was seen, so plaintext reads " +
        "of this destination, root and key are refused from now on.",
    );
    this.name = "EncryptedVaultError";
  }
}

/**
 * The plaintext (version 1) reader was not allowed. `flag-required`: it is off unless `--allow-plaintext-v1` is given, because
 * anyone who can write to the node can forge a plaintext manifest. `downgrade`: an encrypted vault was seen here before, so a
 * root that now serves plaintext is refused even with the flag.
 */
export class PlaintextV1RefusedError extends Error {
  readonly reason: "flag-required" | "downgrade";

  constructor(reason: "flag-required" | "downgrade") {
    super(
      reason === "flag-required"
        ? "this root serves a plaintext (version 1) manifest. Reading it is off unless you pass --allow-plaintext-v1, because anyone who can write to the node can forge one. Nothing was written."
        : "an encrypted vault was seen for this destination, root or key before, and this root now serves a plaintext manifest. That may be a downgrade, so it is refused even with --allow-plaintext-v1. Nothing was written.",
    );
    this.name = "PlaintextV1RefusedError";
    this.reason = reason;
  }
}
