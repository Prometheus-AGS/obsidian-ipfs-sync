import { PASSPHRASE_INPUT_MAX_BYTES, wipe, type Bytes } from "../src/crypto";
import { PassphraseInputError } from "./passphrase-errors";

/** The slice of a readable terminal stream the prompt uses. `process.stdin` satisfies it; tests supply their own. */
export interface PromptInput {
  readonly isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

/** The slice of a writable stream the prompt uses. `process.stderr` satisfies it. */
export interface PromptOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

export interface PromptTerminal {
  readonly input: PromptInput;
  readonly output: PromptOutput;
}

const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const ESCAPE = 0x1b;
const CSI_INTRODUCER = 0x5b;
const SS3_INTRODUCER = 0x4f;
const CSI_FINAL_FIRST = 0x40;
const CSI_FINAL_LAST = 0x7e;
const SPACE = 0x20;
const DELETE = 0x7f;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;

type EscapeState = "none" | "escape" | "sequence" | "single-shift";

/**
 * Read one line from a terminal without echo. Raw bytes are read from the stream and kept in a fixed 256-byte buffer;
 * nothing typed is written back. Ctrl-C and Ctrl-D abort, backspace removes one character (a whole UTF-8 sequence),
 * arrow-key escape sequences are dropped, a pasted block is read like typed input, and the 257th byte is refused.
 * Raw mode is switched off, the listeners are removed and the stream paused on every path. The caller wipes the result.
 */
export function promptHidden(terminal: PromptTerminal, label: string): Promise<Bytes> {
  const { input, output } = terminal;
  const setRawMode = input.setRawMode?.bind(input);
  if (input.isTTY !== true || setRawMode === undefined) {
    return Promise.reject(new PassphraseInputError("no-terminal", "standard input is not an interactive terminal"));
  }
  return new Promise<Bytes>((resolve, reject) => {
    const buffer = new Uint8Array(PASSPHRASE_INPUT_MAX_BYTES);
    let length = 0;
    let escape: EscapeState = "none";
    let done = false;

    const release = (): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      input.removeListener("error", onFailure);
      try {
        setRawMode(false);
      } finally {
        input.pause();
      }
    };
    const settle = (outcome: { readonly bytes: Bytes } | { readonly error: Error }): void => {
      if (done) return;
      done = true;
      try {
        release();
        output.write("\n");
      } catch (error) {
        wipe(buffer);
        reject(error);
        return;
      }
      if ("error" in outcome) {
        wipe(buffer);
        reject(outcome.error);
        return;
      }
      resolve(outcome.bytes);
      wipe(buffer);
    };
    const abort = (detail: string): void => settle({ error: new PassphraseInputError("aborted", `passphrase entry aborted: ${detail}`) });

    const removeLastCharacter = (): void => {
      while (length > 0 && ((buffer[length - 1] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION) buffer[--length] = 0;
      if (length > 0) buffer[--length] = 0;
    };
    const handleByte = (byte: number): void => {
      if (escape === "escape") {
        // ESC [ opens a sequence that ends at a final byte; ESC O (single shift 3, application-mode arrow and function keys) is followed by exactly one byte.
        escape = byte === CSI_INTRODUCER ? "sequence" : byte === SS3_INTRODUCER ? "single-shift" : "none";
        return;
      }
      if (escape === "single-shift") {
        escape = "none";
        return;
      }
      if (escape === "sequence") {
        if (byte >= CSI_FINAL_FIRST && byte <= CSI_FINAL_LAST) escape = "none";
        return;
      }
      if (byte === CTRL_C) return abort("interrupted");
      if (byte === CTRL_D) return abort("end of input");
      if (byte === LINE_FEED || byte === CARRIAGE_RETURN) return settle({ bytes: buffer.slice(0, length) });
      if (byte === BACKSPACE || byte === DELETE) return removeLastCharacter();
      if (byte === ESCAPE) {
        escape = "escape";
        return;
      }
      if (byte < SPACE) return;
      if (length === PASSPHRASE_INPUT_MAX_BYTES) {
        return settle({ error: new PassphraseInputError("input-too-long", `the input is longer than ${PASSPHRASE_INPUT_MAX_BYTES} bytes`) });
      }
      buffer[length++] = byte;
    };
    function onData(chunk: Uint8Array): void {
      for (const byte of chunk) {
        if (done) break;
        handleByte(byte);
      }
      chunk.fill(0);
    }
    function onEnd(): void {
      abort("the input closed");
    }
    function onFailure(error: Error): void {
      settle({ error });
    }

    try {
      setRawMode(true);
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      input.on("error", onFailure);
      output.write(label);
      input.resume();
    } catch (error) {
      settle({ error: error instanceof Error ? error : new Error(String(error)) });
    }
  });
}
