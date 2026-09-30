export type PassphraseInputErrorCode =
  /** Both `IPFS_SYNC_PASSPHRASE` and `IPFS_SYNC_PASSPHRASE_FILE` are set. */
  | "both-sources"
  /** The passphrase file is a symbolic link, foreign-owned, readable by others or not a regular file. */
  | "file-unsafe"
  /** The passphrase file cannot be read (missing, no access, longer than the input limit). */
  | "file-unreadable"
  /** The prompt was interrupted (Ctrl-C, Ctrl-D or the input closed). */
  | "aborted"
  /** The typed or pasted input exceeds the 256-byte limit. */
  | "input-too-long"
  /** The supplied text is not a valid generated passphrase (the explanation says which check failed). */
  | "passphrase-format"
  /** `init` cannot use the requested passphrase-file path (exists, symlink, unsafe directory). */
  | "file-target"
  /** `init` re-entry differs from the generated passphrase. */
  | "mismatch"
  /** `init` has neither a terminal nor `--passphrase-file`. */
  | "no-terminal";

/**
 * A refusal in passphrase input or in `ipfs-sync init`. Messages are fixed text plus, at most, a file path or an
 * environment variable name; they never contain the passphrase or any part of it.
 */
export class PassphraseInputError extends Error {
  readonly code: PassphraseInputErrorCode;

  constructor(code: PassphraseInputErrorCode, message: string) {
    super(message);
    this.name = "PassphraseInputError";
    this.code = code;
  }
}
