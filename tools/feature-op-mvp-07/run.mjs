// The run, the dry run and main of the mvp-07b operator-run harness. The skeleton of task 4.6: guards, lock, node snapshot, proxy,
// the phase plan, the result and the transcript. The phases of tasks 4.7a and 4.7b are stubs that fail their assertions.
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BUILD_OUTPUTS, computeTreeHash, readGuardBuildState } from "../check-guard-preconditions.mjs";
import { createProxy, runProxySelfTest } from "../feature-op-mvp-07a/proxy.mjs";
import { USAGE, parseArguments } from "./arguments.mjs";
import { ALLOWED_HOSTS, CONFIG_FILE, DEMO_PARENT, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, KEY, LOCK_FILE, OPERATOR_RECORD_MAX_AGE_MS, REPO, Refusal, SIGNAL_EXIT_CODES, SIGNAL_POST_RUN_TIMEOUT_MS, STAGING_ROOT, VAULT_NAMES } from "./constants.mjs";
import { harnessAuditPhase, harnessInstallPhase } from "./harness-phases.mjs";
import { buildReader, makeReadClient, readTarget, startStubChild } from "./node-reader.mjs";
import { acquireLock, assertKeyAdoptable, ensureConfig, nodeSnapshot, readOwnedKeys } from "./node-view.mjs";
import { ANSWER_WINDOW_MS, READY_WAIT_MS, assertOperatorTerminal, observedStepsPhase, randomNonce } from "./observed-phase.mjs";
import { PRUNE_ROUNDS } from "./cli-scenarios.mjs";
import { hostilePreparerPhase } from "./hostile-phase.mjs";
import { buildHostileTools } from "./hostile-tools.mjs";
import { LARGE_BLOB_BYTES, LARGE_BLOB_MIN_BYTES } from "./machine-checks.mjs";
import { getSession } from "./machine-session.mjs";
import { PHASE_PLAN, assertPlanMatchesChecker, exportedAssertionList, scopeFor } from "./phases.mjs";
import { scriptOnlyCliPhase } from "./script-only-phase.mjs";
import { assertThrowawayPath, bestEffortPostRun, decideRequest, demoRootFor, firstLine, formatPointerLine, formatPostRunLine, isAllowedUpstream, newRunId, recordNamesFor, resolvePreviousPointer, restoreInstruction, runMode, guardBuildRefusal, win32Refusal } from "./policy.mjs";
import { buildRecord, createTranscript, featureOpsDirectory, prepareOutputDirectory, writeOperatorFiles } from "./record.mjs";

const UNVERIFIED = [
  "the plugin's own publish and pull: the machine steps stand in for it with the built CLI, so only the operator's typed answers speak for the plugin",
  "fork resolution by the hash-bound CLI bundle: it needs a terminal, so a bundle of the same cli/run.ts with a scripted yes answers it",
  "the hostile cases beyond one flipped blob and one second manifest of the same sequence (no hostile node, only the script's own authentic writes)",
  "what the operator saw in Obsidian: the first-pull confirmation is the operator's typed word bound to a nonce, a self-attestation that a program driving a pseudo-terminal could also type",
  "zeroization of secrets in memory",
  "an authenticated (auth-protected) kubo endpoint",
];

/** Phase name to implementation. The audit runs last (it compares the node with the snapshot taken before the run). */
const IMPLEMENTATIONS = {
  "harness-install": harnessInstallPhase,
  "obsidian-observed-steps": observedStepsPhase,
  "hostile-preparer": hostilePreparerPhase,
  "script-only-cli-phases": scriptOnlyCliPhase,
  "harness-node-audit": harnessAuditPhase,
};
const RUN_ORDER = ["harness-install", "obsidian-observed-steps", "hostile-preparer", "script-only-cli-phases", "harness-node-audit"];

/** The CLI scenarios of tasks 4.7a and 4.7b, in the order they run (mass removal last). Tests may select fewer through the run context. */
const ALL_SCENARIOS = Object.freeze(["tamper", "replay", "fork", "keys", "cost", "prune", "mass"]);

