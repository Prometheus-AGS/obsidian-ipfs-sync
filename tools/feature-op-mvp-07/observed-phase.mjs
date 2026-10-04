// Phase obsidian-observed-steps (task 4.7a): the operator prompts for the steps performed in real Obsidian on the two throwaway vaults, and the
// machine side of those steps (machine-steps.mjs, driven through the built CLI). Operator prompts: the install check, the first-pull
// confirmation (assertion first-pull-confirm-shown, the one operator-observed id of the checker's REQUIRED_ASSERTIONS) and the outcome of the
// large blob in the plugin. Every prompt is bound to a fresh nonce the script prints after the operator says ready, and the answer is kept only
// when it is exactly "<nonce> <verdict>". A missing, late, malformed, wrong-nonce or negative answer records passed:false; nothing here can pass
// without a typed answer. A run without an operator (--verify-only, --phases script-only) never asks.
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { VAULT_NAMES } from "./constants.mjs";
import { runMachineSteps } from "./machine-steps.mjs";
import { PHASE_PLAN } from "./phases.mjs";
import { assertOperatorTerminal, readLine } from "./terminal-prompt.mjs";

export { assertOperatorTerminal, readLine };

/** How long the operator may take to say ready, and, from that moment on, to type the answer (the countdown). */
export const READY_WAIT_MS = 30 * 60 * 1000;
export const ANSWER_WINDOW_MS = 10 * 60 * 1000;
const PHASE_NAME = "obsidian-observed-steps";
const OPERATOR_OBSERVED_ID = "first-pull-confirm-shown";
const BLOB_ID = "multi-segment-blob-pulled-in-plugin";
const BLOB_OUTCOMES = Object.freeze(["range-honoured", "range-ignored-refused"]);
const NONCE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const NONCE_LENGTH = 6;
const ECHO_MAX_CHARS = 64;

/** Six characters without the look-alikes (i, l, o, 0, 1), so the operator types what is printed. */
export function randomNonce() {
  return Array.from({ length: NONCE_LENGTH }, () => NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)]).join("");
}

const seconds = (ms) => `${Math.ceil(ms / 1000)}s`;
const sanitize = (text) => text.replace(/[^\x20-\x7e]/g, "").trim().slice(0, ECHO_MAX_CHARS);
const operatorPresent = (S) => S.opts.verifyOnly !== true && S.opts.phases !== "script-only";

/**
 * One operator step: print what to do, wait for "ready", then start the countdown and wait for "<nonce> <verdict>".
 * `good` lists the accepted verdicts, `bad` is the one negative verdict. Returns { passed, detail, verdict? }; passed is true only for an
 * accepted verdict carrying this step's nonce.
 */
async function askStep(S, { title, instructions, good, bad }) {
  const { terminal, nonce, windowMs, readyWaitMs } = S.operator;
  S.t.out(`\n== ${title} ==`);
  for (const line of instructions) S.t.out(line);
  const ready = await readLine(terminal, "type ready when you are about to start: ", { timeoutMs: readyWaitMs });
  if (!ready.ok) return { passed: false, detail: `${title}: the operator did not say ready (${ready.reason === "timeout" ? `no answer within ${seconds(readyWaitMs)}` : "terminal closed"})` };
  if (ready.line.trim().toLowerCase() !== "ready") return { passed: false, detail: `${title}: expected ready, the operator typed "${sanitize(ready.line)}"` };
  const mark = nonce();
  const startedAt = Date.now();
  S.t.out(`countdown started: ${seconds(windowMs)} to answer. Type exactly:  ${good.map((word) => `${mark} ${word}`).join("   or   ")}   (or ${mark} ${bad})`);
  const answer = await readLine(terminal, `${mark}> `, { timeoutMs: windowMs });
  if (!answer.ok) return { passed: false, detail: `${title}: ${answer.reason === "timeout" ? `no answer within ${seconds(windowMs)} of ready` : "terminal closed before an answer"}` };
  const typed = sanitize(answer.line);
  const tokens = answer.line.trim().split(/\s+/);
  if (tokens[0] !== mark) return { passed: false, detail: `${title}: the answer "${typed}" did not carry the nonce ${mark}` };
  if (tokens.length !== 2) return { passed: false, detail: `${title}: the answer "${typed}" is not "<nonce> <verdict>"` };
  if (tokens[1] === bad) return { passed: false, detail: `${title}: the operator answered ${bad} (nonce ${mark})`, verdict: bad };
  if (!good.includes(tokens[1])) return { passed: false, detail: `${title}: the answer "${typed}" is neither ${good.join(" nor ")} nor ${bad}` };
  return { passed: true, verdict: tokens[1], detail: `${title}: the operator typed "${mark} ${tokens[1]}" ${seconds(Date.now() - startedAt)} after ready (answer window ${seconds(windowMs)})` };
}

