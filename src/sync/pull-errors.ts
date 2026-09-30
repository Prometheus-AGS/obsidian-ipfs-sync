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