const hashFileOrUndefined = (path) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
};
const distHashes = (distDir) => Object.fromEntries(BUILD_OUTPUTS.map((output) => [output.path, hashFileOrUndefined(join(distDir, ...output.path.split("/").slice(1)))]));

async function sharedTarget(bundle, opts, env) {
  const target = await readTarget(bundle, env, opts.localStub);
  for (const url of [target.rpc, target.gateway]) if (!isAllowedUpstream(url, opts.localStub)) throw new Refusal(`upstream ${url} is not ${ALLOWED_HOSTS.join(" or ")}; this script only talks to the shared node's host (unset IPFS_SYNC_RPC_URL and IPFS_SYNC_GATEWAY_URL)`);
  return target;
}

async function recordPreRun(client, before, facts, opts, t) {
  const keyId = before.keys.get(KEY);
  let pointerUnknown = false;
  const previousPointer = keyId === undefined ? null : await resolvePreviousPointer(() => client.nameResolve(keyId), { strict: !opts.localStub, acceptUnresolved: opts.acceptUnresolvedPointer, onPointerUnknown: () => { pointerUnknown = true; } });
  facts.preRun = { keyId: keyId ?? null, previousPointer, ...(pointerUnknown ? { pointerUnknown } : {}) };
  t.out(formatPointerLine(keyId, previousPointer));
}

async function recordPostRun(client, facts, live, t) {
  live.postRunStarted = true;
  try {
    const keyId = (await client.keyList()).find((key) => key.name === KEY)?.id;
    const pointer = keyId === undefined ? null : await client.nameResolve(keyId).catch((error) => `unresolved (${firstLine(error instanceof Error ? error.message : String(error))})`);
    facts.postRun = { keyId: keyId ?? null, pointer };
  } catch (error) {
    facts.postRun = { keyId: null, pointer: `unreadable (${firstLine(error instanceof Error ? error.message : String(error))})` };
  }
  facts.restore = restoreInstruction(facts.preRun);
  t.out("\n-- IPNS pointer of the owned key, before and after --");
  t.out(formatPointerLine(facts.preRun.keyId ?? undefined, facts.preRun.previousPointer));
  t.out(formatPostRunLine(facts.postRun.keyId ?? undefined, facts.postRun.pointer));
  t.out(facts.restore);
}

async function runPhases(S, scope) {
  const results = new Map();
  for (const name of RUN_ORDER) {
    const phase = PHASE_PLAN.find((entry) => entry.phase === name);
    if (!phase.assertions.some((id) => scope.run.includes(id))) continue;
    try {
      for (const result of await IMPLEMENTATIONS[name](S)) results.set(result.id, result);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      for (const id of phase.assertions) results.set(id, { id, passed: false, detail: `phase ${name} crashed: ${firstLine(error instanceof Error ? error.message : String(error))}` });
    }
  }
  return results;
}

function assemble(scope, results) {
  const kinds = new Map(exportedAssertionList().map(({ id, kind }) => [id, kind]));
  return scope.run.map((id) => {
    const found = results.get(id) ?? { id, passed: false, detail: "no phase recorded this assertion" };
    return { id, kind: kinds.get(id), passed: found.passed === true, detail: String(found.detail ?? "") };
  });
}