const notAsked = (S) => ({ passed: false, detail: `not asked: ${S.opts.verifyOnly === true ? "--verify-only" : "--phases script-only"} has no operator, and this assertion is satisfied only by an operator's answer` });

function installCheck(S) {
  const vaults = VAULT_NAMES.map((name) => join(S.vaultsRoot, name));
  return askStep(S, {
    title: "install check",
    instructions: [
      `In Obsidian, open each throwaway vault as a folder vault: ${vaults.join("  and  ")}`,
      "Settings, Community plugins: turn restricted mode off if asked, enable the plugin that the script installed, and confirm it loads without an error.",
      "These are the two vaults of this run only; never open or edit your real vault for this.",
    ],
    good: ["installed"],
    bad: "not-installed",
  });
}

/** What the operator needs to point the plugin of the second vault at this run: the confinement proxy, the demo root and the passphrase file. */
async function pluginSetupLines(S) {
  const session = await S.sessionPromise?.catch(() => undefined);
  return [
    `Configure the plugin in ${join(S.vaultsRoot, VAULT_NAMES[1])}: RPC and gateway URL ${S.apiUrl ?? "(the proxy)"}, MFS root ${S.demoRoot ?? "(the demo root)"}, publication key obsidian-vault-sync.`,
    `The passphrase of the vault is in ${session?.passFile ?? "(not available)"} (mode 0600, removed when this run ends); read it there, never paste it anywhere else.`,
  ];
}

async function firstPullPrompt(S, install) {
  if (!operatorPresent(S)) return notAsked(S);
  if (!install.passed) return { passed: false, detail: `install check not confirmed, the first-pull confirmation was not asked: ${install.detail}` };
  const [second] = VAULT_NAMES.slice(1).map((name) => join(S.vaultsRoot, name));
  const pull = await askStep(S, {
    title: "first-pull confirmation",
    instructions: [
      ...(await pluginSetupLines(S)),
      `In ${second}, run Pull. Before any file is written, the plugin must show the first-pull confirmation dialog. Look at it, then confirm it once.`,
      "Answer shown if you saw the dialog before anything was written, not-shown if you did not.",
    ],
    good: ["shown"],
    bad: "not-shown",
  });
  return { passed: pull.passed, detail: `${install.detail}; ${pull.detail}` };
}

async function blobOutcomePrompt(S, install) {
  if (!install.passed) return { passed: false, detail: "install check not confirmed, the plugin outcome of the large blob was not asked" };
  return askStep(S, {
    title: "large blob in the plugin",
    instructions: [
      "The vault holds a blob of at least 20 MiB (attachments/large-blob.bin). After the Pull above, look at the plugin's result for that file in the second vault.",
      "Answer range-honoured if it was pulled with ranged requests and is present, range-ignored-refused if the plugin refused it because the gateway ignored ranges, failed for anything else.",
    ],
    good: [...BLOB_OUTCOMES],
    bad: "failed",
  });
}

/** The blob assertion: the machine result (CLI pull, byte equality, size floor) and, in an attended run, the operator's recorded plugin outcome. */
function withPluginOutcome(S, machine, outcome) {
  const base = machine ?? { id: BLOB_ID, passed: false, detail: "no machine result" };
  if (!operatorPresent(S)) return { ...base, detail: `${base.detail}; plugin outcome not asked (${S.opts.verifyOnly === true ? "--verify-only" : "--phases script-only"} has no operator)` };
  return { id: BLOB_ID, passed: base.passed && outcome.passed, detail: `${base.detail}; plugin outcome: ${outcome.detail}` };
}

/**
 * The phase. Returns one result for every assertion id of the phase: the machine ones from the CLI steps, the blob one joined with the
 * operator's recorded plugin outcome, and the operator-observed one from the operator's answers (failed, not asked, with no operator).
 * `deps.runMachine` replaces the machine steps (tests of the prompts).
 */
export async function observedStepsPhase(S, deps = {}) {
  const plan = PHASE_PLAN.find((entry) => entry.phase === PHASE_NAME);
  const attended = operatorPresent(S);
  const install = attended ? await installCheck(S) : undefined;
  const machine = new Map((await (deps.runMachine ?? runMachineSteps)(S)).map((result) => [result.id, result]));
  const pull = await firstPullPrompt(S, install);
  const outcome = attended ? await blobOutcomePrompt(S, install) : undefined;
  return plan.assertions.map((id) => {
    if (id === OPERATOR_OBSERVED_ID) return { id, ...pull };
    if (id === BLOB_ID) return withPluginOutcome(S, machine.get(id), outcome);
    return machine.get(id) ?? { id, passed: false, detail: "no machine step recorded this assertion" };
  });
}
