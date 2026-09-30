import type { EnvMap } from "../src/core/config";
import {
  PassphraseFormatError,
  canonicalizePassphrase,
  utf8,
  wipe,
  type Bytes,
  type CanonicalPassphrase,
} from "../src/crypto";
import { readPassphraseFile, type FileHost } from "./passphrase-file";
import { PassphraseInputError } from "./passphrase-errors";
import { promptHidden, type PromptTerminal } from "./passphrase-prompt";

export { PassphraseInputError, type PassphraseInputErrorCode } from "./passphrase-errors";
export type { PromptInput, PromptOutput, PromptTerminal } from "./passphrase-prompt";
export type { FileHost } from "./passphrase-file";

export const PASSPHRASE_ENV = "IPFS_SYNC_PASSPHRASE";
export const PASSPHRASE_FILE_ENV = "IPFS_SYNC_PASSPHRASE_FILE";

/**
 * What the unlock sources need from the process. `terminal` is absent when the run has no interactive terminal (a pipe,
 * a test); the prompt is then not a source and a run without a variable has no passphrase. There is deliberately no
 * command-line flag among the sources.
 */
export interface PassphraseHost extends FileHost {
  readonly env: EnvMap;
  readonly terminal?: PromptTerminal;
  /** Receives warnings such as "permissions cannot be verified". Never receives a passphrase. */
  readonly warn: (text: string) => void;
}

const FORMAT_HELP =
  'A vault passphrase is the 25-character code "ipfs-sync init" generated (five groups of five, XXXXX-XXXXX-XXXXX-XXXXX-XXXXX, capitals A-Z and digits 2-7); a passphrase of your own choosing cannot be used.';

/** Canonicalise `raw` (which is wiped either way); a format failure becomes an explained refusal that never quotes the input. */
function canonical(raw: Bytes, source: string): CanonicalPassphrase {
  try {
    return canonicalizePassphrase(raw);
  } catch (error) {
    if (error instanceof PassphraseFormatError) {
      throw new PassphraseInputError("passphrase-format", `the passphrase from ${source} was refused before any request: ${error.message}. ${FORMAT_HELP}`);
    }
    throw error;
  } finally {
    wipe(raw);
  }
}

/**
 * The passphrase to unlock an existing vault, from exactly one of: `IPFS_SYNC_PASSPHRASE`, the file named by
 * `IPFS_SYNC_PASSPHRASE_FILE`, or (with a terminal on standard input and neither variable set) a prompt that does not
 * echo. Returns undefined when there is no source; the caller then refuses before any request. Both variables set is
 * an error. Every source passes the canonical-passphrase function, so a wrong-format text fails here, before any
 * request and before any key derivation. The result is 25 bytes the caller wipes after use.
 */
export async function readVaultPassphrase(host: PassphraseHost): Promise<CanonicalPassphrase | undefined> {
  const value = host.env[PASSPHRASE_ENV];
  const file = host.env[PASSPHRASE_FILE_ENV];
  if (value !== undefined && file !== undefined) {
    throw new PassphraseInputError("both-sources", `both ${PASSPHRASE_ENV} and ${PASSPHRASE_FILE_ENV} are set; set exactly one`);
  }
  if (value !== undefined) return canonical(utf8(value), PASSPHRASE_ENV);
  if (file !== undefined) {
    const read = await readPassphraseFile(file, host);
    for (const warning of read.warnings) host.warn(`warning: ${warning}`);
    return canonical(read.bytes, `the file named by ${PASSPHRASE_FILE_ENV}`);
  }
  if (host.terminal?.input.isTTY !== true) return undefined;
  return canonical(await promptHidden(host.terminal, "Vault passphrase: "), "the prompt");
}