async function runFeature(opts, context, work, bundle, facts, live, t, guardState) {
  const runId = newRunId();
  const demoRoot = demoRootFor(runId);
  const distDir = opts.distDir ?? join(REPO, "dist");
  const stub = opts.localStub ? await startStubChild(bundle, context.env) : undefined;
  live.stub = stub;
  const upstream = stub === undefined ? await sharedTarget(bundle, opts, context.env) : { rpc: stub.url, gateway: stub.url };
  const configFile = opts.localStub ? join(work, "stub-shared-config.json") : CONFIG_FILE;
  await ensureConfig(configFile);
  const client = makeReadClient({ bundle, env: context.env, rpc: upstream.rpc, gateway: upstream.gateway, mfsRoot: demoRoot, localStub: opts.localStub });
  live.client = client;
  const before = await nodeSnapshot(client);
  await recordPreRun(client, before, facts, opts, t);
  assertKeyAdoptable(before.keys, await readOwnedKeys(configFile), opts.ownedKey === undefined ? [] : [opts.ownedKey]);
  if (await client.filesStat(demoRoot).then(() => true, () => false)) throw new Refusal(`${demoRoot} already exists on the node`);
  const proxy = createProxy({ upstream, demoRoot });
  const apiUrl = await proxy.start();
  const scope = scopeFor(opts);
  t.out(`feature operation mvp-07b  ${opts.localStub ? "LOCAL STUB" : "shared node"}  upstream ${upstream.rpc}\ndemo root ${demoRoot}\nproxy ${apiUrl}  key ${KEY}  config ${configFile}\nphases ${opts.phases}${opts.verifyOnly ? "  verify-only" : ""}${opts.tamperExpect ? "  tamper-expect" : ""}  ${scope.run.length} assertions evaluated, ${scope.notRun.length} not run`);
  const operator = { terminal: context.terminal, nonce: context.nonce ?? randomNonce, windowMs: context.observedWindowMs ?? ANSWER_WINDOW_MS, readyWaitMs: context.observedReadyWaitMs ?? READY_WAIT_MS };
  const machine = { blobBytes: context.largeBlobBytes ?? LARGE_BLOB_BYTES, blobMinBytes: context.largeBlobMinBytes ?? LARGE_BLOB_MIN_BYTES, scenarios: context.scenarios ?? ALL_SCENARIOS, pruneRounds: context.pruneRounds ?? PRUNE_ROUNDS };
  const S = { opts, work, runId, demoRoot, mainRoot: `${demoRoot}/main`, client, proxy, stub, distDir, guardState, before, vaultsRoot: join(work, "vaults"), t, operator, apiUrl, configFile, bundle, env: context.env, machine };
  let tools;
  S.hostileTools = () => (tools ??= buildHostileTools(work));
  const distBefore = distHashes(distDir);
  let assertions = [];
  try {
    const selfTest = await runProxySelfTest(demoRoot);
    facts.proxySelfTest = selfTest;
    t.out(`proxy self-test (dead upstream ${selfTest.upstream}): ${selfTest.refused}/${selfTest.total} out-of-policy requests refused, ${selfTest.forwardedByPolicy} allowed to forward, control ${selfTest.controlStatus} (expected 502)`);
    const selfTestOk = selfTest.refused === selfTest.total && selfTest.forwardedByPolicy === 0 && selfTest.controlStatus === 502;
    // The run's main vault is created by `init`, which needs an empty MFS root, so it is made before any scenario puts a folder below the demo root.
    // An attended or verify-only run makes it in the observed phase, which runs first; a script-only run makes it here.
    if (opts.phases === "script-only" && !opts.verifyOnly && S.machine.scenarios.includes("mass")) await getSession(S, { withBlob: false }).catch(() => undefined);
    const results = await runPhases(S, scope);
    assertions = assemble(scope, results);
    if (JSON.stringify(distHashes(distDir)) !== JSON.stringify(distBefore)) assertions = assertions.map((entry) => (entry.id === "installed-files-hashed" ? { ...entry, passed: false, detail: `dist/ changed during the run; ${entry.detail}` } : entry));
    if (!selfTestOk) assertions = assertions.map((entry) => (entry.id === "only-demo-root-and-owned-key-changed" ? { ...entry, passed: false, detail: `the proxy self-test failed; ${entry.detail}` } : entry));
  } finally {
    await recordPostRun(client, facts, live, t);
    facts.proxyLog = { requests: proxy.log.length, mutating: proxy.log.filter((entry) => entry.allowed && entry.mutating).length, violations: proxy.violations.length };
    await proxy.stop();
    await stub?.stop();
  }
  return { runId, demoRoot, assertions, notRun: scope.notRun, installed: S.installed };
}

