// A scenario is a small throwaway vault on its OWN MFS root below the run's demo root (<DEMO_ROOT>/<name>), with its own devices (vault directory,
// per-user state directory, config), its own passphrase file (0600) and a CLI runner per device. Scenarios do not share state, so each assertion of
// the script-only phases stands alone; they share the owned key (its pointer moves to the last root published, which the post-run line records).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInitOutput, parsePublishOutput, parsePullOutput, pullTraceProblems, scrubbedDetail, withPassphraseSpellings } from "../feature-op-mvp-07a/policy.mjs";
import { ensureConfig } from "../feature-op-mvp-07a/workspace.mjs";
import { makeCliRunner } from "./cli-runner.mjs";
import { KEY } from "./constants.mjs";
import { MARKER, ownedFlagsForA } from "./machine-session.mjs";
import { firstLine } from "./policy.mjs";

const SEED_FILES = Object.freeze({
  "notes/one.md": "# One\n\nfirst note, version one\n",
  "notes/two.md": "# Two\n\nsecond note, version one\n",
  "projects/three.md": "# Three\n\nthird note, version one\n",
});
export const SEED_PATHS = Object.freeze(Object.keys(SEED_FILES));

/** The owned key's ID, read once it exists (after the first publish of any scenario or session). */
export async function ownedKeyId(S) {
  if (S.ownedKeyId === undefined) S.ownedKeyId = (await S.client.keyList()).find((key) => key.name === KEY)?.id;
  if (typeof S.ownedKeyId !== "string" || S.ownedKeyId === "") {
    S.ownedKeyId = undefined;
    throw new Error(`the owned key ${KEY} is not on the node`);
  }
  return S.ownedKeyId;
}

export async function openScenario(S, name) {
  const root = `${S.demoRoot}/${name}`;
  const dir = join(S.work, `scenario-${name}`);
  const secretsDir = join(dir, "secrets");
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const sc = { name, root, dir, secretsDir, passFile: join(secretsDir, "pass0.txt"), secrets: [], pulls: [], devices: new Map(), vaultId: undefined };
  const onRun = (run) => S.t.out(`  cli ${run.device} ${run.command}: exit ${run.code}, ${run.ms} ms`);

  /** A device: `primary` shares the run's config (the owned key is recorded there); the others have their own and are given the key ID. */
  sc.device = async (tag, { primary = false, cliPath = join(S.distDir, "cli", "ipfs-sync.mjs") } = {}) => {
    const base = join(dir, tag);
    const device = { tag, vault: join(base, "vault"), stateHome: join(base, "state"), configFile: primary ? S.configFile : join(base, "config.json") };
    await mkdir(device.vault, { recursive: true });
    await mkdir(device.stateHome, { recursive: true });
    if (!primary) await ensureConfig(device.configFile);
    const ownedFlags = primary ? ownedFlagsForA(S) : ["--owned-key", await ownedKeyId(S)];
    device.makeRunner = (path) => makeCliRunner({ cliPath: path, cwd: dir, apiUrl: S.apiUrl, configFile: device.configFile, demoRoot: root, ownedFlags, secrets: () => sc.secrets, device: `fop07b-${name}-${tag}`, stateHome: device.stateHome, env: S.env, localStub: S.opts.localStub, onRun });
    device.runner = device.makeRunner(cliPath);
    sc.devices.set(tag, device);
    return device;
  };

  /** One CLI command of `device`, with the scenario's current passphrase file unless `pass` names another (or null for none). */
  sc.cli = (device, command, operands, { pass = sc.passFile, extra = [], runner = device.runner } = {}) => runner(command, operands, { passphraseFile: pass === null ? undefined : pass, extra });

  sc.publish = async (device, options) => {
    const run = await sc.cli(device, "publish", [device.vault], options);
    return { run, summary: parsePublishOutput(run.stdout) };
  };

  /** A pull through the proxy; the audit of its slice of the proxy log goes on the scenario. */
  sc.pull = async (device, label, options = {}) => {
    const mark = S.proxy.mark();
    const run = await sc.cli(device, "pull", [device.vault], options);
    const trace = S.proxy.since(mark);
    sc.pulls.push({ label, problems: pullTraceProblems(trace), requests: trace.length });
    return { run, trace, summary: parsePullOutput(run.stdout) };
  };

  /** The first device: three seed notes and the fixture marker, `init` with a passphrase file, and publish #1 (sequence 1). Throws when setup cannot finish. */
  sc.setup = async () => {
    const primary = await sc.device("p", { primary: true });
    for (const [path, text] of Object.entries(SEED_FILES)) {
      await mkdir(join(primary.vault, ...path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(primary.vault, ...path.split("/")), text);
    }
    await writeFile(join(primary.vault, MARKER), "fixture\n");
    const init = await sc.cli(primary, "init", [primary.vault], { pass: null, extra: ["--passphrase-file", sc.passFile] });
    if (init.code !== 0) throw new Error(`init exited ${init.code}: ${scrubbedDetail(init, sc.secrets)}`);
    sc.secrets.push(...withPassphraseSpellings([], await readFile(sc.passFile, "utf8")));
    sc.vaultId = parseInitOutput(init.stdout).vaultId;
    const first = await sc.publish(primary);
    if (first.run.code !== 0 || first.summary.sequence !== 1) throw new Error(`publish #1 exited ${first.run.code}, sequence ${first.summary.sequence}: ${scrubbedDetail(first.run, sc.secrets)}`);
    sc.roots = [first.summary.rootCid];
    S.pointerMoved = true; // the owned key now points into this scenario's root, not into the run's main vault
    await ownedKeyId(S);
    return { primary, first };
  };

  /** A second device that has pulled the current state (first pull, accepted). */
  sc.joiner = async (tag, extra = []) => {
    const device = await sc.device(tag);
    const joined = await sc.pull(device, `${tag} first pull`, { extra: ["--accept-first-pull", ...(sc.vaultId === undefined ? [] : ["--expect-vault-id", sc.vaultId]), ...extra] });
    if (joined.run.code !== 0) throw new Error(`the first pull of device ${tag} exited ${joined.run.code}: ${firstLine(joined.run.stderr)}`);
    return { device, joined };
  };
  return sc;
}

/** The detail line of a command that was expected to succeed. */
export const outcome = (run, secrets) => `exit ${run.code}: ${scrubbedDetail(run, secrets) || firstLine(run.stdout)}`;
