// The run, the opt-in cleanup, the result file and main.
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { USAGE, parseArguments } from "./arguments.mjs";
import { nodeComparison, proxyAudit } from "./audit.mjs";
import { ALLOWED_HOSTS, CLI, CONFIG_FILE, DEMO_PARENT, DEVICE_A, DEVICE_B, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, KEY, Refusal, SIGNAL_EXIT_CODES, SIGNAL_POST_RUN_TIMEOUT_MS, UNVERIFIED } from "./constants.mjs";
import { dryRun } from "./dry-run.mjs";
import { hostilePhase } from "./hostile-phase.mjs";
import { bestEffortPostRun, cleanupTarget, demoRootFor, firstLine, formatPointerLine, formatPostRunLine, isAllowedUpstream, newRunId, resolvePreviousPointer, restoreInstruction, staleBuildRefusal, win32Refusal } from "./policy.mjs";
import { createProxy, plantOutsideRequest, proxySelfTest } from "./proxy.mjs";
import { check, checks, guarded, note, out, skips } from "./report.mjs";
import { prepareDevices, sharedPhase } from "./shared-phase.mjs";
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

/**
 * Facts printed to stdout as they are learned and stored in the result document (stdout is what survives a crash).
 * On the shared-node path only the node's never-published answer is accepted as "unresolved"; any other failure is retried and then
 * refused before the first mutation (M-01), unless --accept-unresolved-pointer was given.
 */
async function recordPreRun(client, before, facts, opts) {
  const keyId = before.keys.get(KEY);
  let pointerUnknown = false;
  const previousPointer = keyId === undefined ? null : await resolvePreviousPointer(() => client.nameResolve(keyId), { strict: !opts.localStub, acceptUnresolved: opts.acceptUnresolvedPointer, onPointerUnknown: () => { pointerUnknown = true; } });
  facts.preRun = { keyId: keyId ?? null, previousPointer, ...(pointerUnknown ? { pointerUnknown } : {}) };
  facts.baseChildrenBefore = [...before.base.keys()].sort();
  out(formatPointerLine(keyId, previousPointer));
}

/**
 * After the run, in a finally: where the owned key points now, next to the pre-run line, and the exact restore text (M-02). The
 * restore is the operator's step (name/publish is limited to the demo root's CIDs), so the script only prints and stores it.
 */
async function recordPostRun(client, facts, live) {
  live.postRunStarted = true;
  try {
    const keyId = (await client.keyList()).find((key) => key.name === KEY)?.id;
    const pointer = keyId === undefined ? null : await client.nameResolve(keyId).catch((error) => `unresolved (${firstLine(error instanceof Error ? error.message : String(error))})`);
    facts.postRun = { keyId: keyId ?? null, pointer };
  } catch (error) {
    facts.postRun = { keyId: null, pointer: `unreadable (${firstLine(error instanceof Error ? error.message : String(error))})` };
  }
  facts.restore = restoreInstruction(facts.preRun);
  out("\n-- IPNS pointer of the owned key, before and after --");
  out(formatPointerLine(facts.preRun.keyId ?? undefined, facts.preRun.previousPointer));
  out(formatPostRunLine(facts.postRun.keyId ?? undefined, facts.postRun.pointer));
  out(facts.restore);
}

/**
 * Signal exit (N-02 c): print where the owned key points and the restore text if the pre-run pointer is known, bounded by
 * SIGNAL_POST_RUN_TIMEOUT_MS. Says so when the record fails or the run had not reached the pre-run line (no mutation had been sent then).
 */
async function signalPostRun(live, facts) {
  if (live.postRunStarted === true) return;
  if (live.client === undefined || facts.preRun === undefined) {
    out("\nrun ended by a signal before the pre-run pointer was recorded; no request that changes the node had been sent, so there is nothing to restore.");
    return;
  }
  out("\nrun ended by a signal; recording the post-run pointer (best effort)...");
  const result = await bestEffortPostRun(() => recordPostRun(live.client, facts, live), { timeoutMs: SIGNAL_POST_RUN_TIMEOUT_MS });
  if (!result.ok) out(`post-run pointer NOT recorded (${result.reason}). The pre-run line printed earlier is the saved record: ${restoreInstruction(facts.preRun)}`);
}

