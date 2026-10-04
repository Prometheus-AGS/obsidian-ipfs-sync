import { PassphraseFormatError, canonicalizePassphrase, constantTimeEqual, formatPassphrase, wipe, type GeneratedPassphrase } from "../src/crypto";
import { PassphraseInputError } from "./passphrase-errors";
import { promptHidden, type PromptTerminal } from "./passphrase-prompt";

/**
 * Showing a generated passphrase once, and saving it: the part `init` and `keys change-passphrase` share. Moved out of `init-command.ts` (07b task 1.4)
 * with its words unchanged for `init`; the two commands differ only in the heading and in what they say was not done when the check fails.
 */

export const NO_RECOVERY_TEXT =
  "There is no recovery. If this passphrase is lost, the vault's data is lost permanently: nobody can reset it or decrypt the data without it. Keep a copy in a password manager.";
export const NO_POSIX_CHECK_TEXT =
  "warning: Windows has no POSIX mode check, so nothing verifies that only you can read the passphrase file: it inherits the access list of its folder. Keep the folder private and copy the file somewhere safe.";
const CASE_TEXT = "Letters are not case-sensitive and the hyphens are optional when you type it.";
const GROUP_SIZE = 5;
const FILE_GROUP_SEPARATOR = 0x2d;
const LINE_FEED = 0x0a;

/** The 25 symbols in five hyphen-separated groups with a line feed, as bytes (no string copy of the secret is made). */
export function passphraseFileContent(generated: GeneratedPassphrase): Uint8Array {
  const groups = generated.length / GROUP_SIZE;
  const out = new Uint8Array(generated.length + groups);
  let at = 0;
  for (let group = 0; group < groups; group += 1) {
    out.set(generated.subarray(group * GROUP_SIZE, (group + 1) * GROUP_SIZE), at);
    at += GROUP_SIZE;
    out[at] = group === groups - 1 ? LINE_FEED : FILE_GROUP_SEPARATOR;
    at += 1;
  }
  return out;
}

export interface ShowWords {
  /** The line above the passphrase, ending in a colon. */
  readonly heading: string;
  /** What did not happen when the retyped text is wrong, as it ends the refusal: "no vault was created and nothing was written to the node". */
  readonly nothingDone: string;
}

/** Show the passphrase once, then require it again. A mismatch, or text that is not a valid passphrase, ends the command with nothing done. */
export async function showAndConfirm(terminal: PromptTerminal, generated: GeneratedPassphrase, words: ShowWords): Promise<void> {
  if (terminal.output.isTTY !== true) {
    throw new PassphraseInputError("no-terminal", "the passphrase can only be shown on a terminal, and standard error is not one; use --passphrase-file <path>");
  }
  terminal.output.write(["", words.heading, "", `    ${formatPassphrase(generated)}`, "", "Save it in a password manager now. " + CASE_TEXT, NO_RECOVERY_TEXT, "", ""].join("\n"));
  const typed = await promptHidden(terminal, "Enter the passphrase again to confirm: ");
  try {
    const canonical = canonicalizePassphrase(typed);
    const same = constantTimeEqual(canonical, generated);
    wipe(canonical);
    if (!same) throw new PassphraseInputError("mismatch", `the passphrase entered again does not match; ${words.nothingDone}`);
  } catch (error) {
    if (error instanceof PassphraseFormatError) {
      throw new PassphraseInputError("mismatch", `the passphrase entered again is not valid (${error.message}); ${words.nothingDone}`);
    }
    throw error;
  } finally {
    wipe(typed);
  }
}
