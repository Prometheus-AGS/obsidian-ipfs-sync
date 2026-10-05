import { createInterface } from "node:readline/promises";
import { isUnsafeCodePoint } from "../src/kubo";

/** Output seam for the CLI. Production writes to the process streams; tests capture. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /**
   * Ask a yes/no question on the terminal. Absent when the run cannot ask (tests, pipes): callers treat a missing
   * or false answer as a refusal.
   */
  confirm?(question: string): Promise<boolean>;
  /**
   * Read one typed line on the terminal after showing `label`; undefined when the input ended. Absent when the run
   * cannot ask (tests, pipes): callers treat a missing prompt as "cannot confirm".
   */
  prompt?(label: string): Promise<string | undefined>;
}

/**
 * A question can be asked only where all three ends are a terminal: standard input to answer on, standard output to show the consequence text that
 * the commands print there before they ask, and standard error, where the question itself is written. With any end redirected, the person answering
 * could not have seen what they are answering (review round 4, A-L1; round 5, R5-L3), so the run is one that cannot ask.
 */
function canAsk(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true;
}

async function askOnTerminal(question: string): Promise<boolean> {
  if (!canAsk()) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(promptText(question))).trim());
  } finally {
    prompt.close();
  }
}

async function readLineOnTerminal(label: string): Promise<string | undefined> {
  if (!canAsk()) return undefined;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(label);
  } catch {
    return undefined;
  } finally {
    prompt.close();
  }
}

/**
 * Error text can carry up to 200 characters a node chose (an HTTP error detail). Every character the shared range table marks unsafe (`isUnsafeCodePoint`
 * in `src/kubo/errors.ts`, the table `escapeNodeText` uses: C0, DEL, C1, bidirectional controls, the line and paragraph separators, zero-width characters,
 * the soft hyphen, the byte order mark and the tag block) is replaced, one `?` per code point, so it cannot forge lines, reorder text, hide text or drive the terminal.
 */
export function stripControlCharacters(text: string): string {
  let out = "";
  for (const character of text) out += isUnsafeCodePoint(character.codePointAt(0) ?? 0) ? "?" : character;
  return out;
}

/** The exact text of a yes/no prompt. Confirmation questions can embed names a node chose (N3-06). */
export function promptText(question: string): string {
  return `${stripControlCharacters(question)} [y/N] `;
}

/** Standard output carries multi-line text (the help, a listing), so line breaks stay; every other control character in a line is replaced. */
function stripPerLine(text: string): string {
  return text.split("\n").map(stripControlCharacters).join("\n");
}

/**
 * The process streams. `confirm` and `prompt` exist only when standard input, standard output AND standard error are terminals: a run without both is then a run
 * that cannot ask, and the commands that need a yes (keys change-passphrase, keys increase-cost, prune-history, abandon) refuse before they send
 * anything unless the explicit flag was given. Standard output is stripped like standard error, because a node chooses entry names and version strings.
 */
export function createProcessIo(): CliIo {
  const interactive = canAsk();
  return {
    ...(interactive ? { confirm: askOnTerminal, prompt: readLineOnTerminal } : {}),
    out: (text) => {
      process.stdout.write(`${stripPerLine(text)}\n`);
    },
    err: (text) => {
      process.stderr.write(`${stripControlCharacters(text)}\n`);
    },
  };
}

export const EXIT_OK = 0;
/** A check failed (unreachable, credentials rejected, probe mismatch). */
export const EXIT_CHECK_FAILED = 1;
/** Bad usage or unsafe/invalid configuration; raised before any request. */
export const EXIT_USAGE = 2;