async function signalPostRun(live, facts, t) {
  if (live.postRunStarted === true) return;
  if (live.client === undefined || facts.preRun === undefined) {
    t.out("\nrun ended by a signal before the pre-run pointer was recorded; no request that changes the node had been sent, so there is nothing to restore.");
    return;
  }
  t.out("\nrun ended by a signal; recording the post-run pointer (best effort)...");
  const result = await bestEffortPostRun(() => recordPostRun(live.client, facts, live, t), { timeoutMs: SIGNAL_POST_RUN_TIMEOUT_MS });
  if (!result.ok) t.out(`post-run pointer NOT recorded (${result.reason}). The pre-run line printed earlier is the saved record: ${restoreInstruction(facts.preRun)}`);
}

export async function run(opts, context) {
  assertPlanMatchesChecker();
  let guardState;
  if (!opts.localStub) {
    const guard = guardBuildRefusal({ root: REPO, readState: context.readGuardBuild, computeTree: context.computeTree, hashFile: hashFileOrUndefined });
    if (!guard.ok) throw new Refusal(guard.reason);
    guardState = guard.state;
  }
  const mode = runMode(opts);
  // The Obsidian-observed prompts are in scope only for an attended run; a pipe or no terminal is refused before the lock, the work directory or any file.
  if (!opts.verifyOnly && opts.phases !== "script-only") assertOperatorTerminal(context.terminal);
  const dir = opts.outDir ?? featureOpsDirectory(context.env, context.platform);
  assertThrowawayPath(dir, "result directory");
  prepareOutputDirectory(dir);
  const t = createTranscript(context.write);
  const startedAt = new Date().toISOString();
  const release = await acquireLock(context.lockFile);
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop07b-"));
  assertThrowawayPath(work, "work directory");
  const facts = {};
  const live = {};
  const onSignal = Object.entries(SIGNAL_EXIT_CODES).map(([signal, code]) => {
    const handler = () => {
      const finish = () => {
        rmSync(work, { recursive: true, force: true });
        process.exit(code);
      };
      signalPostRun(live, facts, t).then(finish, finish);
    };
    process.once(signal, handler);
    return [signal, handler];
  });
  let outcome;
  try {
    await mkdir(join(work, "vaults"), { recursive: true });
    const bundle = await buildReader(work);
    outcome = await runFeature(opts, context, work, bundle, facts, live, t, guardState);
  } finally {
    await live.stub?.stop();
    for (const [signal, handler] of onSignal) process.off(signal, handler);
    if (!opts.keepWork) await rm(work, { recursive: true, force: true });
    await release();
  }
  for (const entry of outcome.assertions) t.out(`${entry.passed ? "PASS" : "FAIL"}  ${entry.id} (${entry.kind})  -- ${entry.detail}`);
  for (const entry of outcome.notRun) t.out(`NOT RUN  ${entry.id}  -- ${entry.reason}`);
  const failed = outcome.assertions.filter((entry) => !entry.passed);
  const passed = failed.length === 0 && outcome.assertions.length > 0;
  t.out(`\n${outcome.assertions.length - failed.length}/${outcome.assertions.length} assertions passed${failed.length === 0 ? "" : `; failed: ${failed.map((entry) => entry.id).join(", ")}`}${outcome.notRun.length === 0 ? "" : `; ${outcome.notRun.length} not run`}`);
  t.out(`\nUnverified even after a pass: ${UNVERIFIED.join("; ")}.`);
  const record = buildRecord({
    mode,
    phases: opts.phases,
    verifyOnly: opts.verifyOnly,
    tamperExpect: opts.tamperExpect,
    localStub: opts.localStub,
    trigger: opts.trigger,
    passed,
    runId: outcome.runId,
    demoRoot: outcome.demoRoot,
    startedAt,
    finishedAt: new Date().toISOString(),
    treeSha256: guardState?.treeSha256 ?? `none (${mode}: no build state was read)`,
    installed: outcome.installed ?? { cli: "absent", vaults: [] },
    ownedKey: { name: KEY, keyId: facts.preRun?.keyId ?? null, before: facts.preRun?.previousPointer ?? null, after: facts.postRun?.pointer ?? null },
    restore: facts.restore,
    assertions: outcome.assertions,
    notRun: outcome.notRun,
    evidencePaths: opts.evidence,
    proxy: facts.proxyLog,
    unverified: UNVERIFIED,
    transcript: t.text(),
  });
  const written = writeOperatorFiles({ dir, names: recordNamesFor(mode), record, transcript: t.text() });
  t.out(`result written to ${written.recordPath} (transcript ${written.transcriptPath})`);
  return passed ? EXIT_OK : EXIT_FAILED;
}

