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

/** The one wording for a root that serves a plaintext manifest and no key slots. It names no flag and no recorded state: there is no way around it. */
export const PLAINTEXT_UNSUPPORTED_MESSAGE =
  "plaintext publications are no longer supported by this version, and this root holds one (a manifest.json and no key slots); nothing was written.";

/** The root is a plaintext publication, which no code path of this version reads. */
export class PlaintextUnsupportedError extends Error {
  constructor() {
    super(PLAINTEXT_UNSUPPORTED_MESSAGE);
    this.name = "PlaintextUnsupportedError";
  }
}

/**
 * Why the decrypting pull stopped before it wrote anything in the vault (steps 1 to 6 of `encrypted-pull.ts`). The first
 * six are the verdict refusals of `pull-sequence.ts`, by the same names.
 */
export type PullStopReason =
  | "flag-combination"
  | "expectation-failed"
  | "other-vault"
  | "older"
  | "unfinished-publish"
  | "fork"
  /** A key-management operation (a rewrap or a history prune) is pending on this device: the text names `keys discard` and `keys accept-slots`. */
  | "maintenance-pending"
  /** The in-process lock is held by another operation. */
  | "busy"
  /** `publish.lock` is held (or unreadable, or was lost): the text is publish's own. */
  | "lock-held"
  | "lock-unreadable"
  | "lock-lost"
  /** The directory's state file is damaged or in an unsupported format. */
  | "state-unreadable"
  /** The name or the explicit root could not be turned into a root, or no key names a target. */
  | "target-unresolved"
  /** The root holds no key slots and its listing does not name a `manifest.json`: empty, unknown, or a vault that lost its slots. */
  | "no-key-slots"
  /** The root lists a `manifest.json` and holds no key slots: a plaintext publication, which no code path of this version reads. The text is `PLAINTEXT_UNSUPPORTED_MESSAGE`. */
  | "plaintext-root"
  | "slots-without-manifest"
  /** The node's slot file differs from this device's copy or record, or belongs to another vault than the manifest. */
  | "vault-mismatch"
  | "locked"
  /** One outcome and one message for a wrong passphrase, a damaged slot and a failed commitment. */
  | "wrong-passphrase"
  | "passphrase-format"
  | "kdf-cost-refused"
  | "kdf-unaffordable"
  /** The slot file is outside the bounds or formats this build reads. */
  | "key-slots-invalid"
  /** A node object is above its cap or of the wrong kind; it was not read. */
  | "remote-object"
  /** `manifest.enc` is present but does not authenticate under the unlocked key. */
  | "manifest-not-authentic"
  /** `manifest.enc` authenticated but holds something this build does not read (caps, fields, a newer format). */
  | "manifest-unsupported"
  | "history-entry-not-found"
  | "history-entry-ambiguous"
  | "history-entry-mismatch"
  | "first-pull-declined"
  | "first-pull-not-confirmed";

/**
 * The decrypting pull stopped at a check, with nothing written in the vault. The message is fixed text: it never carries a
 * passphrase, a key, a file's contents or node-supplied text (text that came from a lower layer is escaped first).
 */
export class PullStopError extends Error {
  readonly reason: PullStopReason;
  /** For `kdf-cost-refused`: the public parameters of the slots that were refused, so a host can show the cost and ask again. */
  readonly costs: readonly { readonly m: number; readonly t: number; readonly p: number }[] | undefined;

  constructor(reason: PullStopReason, message: string, options?: { readonly costs?: readonly { readonly m: number; readonly t: number; readonly p: number }[]; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PullStopError";
    this.reason = reason;
    this.costs = options?.costs;
  }
}
