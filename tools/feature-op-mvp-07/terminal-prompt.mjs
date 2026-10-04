// One visible line from an interactive terminal, with a deadline. The operator's answers in the Obsidian-observed steps are not secrets, so the
// terminal keeps its own line editing and echo (no raw mode). The same input/output shape as cli/passphrase-prompt.ts, so a test terminal fits.
import { Refusal } from "./constants.mjs";

const LINE_MAX_CHARS = 1024;
const NO_TERMINAL = "the operator steps need an interactive terminal: stdin and stdout must both be terminals (a pipe or a redirect is refused). For an unattended run use --phases script-only or --verify-only";

/** True only for a terminal whose input and output are both terminals. */
export const isInteractive = (terminal) => terminal?.input?.isTTY === true && terminal?.output?.isTTY === true;

/** Throws a Refusal (exit 2) unless the terminal is interactive on both streams. */
export function assertOperatorTerminal(terminal) {
  if (!isInteractive(terminal)) throw new Refusal(NO_TERMINAL);
}

/**
 * Writes `label`, then waits for one line. Resolves { ok: true, line } (without the line ending), or { ok: false, reason } where reason is
 * "timeout" (nothing complete within timeoutMs) or "closed" (the input ended or failed first). A non-interactive terminal is refused before
 * anything is written or read. Listeners and the timer are always removed and the input paused.
 */
export function readLine(terminal, label, { timeoutMs }) {
  if (!isInteractive(terminal)) return Promise.reject(new Refusal(NO_TERMINAL));
  const { input, output } = terminal;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    let timer;
    const settle = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onClosed);
      input.removeListener("close", onClosed);
      input.removeListener("error", onClosed);
      input.pause();
      output.write("\n");
      resolve(outcome);
    };
    function onData(chunk) {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const end = text.search(/[\r\n]/);
      if (end >= 0) settle({ ok: true, line: text.slice(0, Math.min(end, LINE_MAX_CHARS)) });
      else if (text.length > LINE_MAX_CHARS) settle({ ok: true, line: text.slice(0, LINE_MAX_CHARS) });
    }
    function onClosed() {
      settle({ ok: false, reason: "closed" });
    }
    timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), timeoutMs);
    input.on("data", onData);
    input.on("end", onClosed);
    input.on("close", onClosed);
    input.on("error", onClosed);
    output.write(label);
    input.resume();
  });
}