export function dryRun(opts, context) {
  const t = createTranscript(context.write);
  t.out("feature operation mvp-07b: DRY RUN (no request is sent, no socket is opened)\n");
  t.out(`mode ${runMode(opts)}  phases ${opts.phases}  demo root pattern ${DEMO_PARENT}/<runid>  owned key ${KEY}`);
  t.out(`result directory ${opts.outDir ?? featureOpsDirectory(context.env, context.platform)} (valid for ${OPERATOR_RECORD_MAX_AGE_MS / 86_400_000} days once item B reads it)`);
  const scope = scopeFor(opts);
  for (const phase of PHASE_PLAN) t.out(`phase ${phase.phase} (task ${phase.task}, ${phase.group}): ${phase.assertions.join(", ")}${scope.notRun.some((entry) => phase.assertions.includes(entry.id)) ? "  [not run with --phases script-only]" : ""}`);
  const demoRoot = demoRootFor(newRunId());
  const decide = (command, init) => decideRequest({ method: "POST", pathname: `/api/v0/${command}`, params: new URLSearchParams(init) }, { demoRoot, knownCids: new Set() });
  const checks = [
    ["the phase plan equals the checker's REQUIRED_ASSERTIONS", exportedAssertionList().length === 18],
    ["the policy refuses key/rm, pin/rm, a foreign key, the staging root and the mvp07a-demo folder", [decide("key/rm", { arg: KEY }), decide("pin/rm", { arg: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }), decide("key/gen", { arg: "obsidian-vault" }), decide("files/write", { arg: `${STAGING_ROOT}/x` }), decide("files/write", { arg: "/obsidian-vault-sync/mvp07a-demo/x/y" })].every((verdict) => !verdict.allowed)],
    ["the policy allows a write below this run's demo root", decide("files/write", { arg: `${demoRoot}/a` }).allowed],
    ["a run identifier outside the pattern is refused", (() => { try { demoRootFor("../x"); return false; } catch { return true; } })()],
    ["the two throwaway vaults are named", VAULT_NAMES.length === 2],
  ];
  for (const [label, ok] of checks) t.out(`${ok ? "PASS" : "FAIL"}  dry run: ${label}`);
  return checks.every(([, ok]) => ok) ? EXIT_OK : EXIT_FAILED;
}

const defaultContext = () => ({
  env: process.env,
  platform: process.platform,
  write: (text) => process.stdout.write(text),
  terminal: { input: process.stdin, output: process.stdout },
  writeError: (text) => process.stderr.write(text),
  lockFile: LOCK_FILE,
  readGuardBuild: readGuardBuildState,
  computeTree: computeTreeHash,
});

export async function main(argv, overrides = {}) {
  const context = { ...defaultContext(), ...overrides };
  let opts;
  try {
    opts = parseArguments(argv);
  } catch (error) {
    context.writeError(`${error.message}\n${USAGE}\n`);
    return EXIT_REFUSED;
  }
  if (opts.help) {
    context.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  try {
    const unsupported = win32Refusal(context.platform);
    if (unsupported !== undefined) throw new Refusal(unsupported);
    return opts.dryRun ? dryRun(opts, context) : await run(opts, context);
  } catch (error) {
    if (error instanceof Refusal) {
      context.writeError(`refused: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    context.writeError(`feature operation crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return EXIT_FAILED;
  }
}