async function runFeature(opts, work, tb, facts, live) {
  const runId = newRunId();
  const demoRoot = demoRootFor(runId);
  const cliPath = opts.cli ?? CLI;
  const stub = opts.localStub ? await startStub(tb) : undefined;
  const upstream = stub === undefined ? sharedTarget(tb, opts) : { rpc: stub.url, gateway: stub.url };
  const configFile = opts.localStub ? join(work, "stub-shared-config.json") : CONFIG_FILE;
  await ensureConfig(configFile);
  const client = readOnly(tb.makeClient(process.env, upstream.rpc, upstream.gateway, demoRoot));
  live.client = client;
  const before = await nodeSnapshot(client);
  await recordPreRun(client, before, facts, opts);
  const explicit = opts.ownedKey === undefined ? [] : [opts.ownedKey];
  assertKeyAdoptable(before.keys, await readOwnedKeys(configFile), explicit);
  const absent = await client.filesStat(demoRoot).then(() => false, () => true);
  if (!absent) throw new Refusal(`${demoRoot} already exists on the node`);
  const cwd = join(work, "cwd");
  const secretsDir = join(work, "secrets");
  await mkdir(cwd, { recursive: true });
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const proxy = createProxy({ upstream, demoRoot });
  const apiUrl = await proxy.start();
  out(`feature operation mvp-07a  ${opts.localStub ? "LOCAL STUB" : "shared node"}  upstream ${upstream.rpc}\ndemo root ${demoRoot}\nproxy ${apiUrl}  key ${KEY}  config ${configFile}\ndevices ${DEVICE_A} and ${DEVICE_B}, each with its own vault directory, config and per-user state directory\n${opts.tamper === undefined ? "" : `tamper ${opts.tamper}\n`}`);
  const S = {
    opts,
    tb,
    work,
    cwd,
    runId,
    demoRoot,
    client,
    proxy,
    stub,
    apiUrl,
    cliPath,
    secrets: [],
    tampered: new Set(),
    pullReads: new Map(),
    ownedFlags: explicit.flatMap((id) => ["--owned-key", id]),
    passFile: join(secretsDir, "passphrase.txt"),
    A: { vault: join(work, "vault-a"), stateHome: join(work, "state-a") },
    B: { vault: join(work, "vault-b"), stateHome: join(work, "state-b"), configFile: join(work, "config-b.json") },
    view: { tb, client, demoRoot },
  };
  await ensureConfig(S.B.configFile);
  await prepareDevices(S, configFile);
  try {
    await proxySelfTest(demoRoot);
    await guarded("two-device phase", () => sharedPhase(S));
    await guarded("hostile-object phase", () => hostilePhase(S));
    await guarded("node comparison", () => nodeComparison(S, before));
    if (opts.tamper === "outside-allowlist") await plantOutsideRequest(proxy);
    proxyAudit(S);
  } finally {
    await recordPostRun(client, facts, live);
    await proxy.stop();
    if (S.passphrase !== undefined) tb.wipe(S.passphrase);
    await stub?.stop();
  }
  return runId;
}

async function cleanupRun(opts) {
  const target = cleanupTarget(opts.cleanup);
  if (opts.dryRun) {
    out(`dry run: would files/stat and then files/rm -r ${target}; nothing else, no key and no pin is touched`);
    return EXIT_OK;
  }
  await acquireLock();
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop07a-clean-"));
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
  const cli = opts.cli ?? CLI;
  const fresh = checkBuildFresh(cli);
  if (!fresh.ok && !opts.allowStaleBuild) throw new Refusal(fresh.message);
  const facts = { distSha256: distSha256(cli), ...(opts.cli === undefined ? {} : { cli }) };
  out(`${opts.cli === undefined ? "dist/cli/ipfs-sync.mjs" : cli} sha256 ${facts.distSha256}`);
  await acquireLock();
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop07a-"));
  // SIGINT, SIGTERM and SIGHUP all remove the work directory (it holds the 0600 passphrase file) before exiting (L-08), after a bounded
  // best-effort print of the post-run pointer and the restore text (N-02 c).
  const live = {};
  const onSignal = Object.entries(SIGNAL_EXIT_CODES).map(([signal, code]) => {
    const handler = () => {
      const finish = () => {
        rmSync(work, { recursive: true, force: true });
        process.exit(code);
      };
      signalPostRun(live, facts).then(finish, finish);
    };
    process.once(signal, handler);
    return [signal, handler];
  });
  const shown = opts.cli === undefined ? "dist/cli/ipfs-sync.mjs" : cli;
  let runId;
  try {
    const tb = await buildToolbox(work);
    runId = await runFeature(opts, work, tb, facts, live);
  } finally {
    if (opts.keepWork) note(`work directory kept at ${work}; it holds the throwaway vault's passphrase file`);
    else await rm(work, { recursive: true, force: true });
    // L-04: a check, computed here so a run that threw still reports it.
    const sha = distSha256(cli);
    facts.distUnchangedDuringRun = sha === facts.distSha256;
    check(`${shown} was unchanged during the run (sha256 recomputed after it)`, facts.distUnchangedDuringRun, `sha256 ${sha}`);
    for (const [signal, handler] of onSignal) process.off(signal, handler);
  }
  const failed = checks.filter((entry) => !entry.passed);
  out(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length === 0 ? "" : `; failed: ${failed.map((entry) => entry.label).join(" | ")}`}${skips.length === 0 ? "" : `; ${skips.length} skipped`}`);
  out(`\nUnverified even after a pass: ${UNVERIFIED.join("; ")}.`);
  if (!opts.localStub) out(`\nThe demo folder ${DEMO_PARENT}/${runId} stays on the node. To remove it (opt-in): node tools/feature-op-mvp-07a.mjs --cleanup ${runId}`);
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
    const unsupported = win32Refusal(process.platform);
    if (unsupported !== undefined) throw new Refusal(unsupported);
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
