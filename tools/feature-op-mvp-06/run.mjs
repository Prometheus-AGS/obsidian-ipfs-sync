// The run, the opt-in cleanup, the result file and main.
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { USAGE, parseArguments } from "./arguments.mjs";
import { makeCliRunner } from "./children.mjs";
import { ALLOWED_HOSTS, CONFIG_FILE, DEMO_PARENT, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, KEY, Refusal, UNVERIFIED } from "./constants.mjs";
import { dryRun } from "./dry-run.mjs";
import { hostilePhase } from "./hostile-phase.mjs";
import { demoRootFor, formatPointerLine, isAllowedUpstream, isWithin, newRunId, staleBuildRefusal } from "./policy.mjs";
import { createProxy, plantOutsideRequest, proxySelfTest } from "./proxy.mjs";
import { check, checks, guarded, note, out, skips } from "./report.mjs";
import { argonAndTamper, nodeComparison, proxyAudit, sharedPhase } from "./shared-phase.mjs";
import { startStub } from "./stub-node.mjs";
import { buildToolbox, checkBuildFresh, distSha256 } from "./toolbox.mjs";
import { acquireLock, assertKeyAdoptable, ensureConfig, nodeSnapshot, readOnly, readOwnedKeys } from "./workspace.mjs";

// ======================================================================================================================
// The run
// ======================================================================================================================

function sharedTarget(tb, opts) {
  const target = tb.targetFromEnv(process.env);
  for (const url of [target.rpc, target.gateway]) if (!isAllowedUpstream(url, opts.localStub)) throw new Refusal(`upstream ${url} is not ${ALLOWED_HOSTS.join(" or ")}; this script only talks to the shared node's host (unset IPFS_SYNC_RPC_URL and IPFS_SYNC_GATEWAY_URL)`);
  return target;
}

/** Facts printed to stdout as they are learned and stored in the result document (stdout is what survives a crash). */
async function recordPreRun(client, before, facts) {
  const keyId = before.keys.get(KEY);
  const previousPointer = keyId === undefined ? null : await client.nameResolve(keyId).catch(() => "unresolved");
  facts.preRun = { keyId: keyId ?? null, previousPointer };
  out(formatPointerLine(keyId, previousPointer));
}

async function runFeature(opts, work, tb, facts) {
  const runId = newRunId();
  const demoRoot = demoRootFor(runId);
  const stub = opts.localStub ? await startStub(tb) : undefined;
  const upstream = stub === undefined ? sharedTarget(tb, opts) : { rpc: stub.url, gateway: stub.url };
  const configFile = opts.localStub ? join(work, "stub-shared-config.json") : CONFIG_FILE;
  await ensureConfig(configFile);
  const client = readOnly(tb.makeClient(process.env, upstream.rpc, upstream.gateway, demoRoot));
  const before = await nodeSnapshot(client);
  await recordPreRun(client, before, facts);
  const explicit = opts.ownedKey === undefined ? [] : [opts.ownedKey];
  assertKeyAdoptable(before.keys, await readOwnedKeys(configFile), explicit);
  const absent = await client.filesStat(demoRoot).then(() => false, () => true);
  if (!absent) throw new Refusal(`${demoRoot} already exists on the node`);
  const cwd = join(work, "cwd");
  const secretsDir = join(work, "secrets");
  await mkdir(cwd, { recursive: true });
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const proxy = createProxy({ upstream, demoRoot });
  const secrets = [];
  const apiUrl = await proxy.start();
  out(`feature operation mvp-06  ${opts.localStub ? "LOCAL STUB" : "shared node"}  upstream ${upstream.rpc}\ndemo root ${demoRoot}\nproxy ${apiUrl}  key ${KEY}  config ${configFile}\n${opts.tamper === undefined ? "" : `tamper ${opts.tamper}\n`}`);
  const S = { opts, tb, work, cwd, runId, demoRoot, client, proxy, stub, secrets, apiUrl, files: [], vault: join(work, "vault"), passFile: join(secretsDir, "passphrase.txt") };
  S.cli = makeCliRunner({ tb, cwd, apiUrl, configFile, demoRoot, ownedFlags: explicit.flatMap((id) => ["--owned-key", id]), secrets: () => secrets });
  try {
    await proxySelfTest(proxy, demoRoot);
    const latest = await guarded("shared-node phase", () => sharedPhase(S));
    await guarded("hostile-object phase", () => hostilePhase(S));
    if (latest?.manifest !== undefined) await guarded("Argon2id and tamper step", () => argonAndTamper(S, latest));
    await guarded("node comparison", () => nodeComparison(S, before));
    if (opts.tamper === "proxy-outside-allowlist") await plantOutsideRequest(proxy);
    proxyAudit(S);
  } finally {
    await proxy.stop();
    if (S.passphrase !== undefined) tb.wipe(S.passphrase);
    await stub?.stop();
  }
  return runId;
}

