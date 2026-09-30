/** Failures a publish reports by name. Messages never carry credentials or file contents. */

export class WriteVerificationError extends Error {
  readonly path: string;
  readonly expected: number;
  readonly actual: number;

  constructor(path: string, expected: number, actual: number) {
    super(`"${path}" was not written completely: expected ${expected} bytes on the node, files/stat reports ${actual}`);
    this.name = "WriteVerificationError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/** A computed removal or write target resolved outside `<mfsRoot>/current/`. */
export class UnsafeTargetError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`refusing "${path}": it does not resolve inside the published tree`);
    this.name = "UnsafeTargetError";
    this.path = path;
  }
}

/** The key was generated but its ID could not be recorded, so nothing was published. */
export class OwnedKeyNotRecordedError extends Error {
  readonly keyName: string;
  readonly keyId: string;

  constructor(keyName: string, keyId: string, cause: unknown) {
    super(
      `generated key "${keyName}" (ID ${keyId}) but could not record it in the config file: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Nothing was published. Re-run with --owned-key ${keyId} to use it.`,
      { cause },
    );
    this.name = "OwnedKeyNotRecordedError";
    this.keyName = keyName;
    this.keyId = keyId;
  }
}

export class EmptyVaultError extends Error {
  constructor() {
    super("the vault has no files to publish after exclusions");
    this.name = "EmptyVaultError";
  }
}

/** One or more file transfers failed; the IPNS record was not touched. */
export class TransferFailedError extends Error {
  readonly failures: readonly { readonly path: string; readonly error: unknown }[];

  constructor(failures: readonly { readonly path: string; readonly error: unknown }[]) {
    const first = failures[0];
    const detail = first === undefined ? "" : `: "${first.path}": ${first.error instanceof Error ? first.error.message : String(first.error)}`;
    super(`${failures.length} file transfer(s) failed${detail}`);
    this.name = "TransferFailedError";
    this.failures = failures;
  }
}
