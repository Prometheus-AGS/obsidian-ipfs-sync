// Trigger helpers for tools/feature-op-mvp-04.mjs: what the operator is told, how the script waits for
// the plugin's publish to show up on the node, and the guarded route that drives Obsidian's own CLI.

/** The script refused to run (usage, unsafe target, failed preflight). The caller exits with code 2. */
export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

export const DEFAULT_TIMEOUT_MINUTES = 15;
export const DEFAULT_REFUSAL_WAIT_SECONDS = 120;
export const POLL_MS = 3000;
const PROGRESS_EVERY_MS = 15000;
const CLI_COMMAND_TIMEOUT_MS = 30000;
export const DEFAULT_OBSIDIAN_BIN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";

export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function operatorSteps({ fixtureVault, timeoutMinutes }) {
  return [
    "== operator steps (trigger=manual) ==",
    `Throwaway fixture vault: ${fixtureVault}`,
    "Use only this vault. Do not open your real vault for this checkpoint.",
    "1. In Obsidian open the vault switcher and choose \"Open folder as vault\", then pick the folder above.",
    "   (Obsidian adds it to its vault list; remove the entry afterwards. This script deletes the folder when it ends.)",
    "2. When Obsidian asks, allow community plugins for this vault. In Settings > Community plugins, enable \"IPFS Sync\"",
    "   (this script already installed it into the vault).",
    "3. Open the settings tab \"IPFS Sync\" and take a screenshot in the dark theme and one in the light theme.",
    "4. Run the command \"IPFS Sync: Publish vault\" from the command palette (or click the ribbon icon).",
    "5. Read the notice. Expected: \"published: 1 written, 0 removed\". Save a screenshot or copy the exact text as evidence.",
    `This script now polls the vault's own sync record (.ipfs-sync/state.json) every ${POLL_MS / 1000} s and continues when it shows a new published root.`,
    `It gives up after ${timeoutMinutes} minutes (--timeout-minutes) and then exits 1.`,
  ].join("\n");
}

export function refusalSteps({ noMarkerVault, waitSeconds }) {
  return [
    "== operator step 2 of 2: the refusal check ==",
    `Vault without the fixture marker: ${noMarkerVault}`,
    "1. In Obsidian choose \"Open folder as vault\" for the folder above and enable \"IPFS Sync\" there.",
    "2. Run \"IPFS Sync: Publish vault\". Expected: a notice that only synthetic fixture vaults can be published, and no",
    "   request to the node. Save the notice text or a screenshot as evidence.",
    `3. Press Enter here when done, or wait ${waitSeconds} s (--refusal-wait-seconds). The script then checks that nothing changed.`,
  ].join("\n");
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `resolveRoot()` differs from `baseline`. Prints the remaining time every 15 s.
 * Returns the new root, or undefined when the deadline passes. A failed poll counts as "unchanged".
 */
export async function waitForNewRoot({ resolveRoot, baseline, timeoutMs, out, sleep = sleepMs, now = Date.now }) {
  const deadline = now() + timeoutMs;
  let lastPrint = -Infinity;
  out(`waiting for the vault to record a new published root (timeout ${formatRemaining(timeoutMs)})`);
  while (now() < deadline) {
    const current = await resolveRoot().catch(() => baseline);
    if (current !== baseline) return current;
    if (now() - lastPrint >= PROGRESS_EVERY_MS) {
      out(`  still waiting for the publish ... ${formatRemaining(deadline - now())} remaining`);
      lastPrint = now();
    }
    await sleep(POLL_MS);
  }
  return undefined;
}

/** Poll `check()` until it returns a truthy value or the timeout passes. */
export async function waitUntil(check, timeoutMs, sleep = sleepMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(1000);
  }
}

/** Resolve on Enter (when stdin is a terminal) or after `seconds`, printing the time left every 15 s. */
export async function waitForEnterOrTimeout({ seconds, out, stdin }) {
  const deadline = Date.now() + seconds * 1000;
  let pressed = false;
  const onData = () => {
    pressed = true;
  };
  if (stdin.isTTY) stdin.once("data", onData);
  let lastPrint = -Infinity;
  while (!pressed && Date.now() < deadline) {
    if (Date.now() - lastPrint >= PROGRESS_EVERY_MS) {
      out(`  waiting for you ... ${formatRemaining(deadline - Date.now())} remaining`);
      lastPrint = Date.now();
    }
    await sleepMs(500);
  }
  if (stdin.isTTY) {
    stdin.off("data", onData);
    stdin.pause();
  }
}

/**
 * Route A: Obsidian's own CLI (the app binary invoked with a command). Every call is built here and starts with
 * `vault=<throwaway name>`; nothing can run before `preflight()` has confirmed that Obsidian reports the throwaway
 * folder (and not a forbidden path) for that vault name. `exec(bin, args, timeoutMs)` returns {code, stdout, stderr}.
 */
export function createObsidianRoute({ bin, vaultName, vaultPath, isForbidden, exec, realpath }) {
  let confirmed = false;

  async function call(args) {
    const argv = [`vault=${vaultName}`, ...args];
    if (argv[0] !== `vault=${vaultName}`) throw new Refusal("internal error: Obsidian CLI call without the throwaway vault");
    if (!confirmed && args.join(" ") !== "vault info=path") throw new Refusal("Obsidian CLI call before the vault path check passed");
    return exec(bin, argv, CLI_COMMAND_TIMEOUT_MS);
  }

  async function preflight() {
    const probe = await call(["vault", "info=path"]);
    const reported = probe.stdout.trim();
    if (probe.code !== 0 || reported === "") {
      throw new Refusal(
        `route A refused: Obsidian does not know a vault named "${vaultName}" (exit ${probe.code}). ` +
          "An unregistered throwaway vault cannot be driven; use --trigger=manual.",
      );
    }
    if (isForbidden(reported)) throw new Refusal("route A refused: Obsidian resolved that vault name to a forbidden path");
    if ((await realpath(reported)) !== (await realpath(vaultPath))) {
      throw new Refusal(`route A refused: vault "${vaultName}" resolves to ${reported}, not the throwaway folder ${vaultPath}`);
    }
    confirmed = true;
  }

  /** Enable the plugin in the throwaway vault and run its Publish command. Returns the printed evidence. */
  async function publish() {
    await preflight();
    const steps = [["plugins:restrict", "off"], ["plugin:enable", "id=ipfs-sync"], ["command", "id=ipfs-sync:publish-vault"]];
    const transcript = [];
    for (const step of steps) {
      const result = await call(step);
      transcript.push({ step: step.join(" "), code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
      if (result.code !== 0) return { ok: false, transcript };
    }
    return { ok: true, transcript };
  }

  return { publish };
}