async function cleanupRun(opts) {
  const target = demoRootFor(opts.cleanup);
  if (!isWithin(target, DEMO_PARENT)) throw new Refusal(`${target} is not below ${DEMO_PARENT}`);
  if (opts.dryRun) {
    out(`dry run: would files/stat and then files/rm -r ${target}; nothing else, no key and no pin is touched`);
    return EXIT_OK;
  }
  await acquireLock();
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop06-clean-"));
  try {
    const tb = await buildToolbox(work);
    const upstream = sharedTarget(tb, opts);
    const client = tb.makeClient(process.env, upstream.rpc, upstream.gateway, target);
    const found = await client.filesStat(target).catch(() => undefined);
    if (found === undefined) throw new Refusal(`${target} does not exist on the node; nothing to remove`);
    out(`removing ${target} (root CID ${found.cid}) with files/rm -r; keys, pins and the IPNS record are not touched (this project never unpins)`);
    await client.filesRm(target, { recursive: true });
    check(`${target} is gone from MFS`, await client.filesStat(target).then(() => false, () => true));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return checks.every((entry) => entry.passed) ? EXIT_OK : EXIT_FAILED;
}

async function writeResult(opts, runId, code, facts) {
  const failed = checks.filter((entry) => !entry.passed);
  const document = { passed: failed.length === 0 && checks.length > 0 && opts.tamper === undefined && !opts.localStub, status: failed.length === 0 ? "pass" : "fail", mode: opts.localStub ? `local-stub${opts.tamper === undefined ? "" : `+tamper-${opts.tamper}`}` : "shared-node", runId, demoRoot: runId === undefined ? null : `${DEMO_PARENT}/${runId}`, finishedAt: new Date().toISOString(), exitCode: code, ...facts, checks, skipped: skips, unverified: UNVERIFIED };
  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out, `${JSON.stringify(document, null, 2)}\n`);
  out(`result written to ${opts.out}`);
}

export async function run(opts) {
  const stale = staleBuildRefusal(opts);
  if (stale !== undefined) throw new Refusal(stale);
  const fresh = checkBuildFresh();
  if (!fresh.ok && !opts.allowStaleBuild) throw new Refusal(fresh.message);
  const facts = { distSha256: distSha256() };
  out(`dist/cli/ipfs-sync.mjs sha256 ${facts.distSha256}`);
  await acquireLock();
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop06-"));
  process.once("SIGINT", () => {
    rmSync(work, { recursive: true, force: true });
    process.exit(130);
  });
  let runId;
  try {
    const tb = await buildToolbox(work);
    runId = await runFeature(opts, work, tb, facts);
  } finally {
    if (opts.keepWork) note(`work directory kept at ${work}; it holds the throwaway vault's passphrase file`);
    else await rm(work, { recursive: true, force: true });
  }
  facts.distUnchangedDuringRun = distSha256() === facts.distSha256;
  out(`dist/cli/ipfs-sync.mjs unchanged during the run: ${facts.distUnchangedDuringRun} (sha256 ${distSha256()})`);
  const failed = checks.filter((entry) => !entry.passed);
  out(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length === 0 ? "" : `; failed: ${failed.map((entry) => entry.label).join(" | ")}`}${skips.length === 0 ? "" : `; ${skips.length} skipped`}`);
  out(`\nUnverified even after a pass: ${UNVERIFIED.join("; ")}.`);
  if (!opts.localStub) out(`\nThe demo folder ${DEMO_PARENT}/${runId} stays on the node. To remove it (opt-in): node tools/feature-op-mvp-06.mjs --cleanup ${runId}`);
  const code = failed.length === 0 ? EXIT_OK : EXIT_FAILED;
  await writeResult(opts, runId, code, facts);
  return code;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return EXIT_REFUSED;
  }
  if (opts.help) {
    out(USAGE);
    return EXIT_OK;
  }
  try {
    if (opts.cleanup !== undefined) return await cleanupRun(opts);
    return opts.dryRun ? await dryRun(opts) : await run(opts);
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`refused: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    process.stderr.write(`feature operation crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return EXIT_FAILED;
  }
}
