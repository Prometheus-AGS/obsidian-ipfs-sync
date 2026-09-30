import { EventEmitter } from "node:events";
import type { PromptInput, PromptOutput, PromptTerminal } from "../../cli/passphrase-prompt";

/** One scripted answer: the chunks the terminal delivers, one `data` event each, once the prompt is listening. */
export type ScriptedAnswer = string | readonly (string | Uint8Array)[];

export interface FakeTerminal extends PromptTerminal {
  /** Every argument of `setRawMode`, in order. A well-behaved prompt ends on `false`. */
  readonly rawModes: boolean[];
  /** Everything written to the output stream. */
  readonly written: string[];
  /** Number of `data`, `end`, `close` and `error` listeners still attached to the input. */
  listeners(): number;
  /** True while the input stream is flowing (resumed and not paused). */
  flowing(): boolean;
  /** Deliver bytes now, as if typed or pasted. */
  send(chunk: string | Uint8Array): void;
  /** Close the input, as if the terminal went away. */
  close(): void;
  /** Answers still unused. */
  remaining(): number;
}

export interface FakeTerminalOptions {
  readonly inputIsTty?: boolean;
  readonly outputIsTty?: boolean;
  readonly answers?: readonly ScriptedAnswer[];
}

function toBuffer(chunk: string | Uint8Array): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/**
 * A terminal made of two in-memory streams. Each prompt consumes the next scripted answer: when the prompt calls
 * `resume()` (its last set-up step) the answer is delivered, one chunk per `data` event, on a later tick. Nothing here
 * echoes: whatever the prompt does not write itself never reaches `written`.
 */
export function createFakeTerminal(options: FakeTerminalOptions = {}): FakeTerminal {
  const emitter = new EventEmitter();
  const rawModes: boolean[] = [];
  const written: string[] = [];
  const answers = [...(options.answers ?? [])];
  let isFlowing = false;
  const send = (chunk: string | Uint8Array): void => void emitter.emit("data", toBuffer(chunk));
  const input: PromptInput = {
    isTTY: options.inputIsTty ?? true,
    setRawMode: (raw) => void rawModes.push(raw),
    resume: () => {
      isFlowing = true;
      const answer = answers.shift();
      if (answer === undefined) return;
      const chunks = typeof answer === "string" ? [answer] : answer;
      queueMicrotask(() => {
        for (const chunk of chunks) send(chunk);
      });
    },
    pause: () => {
      isFlowing = false;
    },
    on: (event, listener) => void emitter.on(event, listener as (...args: unknown[]) => void),
    removeListener: (event, listener) => void emitter.removeListener(event, listener as (...args: unknown[]) => void),
  };
  const output: PromptOutput = { isTTY: options.outputIsTty ?? true, write: (text) => void written.push(text) };
  return {
    input,
    output,
    rawModes,
    written,
    listeners: () => ["data", "end", "close", "error"].reduce((sum, event) => sum + emitter.listenerCount(event), 0),
    flowing: () => isFlowing,
    send,
    close: () => void emitter.emit("end"),
    remaining: () => answers.length,
  };
}
