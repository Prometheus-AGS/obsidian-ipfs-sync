// CLI child processes: spawn, the effective-target assertion and output scrubbing.
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { CHILD_TIMEOUT_MS, CLI, KEY, Refusal } from "./constants.mjs";
import { childEnv, firstLine, isLoopbackUrl, isWithin, redact } from "./policy.mjs";

// ======================================================================================================================
// Child processes
// ======================================================================================================================

function execChild(argv, env, cwd) {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

/** Refuse to start a child unless its effective configuration is exactly the intended loopback target. */
export async function assertEffectiveTarget(tb, argv, env, { url, demoRoot }) {
  const effective = await tb.effectiveConfig(argv, env).catch((error) => {
    throw new Refusal(`refusing to start a child: its configuration does not load (${firstLine(error.message)})`);
  });
  const problems = [];
  if (!isLoopbackUrl(url)) problems.push(`the intended API URL ${url} is not a loopback URL`);
  if (effective.rpc !== url) problems.push(`effective RPC URL is ${effective.rpc}, expected ${url}`);
  if (effective.gateway !== url) problems.push(`effective gateway URL is ${effective.gateway}, expected ${url}`);
  if (!isWithin(effective.mfsRoot, demoRoot, { allowEqual: true })) problems.push(`effective MFS root ${effective.mfsRoot} is outside ${demoRoot}`);
  if (effective.key !== KEY) problems.push(`effective publication key is ${effective.key}, expected ${KEY}`);
  if (problems.length > 0) throw new Refusal(`refusing to start a child: ${problems.join("; ")}`);
}

export function scrub(result, secrets) {
  const combined = `${result.stdout}\n${result.stderr}`;
  return { ...result, leaked: secrets.some((secret) => secret !== "" && combined.includes(secret)), stdout: redact(result.stdout, secrets), stderr: redact(result.stderr, secrets) };
}

export function makeCliRunner({ tb, cwd, apiUrl, configFile, demoRoot, ownedFlags, secrets }) {
  return async (command, operands, { passphraseFile, mfsRoot = demoRoot, extra = [] } = {}) => {
    const argv = [command, ...operands, ...extra, "--config", configFile, "--rpc-url", apiUrl, "--gateway-url", apiUrl, "--mfs-root", mfsRoot, "--key", KEY, ...ownedFlags];
    const env = childEnv(process.env, { IPFS_SYNC_DEVICE: "feature-op-mvp06", ...(passphraseFile === undefined ? {} : { IPFS_SYNC_PASSPHRASE_FILE: passphraseFile }) });
    await assertEffectiveTarget(tb, argv, env, { url: apiUrl, demoRoot });
    return scrub(await execChild(argv, env, cwd), secrets());
  };
}
