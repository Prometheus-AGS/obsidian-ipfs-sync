import { createInterface } from "node:readline/promises";

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

async function askOnTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(promptText(question))).trim());
  } finally {
    prompt.close();
  }
}

async function readLineOnTerminal(label: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(label);
  } catch {
    return undefined;
  } finally {
    prompt.close();
  }
}

/** C0, DEL, C1, and the bidirectional controls (ALM, LRM, RLM, embeddings/overrides, isolates) that reorder displayed text. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * Error text can carry up to 200 characters a node chose (an HTTP error detail). Control characters, including
 * newlines, escape sequences and bidi controls, are replaced so it cannot forge lines, reorder text or drive the terminal.
 */
export function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, "?");
}

/** The exact text of a yes/no prompt. Confirmation questions can embed names a node chose (N3-06). */
export function promptText(question: string): string {
  return `${stripControlCharacters(question)} [y/N] `;
}

export function createProcessIo(): CliIo {
  return {
    confirm: askOnTerminal,
    prompt: readLineOnTerminal,
    out: (text) => {
      process.stdout.write(`${text}\n`);
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
