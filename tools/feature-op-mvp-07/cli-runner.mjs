// The hash-bound CLI bundle (dist/cli/ipfs-sync.mjs, or <--dist-dir>/cli on a stub run) as a CHILD PROCESS, one runner per simulated device.
// Every request of a child goes through the confinement proxy: the argv always carries the proxy's loopback URL for both the RPC and the
// gateway and an MFS root inside the run's demo root, and the environment is 07a's scrubbed allowlist. Nothing here loads project code.
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { CHILD_TIMEOUT_MS } from "../feature-op-mvp-07a/constants.mjs";
import { scrub } from "../feature-op-mvp-07a/children.mjs";
import { KEY, Refusal } from "./constants.mjs";
import { isLoopbackUrl } from "../feature-op-mvp-07a/policy.mjs";
import { childEnv, isOutsideRepo, isWithin } from "./policy.mjs";

function execChild(cli, argv, env, cwd) {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => done({ code: 127, stdout, stderr: `${stderr}${error.message}`, ms: 0 }));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, ms: Math.round(performance.now() - started) });
    });
  });
}

/**
 * A runner for one device: its own config file, its own per-user state directory (XDG_STATE_HOME: device id and sequence floor), its own
 * device label. `secrets()` is read after each run so the output is scrubbed of every passphrase spelling known by then.
 * Returns async (command, operands, { passphraseFile, extra }) => { code, stdout, stderr, ms, leaked }.
 */
export function makeCliRunner({ cliPath, cwd, apiUrl, configFile, demoRoot, ownedFlags, secrets, device, stateHome, env, localStub, onRun = () => undefined }) {
  if (typeof stateHome !== "string" || !isAbsolute(stateHome) || !isOutsideRepo(stateHome)) throw new Refusal("every child needs its own per-run state directory outside the repository (XDG_STATE_HOME)");
  if (!isLoopbackUrl(apiUrl)) throw new Refusal(`the children's API URL ${apiUrl} is not a loopback URL (the confinement proxy)`);
  if (!isWithin(demoRoot, "/obsidian-vault-sync", { allowEqual: false })) throw new Refusal(`the children's MFS root ${demoRoot} is not below /obsidian-vault-sync`);
  return async (command, operands, { passphraseFile, extra = [] } = {}) => {
    const argv = [command, ...operands, ...extra, "--config", configFile, "--rpc-url", apiUrl, "--gateway-url", apiUrl, "--mfs-root", demoRoot, "--key", KEY, ...ownedFlags];
    const childEnvironment = childEnv(env, { IPFS_SYNC_DEVICE: device, XDG_STATE_HOME: stateHome, ...(passphraseFile === undefined ? {} : { IPFS_SYNC_PASSPHRASE_FILE: passphraseFile }) }, { localStub });
    const result = scrub(await execChild(cliPath, argv, childEnvironment, cwd), secrets());
    onRun({ device, command, code: result.code, ms: result.ms });
    return result;
  };
}
