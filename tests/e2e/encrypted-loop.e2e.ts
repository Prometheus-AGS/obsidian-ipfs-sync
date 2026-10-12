// The encrypted sync loop against the live node (change mvp-09-e2e-sync-fixture, tasks 2.1+). One ordered spec
// file: beforeAll owns the run lifecycle (lock, preflights, probe, key adoption, snapshot, proxy, devices),
// the scenarios are sequential `it` blocks, S5 owns the cleanup as an ordered step, and afterAll is the
// failure-path safety net that removes the run root whether scenarios passed, failed or never ran (design
// decision 6). Every scenario step is a spawned
// child of the built CLI through the loopback proxy; the only node contact outside the proxy is the read-only
// probe/snapshot and the key adoption, against the operator-supplied upstream.
import { createHash, randomBytes } from "node:crypto";
import { rmSync, type Dirent } from "node:fs";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeCliRunner, makeDevice, type CliResult, type CliRunner, type DeviceSpec } from "./harness/cli-runner";
import { loadHostile07 } from "./harness/hostile";
import { createNodeClient, nodeTargetFromEnv, type NodeClient, type NodeTarget } from "./harness/node-client";
import { adoptSuiteKey, assertOfflinePreflights, probeNode } from "./harness/preflight";
import { assertProxySelfCheck, createProxy, type Proxy } from "./harness/proxy";
import { acquireRunLock, BASE_PATH, createRunContext, removeRunDir, SuiteRefusal, type RunContext } from "./harness/run-context";
import { loadTools07a, type Needle, type Tools07a, type WalkedFile } from "./harness/tools-07a";

/** The generated passphrase's 5x5 shape (cli/passphrase-show.ts passphraseFileContent). */
const PASSPHRASE_SHAPE = /^[A-Z2-7]{5}(?:-[A-Z2-7]{5}){4}\n$/;
/** The fixture publishes every generated file except these (the default exclusions the fixture exercises). */
const FIXTURE_EXCLUDED = (path: string): boolean => path === ".ipfs-sync-fixture" || path.startsWith(".trash/") || path.startsWith(".obsidian/");
/** The 07a floor for a real publish (tools/feature-op-mvp-07a/constants.mjs MIN_PUBLISHED_FILES). */
const MIN_PUBLISHED_FILES = 10;
/** Cleanup of the run root: files/rm -r with bounded retries, files/stat before and after (design decision 6). */
const CLEANUP_ATTEMPTS = 3;
const CLEANUP_DELAY_MS = 2_000;
/** Bound on the signal handlers' best-effort cleanup (the 07a SIGNAL_POST_RUN_TIMEOUT_MS precedent). */
const SIGNAL_CLEANUP_TIMEOUT_MS = 5_000;
const SIGNAL_EXIT_CODES: readonly (readonly [NodeJS.Signals, number])[] = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
];

/** Evidence lines: process.stdout directly (vitest prints it), never console.log (the constraint grep covers tests/). */
const announce = (line: string): void => {
  process.stdout.write(`[e2e] ${line}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A value that must exist for the scenario to continue; a missing one fails with the label named. */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`the scenario cannot continue: ${label} is missing`);
  return value;
}

/** `YYYY-MM-DD` in the machine's local calendar — mirrors src/sync/conflict-name.ts localDateStamp (the suite imports no src/). */
const localStamp = (epochMs: number): string => {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** `<stem> (ipfs conflict DATE).<ext>` next to the original — the attempt-1 shape pinned at src/sync/conflict-name.ts:32. */
const conflictCopyName = (path: string, stamp: string): string => {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${path.slice(0, slash + 1)}${stem} (ipfs conflict ${stamp})${extension}`;
};

/** files/stat where any error reads as "absent" (the 07a convention for absence checks). */
async function statOrAbsent(client: NodeClient, path: string): Promise<{ cid: string } | undefined> {
  return client.filesStat(path).then(
    (found) => ({ cid: found.cid }),
    () => undefined,
  );
}

/*
 * S3's wrong passphrase: a FRESH generated-shaped passphrase (23 random body symbols plus the 2 check symbols),
 * not a mutation of the vault's. The check is recomputed here with node:crypto, mirroring src/crypto/passphrase.ts
 * (computePassphraseCheck at :85, generatePassphrase at :100) — the suite imports no src/. Without a valid check the
 * pull would stop with "passphrase-format" before any derivation; this scenario pins the "wrong passphrase" stop, so
 * a drift of the label or the algorithm fails the error-line assertion below instead of passing for the wrong reason.
 */
const PASS_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PASS_CHECK_LABEL = "ipfs-sync/passphrase/check/v1";

const generateWrongPassphraseFileText = (): string => {
  const body = Array.from(randomBytes(23), (byte) => PASS_ALPHABET[byte & 31]).join("");
  const digest = createHash("sha256").update(PASS_CHECK_LABEL, "utf8").update(body, "ascii").digest();
  const first = digest[0] ?? 0;
  const second = digest[1] ?? 0;
  const symbols = `${body}${PASS_ALPHABET[first >> 3]}${PASS_ALPHABET[((first & 0x07) << 2) | (second >> 6)]}`;
  return `${(symbols.match(/.{5}/g) ?? []).join("-")}\n`;
};

/** The 25-symbol canonical form of a passphrase file's text, for the difference assertion (never printed). */
const canonicalOf = (fileText: string): string => fileText.replace(/[^A-Za-z2-7]/g, "").toUpperCase();

/** Every regular file under dir (relative paths, sorted), following nothing; an absent directory reads as empty. */
async function listAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [] as Dirent[]);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * The run-root cleanup (design decision 6), always through the proxy so the allowlist confines it to exactly the
 * run root: stat, then files/rm -r with bounded retries, stat to confirm. Idempotent: an already-removed root is
 * reported "absent" and skipped. A root still present after the retries throws, naming the root and the operator
 * removal command.
 */
export async function cleanupRunRoot(client: NodeClient, runRoot: string): Promise<"absent" | "removed"> {
  if ((await statOrAbsent(client, runRoot)) === undefined) return "absent";
  let lastError = "files/rm was not reached";
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    await client.filesRm(runRoot, true).catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
    });
    if ((await statOrAbsent(client, runRoot)) === undefined) return "removed";
    if (attempt < CLEANUP_ATTEMPTS) await sleep(CLEANUP_DELAY_MS);
  }
  throw new Error(`cleanup of ${runRoot} failed: still present after ${CLEANUP_ATTEMPTS} files/rm -r attempts (last error: ${lastError}); remove it by hand with files/rm -r ${runRoot}`);
}

interface SuiteState {
  readonly tools: Tools07a;
  readonly context: RunContext;
  readonly target: NodeTarget;
  /** The upstream client: probe, snapshot, name/resolve (read-only) and the one-time key adoption. */
  readonly node: NodeClient;
  readonly proxy: Proxy;
  /** The client through the loopback proxy: the confined cleanup goes here, never upstream-direct. */
  readonly proxyClient: NodeClient;
  readonly keyId: string;
  readonly deviceA: DeviceSpec;
  readonly deviceB: DeviceSpec;
  readonly cliA: CliRunner;
  readonly cliB: CliRunner;
  /** Passphrase spellings, filled after init; the runners redact them from every child's output. */
  readonly secrets: string[];
  /** Content needles (titles and body words) scanned out of child output; the wire scan carries the full set. */
  readonly contentNeedles: Needle[];
  /** Every spawned child's scrubbed result, for the final no-plaintext assertion. */
  readonly childResults: { label: string; result: CliResult }[];
  /** What the later scenarios inherit from S1: the vault id, the sequence-1 root and the published path list. */
  readonly shared: { vaultId?: string; rootCid?: string; expectedPaths?: string[] };
}

/** What the signal handlers and the safety net can reach, filled in beforeAll order. */
interface LiveRun {
  readonly context: RunContext;
  proxy?: Proxy;
  proxyClient?: NodeClient;
  cleaned: boolean;
}

let suite: SuiteState | undefined;
let live: LiveRun | undefined;
const installedHandlers: (readonly [NodeJS.Signals, () => void])[] = [];

function installSignalHandlers(tools: Tools07a): void {
  for (const [signal, code] of SIGNAL_EXIT_CODES) {
    const handler = (): void => {
      const finish = (): void => {
        if (live !== undefined) rmSync(live.context.tempDir, { recursive: true, force: true });
        process.exit(code);
      };
      const current = live;
      const client = current?.proxyClient;
      if (current === undefined || client === undefined || current.cleaned) {
        finish();
        return;
      }
      announce(`signal ${signal}: bounded best-effort cleanup of ${current.context.runRoot} before exit`);
      void tools
        .bestEffortPostRun(async () => {
          const outcome = await cleanupRunRoot(client, current.context.runRoot);
          announce(`signal ${signal}: cleanup of ${current.context.runRoot}: ${outcome}`);
        }, { timeoutMs: SIGNAL_CLEANUP_TIMEOUT_MS })
        .then((result) => {
          if (!result.ok) announce(`signal ${signal}: cleanup NOT completed (${result.reason ?? "unknown"}); remove by hand: files/rm -r ${current.context.runRoot}`);
        })
        .then(finish, finish);
    };
    process.once(signal, handler);
    installedHandlers.push([signal, handler]);
  }
}

describe("encrypted loop against the live node", () => {
  beforeAll(async () => {
    const tools = await loadTools07a();
    const context = await createRunContext();
    live = { context, cleaned: false };
    installSignalHandlers(tools);
    announce(`run ${context.runId}: root ${context.runRoot}, temp ${context.tempDir}`);
    await acquireRunLock();
    await assertOfflinePreflights(tools.repoRoot);
    const target = nodeTargetFromEnv(process.env);
    announce(`upstream ${target.rpc} (from the operator environment)`);
    const node = createNodeClient(target, process.env);
    const probe = await probeNode(node, target.rpc);
    const version = probe.version as { version?: unknown };
    announce(`node version ${typeof version.version === "string" ? version.version : "unknown"}; ${probe.keys.length} keys on the node`);
    const adoption = await adoptSuiteKey(node, context.ownedKeysConfigFile);
    announce(`suite key ${adoption.created ? "created" : "adopted"}: ${adoption.keyId}`);
    // The pre-run snapshot (read-only, upstream-direct): the base listing and the key list.
    const baseEntries = await node.filesLs(BASE_PATH).then(
      (entries) => entries,
      () => [] as { name?: string }[],
    );
    announce(`snapshot: ${BASE_PATH} holds [${baseEntries.map((entry) => entry.name ?? "?").join(", ")}]; keys [${probe.keys.map((key) => key.name).join(", ")}]`);
    const proxy = await createProxy({ upstream: target, runRoot: context.runRoot });
    const proxyUrl = await proxy.start();
    live.proxy = proxy;
    announce(`proxy ${proxyUrl} with the confined policy for ${context.runRoot}`);
    await assertProxySelfCheck(context.runRoot);
    announce("proxy self-test against the dead upstream: all out-of-policy requests refused, none forwarded");
    const proxyClient = createNodeClient({ rpc: proxyUrl, gateway: proxyUrl }, process.env);
    // The run root must not exist: a fresh runId never collides, so a present root is a refusal, not a cleanup.
    const existing = await statOrAbsent(node, context.runRoot);
    if (existing !== undefined) {
      throw new SuiteRefusal(`run root ${context.runRoot} already exists on the node (CID ${existing.cid}); a run identifier collision is not cleaned up automatically. Inspect it, and remove it by hand with files/rm -r ${context.runRoot}`);
    }
    live.proxyClient = proxyClient;
    const deviceA = await makeDevice(context, "e2e-a");
    const deviceB = await makeDevice(context, "e2e-b");
    for (const device of [deviceA, deviceB]) await writeFile(device.configFile, "{}\n");
    const secrets: string[] = [];
    const contentNeedles: Needle[] = [];
    const childResults: { label: string; result: CliResult }[] = [];
    const runnerOptions = { context, proxyUrl, ownedKeyIds: [adoption.keyId], secrets: () => secrets, needles: () => contentNeedles };
    suite = {
      tools,
      context,
      target,
      node,
      proxy,
      proxyClient,
      keyId: adoption.keyId,
      deviceA,
      deviceB,
      cliA: await makeCliRunner({ ...runnerOptions, device: deviceA }),
      cliB: await makeCliRunner({ ...runnerOptions, device: deviceB }),
      secrets,
      contentNeedles,
      childResults,
      shared: {},
    };
    announce(`devices e2e-a and e2e-b: own vault, config and state directories under the per-run temp dir`);
  });

  afterAll(async () => {
    for (const [signal, handler] of installedHandlers.splice(0)) process.off(signal, handler);
    let failure: unknown;
    const current = live;
    if (current !== undefined && current.proxyClient !== undefined && !current.cleaned) {
      try {
        const outcome = await cleanupRunRoot(current.proxyClient, current.context.runRoot);
        current.cleaned = true;
        announce(`afterAll safety net: ${outcome === "absent" ? `${current.context.runRoot} already absent — nothing to do` : `removed ${current.context.runRoot} from the node (files/rm -r, confirmed by files/stat)`}`);
      } catch (error) {
        failure = error;
      }
    }
    if (current?.proxy !== undefined) await current.proxy.stop().catch(() => undefined);
    if (current !== undefined) await removeRunDir(current.context);
    if (failure !== undefined) throw failure;
  });

  it("S1: A publishes the fixture vault, the name resolves to the published root, empty B pulls it byte-for-byte", async () => {
    const S = must(suite, "the suite state (beforeAll failed)");
    const { tools, context } = S;

    // ---- A: fixture vault, init, publish ----------------------------------------------------------------------------
    const generated = await tools.generateVault(S.deviceA.vaultDir);
    expect(generated.code === 0, `fixture generator exit ${String(generated.code)}: ${tools.firstLine(generated.text)}`).toBe(true);
    expect((await stat(join(S.deviceA.vaultDir, ".ipfs-sync-fixture")).catch(() => undefined)) !== undefined, "the fixture marker").toBe(true);
    const filesA: WalkedFile[] = await tools.walkFiles(S.deviceA.vaultDir);
    const expectedPaths = filesA.filter((file) => !FIXTURE_EXCLUDED(file.path)).map((file) => file.path);
    expect(expectedPaths.length, `the generated vault holds ${expectedPaths.length} publishable files`).toBeGreaterThanOrEqual(MIN_PUBLISHED_FILES);
    const plaintextNeedles = tools.plaintextNeedles(filesA);
    // Child output legitimately echoes vault-relative paths (the publish event log), so children are scanned for
    // content needles and the passphrase; the wire scan carries the full set, paths included.
    S.contentNeedles.push(...plaintextNeedles.filter((needle) => needle.label.startsWith("title ") || needle.label.startsWith("body word ")));
    S.proxy.setNeedles(plaintextNeedles);
    announce(`S1: fixture vault generated (${filesA.length} files, ${expectedPaths.length} publishable); ${plaintextNeedles.length} plaintext needles armed`);

    const init = await S.cliA("init", [S.deviceA.vaultDir], { extra: ["--passphrase-file", context.passphraseFile] });
    S.childResults.push({ label: "init", result: init });
    expect(init.code === 0, `init exit ${String(init.code)}: ${tools.firstLine(init.stderr)}`).toBe(true);
    const passText = await readFile(context.passphraseFile, "utf8");
    const passInfo = await stat(context.passphraseFile);
    expect(PASSPHRASE_SHAPE.test(passText), "the passphrase file has the generated 5x5 shape").toBe(true);
    expect((passInfo.mode & 0o077) === 0, "the passphrase file is 0600").toBe(true);
    S.secrets.push(...tools.withPassphraseSpellings([], passText));
    // init's own output went through the scrubber before the passphrase was known; re-scan it now (07a pattern).
    expect(S.secrets.some((secret) => `${init.stdout}\n${init.stderr}`.includes(secret)), "init printed no passphrase spelling").toBe(false);
    S.proxy.setNeedles([...plaintextNeedles, ...S.secrets.map((text, index) => ({ label: `passphrase (${index === 0 ? "grouped" : "canonical"})`, bytes: Buffer.from(text, "utf8") }))]);
    const vaultId = must(tools.parseInitOutput(init.stdout).vaultId, "the vault id in init's output");
    expect(vaultId, "init printed the vault id").toMatch(/^[0-9a-f]{32}$/);
    S.shared.vaultId = vaultId;
    S.shared.expectedPaths = expectedPaths;
    announce(`S1: init created the vault (id ${vaultId}); passphrase file written 0600 and never printed`);

    const publish = await S.cliA("publish", [S.deviceA.vaultDir], { passphraseFile: context.passphraseFile });
    S.childResults.push({ label: "publish", result: publish });
    expect(publish.code === 0, `publish exit ${String(publish.code)}: ${tools.firstLine(publish.stderr)}`).toBe(true);
    const published = tools.parsePublishOutput(publish.stdout);
    expect(published.sequence, "publish reports sequence 1").toBe(1);
    expect(published.removed, "nothing removed").toBe(0);
    expect(published.written, `every one of the ${expectedPaths.length} published fixture files was written`).toBe(expectedPaths.length);
    const rootCid = must(published.rootCid, "the root CID in publish's output");
    S.shared.rootCid = rootCid;
    announce(`S1: publish #1 — ${String(published.written)} written, sequence 1, root ${rootCid}`);

    // ---- name/resolve returns the published root ----------------------------------------------------------------------
    const resolved = await S.node.nameResolve(S.keyId);
    expect(resolved, "name/resolve of the suite key returns the published root").toBe(`/ipfs/${rootCid}`);
    announce(`S1: name/resolve obsidian-vault-e2e -> ${resolved}`);

    // ---- B (empty) pulls ----------------------------------------------------------------------------------------------
    expect((await tools.walkFiles(S.deviceB.vaultDir)).length, "B starts empty").toBe(0);
    const mark = S.proxy.mark();
    const pull = await S.cliB("pull", [S.deviceB.vaultDir], {
      passphraseFile: context.passphraseFile,
      extra: ["--accept-first-pull", "--expect-vault-id", vaultId, "--expect-min-sequence", "1"],
    });
    S.childResults.push({ label: "pull", result: pull });
    const trace = S.proxy.since(mark);
    expect(pull.code === 0, `pull exit ${String(pull.code)}: ${tools.firstLine(pull.stderr)}`).toBe(true);
    const pulled = tools.parsePullOutput(pull.stdout);
    expect(pulled.sequence, "the pull reports sequence 1").toBe(1);
    expect(pulled.rootCid, "the pulled root equals A's published root").toBe(rootCid);
    expect(
      [pulled.fetched, pulled.unchanged, pulled.conflicts, pulled.integrityFailed, pulled.unfetched],
      `every published file fetched: ${String(pulled.fetched)} fetched, ${String(pulled.unchanged)} unchanged, ${String(pulled.conflicts)} conflicts, ${String(pulled.integrityFailed)} integrity-failed, ${String(pulled.unfetched)} unfetched`,
    ).toEqual([expectedPaths.length, 0, 0, 0, 0]);
    const traceProblems = tools.pullTraceProblems(trace);
    expect(trace.length, "the pull went through the proxy").toBeGreaterThan(0);
    expect(traceProblems, `the proxy log of the pull holds reads only (${trace.length} requests): ${traceProblems.join("; ")}`).toEqual([]);
    announce(`S1: pull — ${String(pulled.fetched)} fetched, sequence 1, root matches; proxy slice ${trace.length} read-only requests`);

    // ---- byte-for-byte against A ----------------------------------------------------------------------------------------
    const filesB = await tools.walkFiles(S.deviceB.vaultDir);
    expect(filesB.map((file) => file.path), "B holds exactly the published paths, no fixture marker, nothing else").toEqual(expectedPaths);
    const byPathA = new Map(filesA.map((file) => [file.path, file.sha256]));
    const mismatches = expectedPaths.filter((path) => filesB.find((file) => file.path === path)?.sha256 !== byPathA.get(path));
    expect(mismatches, `every file's sha256 in B equals A's (${mismatches.length} mismatches)`).toEqual([]);

    // ---- no plaintext and no passphrase spelling anywhere ----------------------------------------------------------------
    const leaks = S.childResults.filter((entry) => entry.result.leaked).map((entry) => `${entry.label}${entry.result.needle === undefined ? "" : ` (${entry.result.needle})`}`);
    expect(leaks, `no child output holds a passphrase spelling or fixture plaintext: ${leaks.join(", ")}`).toEqual([]);
    const wireHits = S.proxy.log.filter((entry) => entry.needle !== undefined).map((entry) => `${entry.command} ${entry.arg ?? ""}: ${entry.needle ?? ""}`);
    expect(wireHits, `no request URL or body holds fixture plaintext or a passphrase spelling: ${wireHits.join("; ")}`).toEqual([]);
    const refused = S.proxy.violations.map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refused, `the proxy refused nothing a correct CLI sends: ${refused.join("; ")}`).toEqual([]);
    announce("S1: needle scan clean across child output, request URLs and request bodies");
  });

  it("S2: B's unpublished edit survives A's publish as a dated conflict copy, and a fresh history child lists the pull and the conflict", async () => {
    const S = must(suite, "the suite state (beforeAll failed)");
    const { tools, context } = S;
    const vaultId = must(S.shared.vaultId, "S1's vault id");
    const firstRoot = must(S.shared.rootCid, "S1's published root CID");
    const expectedPaths = must(S.shared.expectedPaths, "S1's published path list");
    const note = must(
      expectedPaths.find((path) => path.endsWith(".md")),
      "a publishable markdown note",
    );
    const noteA = join(S.deviceA.vaultDir, ...note.split("/"));
    const noteB = join(S.deviceB.vaultDir, ...note.split("/"));

    // ---- B edits the shared note locally; no publish ----------------------------------------------------------------
    const bEdited = Buffer.concat([await readFile(noteB), Buffer.from(`b local edit ${context.runId}\n`, "utf8")]);
    await writeFile(noteB, bEdited);
    const bSha = tools.sha256(bEdited);
    // The mtime/content audit baseline: every file but the edited note must survive B's pull untouched.
    const untouched = expectedPaths.filter((path) => path !== note);
    const untouchedBefore = new Map<string, { mtimeMs: number; sha256: string }>();
    for (const path of untouched) {
      const file = join(S.deviceB.vaultDir, ...path.split("/"));
      untouchedBefore.set(path, { mtimeMs: (await stat(file)).mtimeMs, sha256: tools.sha256(await readFile(file)) });
    }
    announce(`S2: B edited ${note} locally (no publish); ${untouched.length} untouched files snapshotted for the mtime/content audit`);

    // ---- A edits the same note and publishes (sequence 2) ------------------------------------------------------------
    const aEdited = Buffer.concat([await readFile(noteA), Buffer.from(`a remote edit ${context.runId}\n`, "utf8")]);
    await writeFile(noteA, aEdited);
    const aSha = tools.sha256(aEdited);
    const publish2 = await S.cliA("publish", [S.deviceA.vaultDir], { passphraseFile: context.passphraseFile });
    S.childResults.push({ label: "publish #2", result: publish2 });
    expect(publish2.code === 0, `publish #2 exit ${String(publish2.code)}: ${tools.firstLine(publish2.stderr)}`).toBe(true);
    const published2 = tools.parsePublishOutput(publish2.stdout);
    expect(published2.sequence, "publish #2 reports sequence 2").toBe(2);
    expect([published2.written, published2.removed], "only the one edited note was written; nothing removed").toEqual([1, 0]);
    const secondRoot = must(published2.rootCid, "the root CID in publish #2's output");
    expect(secondRoot === firstRoot, "the sequence-2 root differs from sequence 1's").toBe(false);
    announce(`S2: publish #2 — ${String(published2.written)} written, sequence 2, root ${secondRoot}`);

    // ---- name/resolve returns the new root ----------------------------------------------------------------------------
    const resolved2 = await S.node.nameResolve(S.keyId);
    expect(resolved2, "name/resolve of the suite key returns the sequence-2 root").toBe(`/ipfs/${secondRoot}`);
    announce(`S2: name/resolve obsidian-vault-e2e -> ${resolved2}`);

    // ---- B pulls: the remote text takes the path; the local edit survives as a dated conflict copy ----------------------
    const stampBefore = localStamp(Date.now());
    const pull2 = await S.cliB("pull", [S.deviceB.vaultDir], {
      passphraseFile: context.passphraseFile,
      extra: ["--expect-vault-id", vaultId, "--expect-min-sequence", "2"],
    });
    const stampAfter = localStamp(Date.now());
    S.childResults.push({ label: "pull #2", result: pull2 });
    expect(pull2.code === 0, `pull #2 exit ${String(pull2.code)}: ${tools.firstLine(pull2.stderr)}`).toBe(true);
    const pulled2 = tools.parsePullOutput(pull2.stdout);
    expect(pulled2.sequence, "pull #2 reports sequence 2").toBe(2);
    expect(pulled2.rootCid, "pull #2 settled on the sequence-2 root").toBe(secondRoot);
    expect(
      [pulled2.fetched, pulled2.unchanged, pulled2.conflicts, pulled2.integrityFailed, pulled2.unfetched, pulled2.skipped, pulled2.remoteDeleted, pulled2.locallyModified],
      `pull #2 counts: ${String(pulled2.fetched)} fetched, ${String(pulled2.unchanged)} unchanged, ${String(pulled2.conflicts)} conflicts, ${String(pulled2.integrityFailed)} integrity-failed, ${String(pulled2.unfetched)} unfetched, ${String(pulled2.skipped)} skipped, ${String(pulled2.remoteDeleted)} remote-deleted, ${String(pulled2.locallyModified)} locally modified`,
    ).toEqual([1, expectedPaths.length - 1, 1, 0, 0, 0, 0, 0]);
    expect(pulled2.conflictPairs.length, "exactly one conflict pair").toBe(1);
    const pair = must(pulled2.conflictPairs[0], "the conflict pair in pull #2's output");
    expect(pair.path, "the conflicted path is the shared note").toBe(note);
    // The copy name is the attempt-1 shape pinned at src/sync/conflict-name.ts:32, dated the pull day. The stamp is taken on
    // both sides of the pull so a midnight boundary between them cannot flake the check.
    const expectedCopies = [...new Set([stampBefore, stampAfter])].map((stamp) => conflictCopyName(note, stamp));
    expect(expectedCopies.includes(pair.copy), `the conflict copy is named <stem> (ipfs conflict YYYY-MM-DD).md, got "${pair.copy}"`).toBe(true);
    announce(`S2: pull #2 — 1 fetched, ${expectedPaths.length - 1} unchanged, 1 conflict: ${pair.path} -> ${pair.copy}`);

    // ---- on disk: remote content at the path, the local edit in the copy, nothing deleted, nothing else rewritten ---------
    expect((await readFile(noteB)).equals(aEdited), "the note now holds A's remote content byte-for-byte").toBe(true);
    expect((await readFile(join(S.deviceB.vaultDir, ...pair.copy.split("/")))).equals(bEdited), "the conflict copy holds B's local edit byte-for-byte").toBe(true);
    const filesB2 = await tools.walkFiles(S.deviceB.vaultDir);
    expect(filesB2.map((file) => file.path), "B holds every published path plus the conflict copy; no local file was deleted").toEqual([...expectedPaths, pair.copy].sort());
    const rewritten: string[] = [];
    for (const path of untouched) {
      const before = must(untouchedBefore.get(path), `the pre-pull snapshot of ${path}`);
      const found = filesB2.find((file) => file.path === path);
      const afterMtime = (await stat(join(S.deviceB.vaultDir, ...path.split("/")))).mtimeMs;
      if (found === undefined || found.sha256 !== before.sha256 || afterMtime !== before.mtimeMs) rewritten.push(path);
    }
    expect(rewritten, `untouched files were not rewritten (mtime and content audit): ${rewritten.join(", ")}`).toEqual([]);
    announce(`S2: mtime/content audit clean across the ${untouched.length} untouched files`);

    // ---- the single history assertion: a fresh child lists the pull and the conflict from the on-disk database ------------
    // The publish and pull children have exited (awaited above); this child opens B's state-directory database read-only.
    const historyMark = S.proxy.mark();
    const history = await S.cliB("history");
    S.childResults.push({ label: "history", result: history });
    expect(history.code === 0, `history exit ${String(history.code)}: ${tools.firstLine(history.stderr)}`).toBe(true);
    expect(S.proxy.since(historyMark).length, "history read the on-disk database only: it sent no node request").toBe(0);
    const historyLines = history.stdout.trim().split("\n");
    const head = (kind: "pull" | "conflict"): string => `  ${kind.padEnd("conflict".length)}  ${secondRoot}  `;
    const pullRecord = historyLines.find((line) => line.includes(head("pull")));
    expect(pullRecord, "history lists the sequence-2 pull").toBeDefined();
    expect(pullRecord ?? "", "the pull record carries conflicted >= 1").toContain(`fetched 1, unchanged ${expectedPaths.length - 1}, conflicted 1, failed 0, removed remotely 0, kept locally 0`);
    const conflictRecord = historyLines.find((line) => line.includes(head("conflict")));
    expect(conflictRecord, "history lists the conflict record").toBeDefined();
    expect(conflictRecord ?? "", "the conflict record carries the preserved local sha256 and the remote sha256").toContain(`local sha256 ${bSha}, remote sha256 ${aSha}`);
    announce("S2: history (fresh child against B's state directory, after the publish/pull children exited):");
    announce(`S2:   ${(pullRecord ?? "").trim()}`);
    announce(`S2:   ${(conflictRecord ?? "").trim()}`);

    // ---- the suite invariant re-checked over everything S2 added ------------------------------------------------------
    const leaks = S.childResults.filter((entry) => entry.result.leaked).map((entry) => `${entry.label}${entry.result.needle === undefined ? "" : ` (${entry.result.needle})`}`);
    expect(leaks, `no child output holds a passphrase spelling or fixture plaintext: ${leaks.join(", ")}`).toEqual([]);
    const wireHits = S.proxy.log.filter((entry) => entry.needle !== undefined).map((entry) => `${entry.command} ${entry.arg ?? ""}: ${entry.needle ?? ""}`);
    expect(wireHits, `no request URL or body holds fixture plaintext or a passphrase spelling: ${wireHits.join("; ")}`).toEqual([]);
    const refused = S.proxy.violations.map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refused, `the proxy refused nothing a correct CLI sends: ${refused.join("; ")}`).toEqual([]);
    announce("S2: needle scan still clean across all child output, request URLs and request bodies");
  });

  it("S3: a fresh device C pulling with a wrong passphrase fails closed — nothing pulled, no state, no floor, no mutation", async () => {
    const S = must(suite, "the suite state (beforeAll failed)");
    const { tools, context } = S;
    const vaultId = must(S.shared.vaultId, "S1's vault id");

    // ---- device C: own vault, config and state directories, and its own generated passphrase --------------------------
    const deviceC = await makeDevice(context, "e2e-c");
    await writeFile(deviceC.configFile, "{}\n");
    const cliC = await makeCliRunner({
      context,
      device: deviceC,
      proxyUrl: must(S.proxy.url, "the proxy URL"),
      ownedKeyIds: [S.keyId],
      secrets: () => S.secrets,
      needles: () => S.contentNeedles,
    });
    expect((await tools.walkFiles(deviceC.vaultDir)).length, "C starts empty").toBe(0);

    const wrongPassphraseFile = join(context.secretsDir, "passphrase-c.txt");
    const wrongText = generateWrongPassphraseFileText();
    await writeFile(wrongPassphraseFile, wrongText, { mode: 0o600 });
    await chmod(wrongPassphraseFile, 0o600);
    expect(PASSPHRASE_SHAPE.test(wrongText), "C's passphrase has the generated 5x5 shape").toBe(true);
    expect((await stat(wrongPassphraseFile)).mode & 0o077, "C's passphrase file is 0600").toBe(0);
    expect(canonicalOf(wrongText) === canonicalOf(await readFile(context.passphraseFile, "utf8")), "C's passphrase is not the vault's").toBe(false);
    // Both spellings of BOTH passphrases are scrubbed from here on: A's were armed in S1, C's join before its child spawns.
    S.secrets.push(...tools.withPassphraseSpellings([], wrongText));
    announce("S3: device e2e-c created with a fresh generated passphrase (valid check symbols, not the vault's); both spellings of both passphrases armed for scrubbing");

    // ---- C pulls the published root with the wrong passphrase ---------------------------------------------------------
    const markC = S.proxy.mark();
    const pullC = await cliC("pull", [deviceC.vaultDir], {
      passphraseFile: wrongPassphraseFile,
      extra: ["--accept-first-pull", "--expect-vault-id", vaultId, "--expect-min-sequence", "1"],
    });
    S.childResults.push({ label: "pull C (wrong passphrase)", result: pullC });
    const traceC = S.proxy.since(markC);
    expect(pullC.code, `C's pull must fail closed; stderr: ${tools.firstLine(pullC.stderr)}`).toBe(1);
    expect(pullC.stderr, "the failure reached the operator as a clean stop, not a crash").toContain("ipfs-sync: pull stopped:");
    expect(pullC.stderr, "stderr names the unlock failure pinned at src/crypto/key-slots.ts:118").toContain("wrong passphrase or damaged key slot");
    const errorLine = pullC.stderr
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("wrong passphrase or damaged key slot"));
    announce(`S3: C's pull exited ${String(pullC.code)} in ${String(pullC.ms)} ms; stderr: ${errorLine ?? "(line not found)"}`);

    // ---- fail closed on disk: no pulled file, no .ipfs-sync state file, no sequence floor ------------------------------
    const filesC = await listAllFiles(deviceC.vaultDir);
    expect(filesC, `C's vault holds no file at all — no pulled file and no .ipfs-sync state: ${filesC.join(", ")}`).toEqual([]);
    const leftoverEntries = await readdir(deviceC.vaultDir, { recursive: true }).catch(() => [] as string[]);
    announce(`S3: C's vault after the failed pull: ${leftoverEntries.length === 0 ? "completely empty" : `only directories left [${leftoverEntries.join(", ")}] — no files`}`);
    // The per-user store path is <XDG_STATE_HOME>/ipfs-sync (cli/device-store-node.ts:16); the floor file is
    // sequence-floor.json (src/sync/sequence-floor.ts:12), written only after a confirmed, authenticated pull.
    const floorFile = join(deviceC.stateHome, "ipfs-sync", "sequence-floor.json");
    expect(await stat(floorFile).catch(() => undefined), "C's state home holds no sequence floor").toBeUndefined();
    const stateFilesC = await listAllFiles(deviceC.stateHome);
    expect(stateFilesC.filter((path) => path.endsWith("sequence-floor.json")), `no sequence-floor.json anywhere in C's state home: ${stateFilesC.join(", ")}`).toEqual([]);
    const stateOutsideHistory = stateFilesC.filter((path) => !path.startsWith("ipfs-sync/history/"));
    announce(`S3: C's state home after the failed pull: ${stateFilesC.length - stateOutsideHistory.length} history-database files (opened before the unlock, nothing recorded), other files [${stateOutsideHistory.join(", ")}] — no sequence floor`);

    // ---- no mutation reached the node during C's attempt (proxy log slice) ----------------------------------------------
    expect(traceC.length, "C's pull went through the proxy").toBeGreaterThan(0);
    const mutationsC = traceC.filter((entry) => entry.mutating).map((entry) => `${entry.command} ${entry.arg ?? ""}`);
    expect(mutationsC, `no mutation reached the node during C's attempt (${traceC.length} requests in the slice): ${mutationsC.join("; ")}`).toEqual([]);
    const refusedC = traceC.filter((entry) => !entry.allowed).map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refusedC, `the proxy refused nothing C's pull sent: ${refusedC.join("; ")}`).toEqual([]);
    announce(`S3: proxy slice of C's attempt — ${traceC.length} requests, all reads, none refused`);

    // ---- the suite invariant re-checked over everything S3 added ------------------------------------------------------
    expect(pullC.leaked, `C's scrubbed pull output held a secret or plaintext${pullC.needle === undefined ? "" : ` (${pullC.needle})`}`).toBe(false);
    const leaks = S.childResults.filter((entry) => entry.result.leaked).map((entry) => `${entry.label}${entry.result.needle === undefined ? "" : ` (${entry.result.needle})`}`);
    expect(leaks, `no child output holds a passphrase spelling or fixture plaintext: ${leaks.join(", ")}`).toEqual([]);
    const wireHits = S.proxy.log.filter((entry) => entry.needle !== undefined).map((entry) => `${entry.command} ${entry.arg ?? ""}: ${entry.needle ?? ""}`);
    expect(wireHits, `no request URL or body holds fixture plaintext or a passphrase spelling: ${wireHits.join("; ")}`).toEqual([]);
    const refused = S.proxy.violations.map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refused, `the proxy refused nothing a correct CLI sends: ${refused.join("; ")}`).toEqual([]);
    announce("S3: needle scan still clean across all child output, request URLs and request bodies");
  });

  it("S4: a tampered root pulled by --root-cid fails closed per file — the flipped blob's file is integrity-failed and absent, every other file fetched, no mutation but the preparer's confined writes", async () => {
    const S = must(suite, "the suite state (beforeAll failed)");
    const { tools, context } = S;
    const vaultId = must(S.shared.vaultId, "S1's vault id");
    const expectedPaths = must(S.shared.expectedPaths, "S1's published path list");
    const proxyUrl = must(S.proxy.url, "the proxy URL");

    // ---- the tampered root, prepared by the mvp-07 hostile op (imported through harness/hostile, never copied) ------
    // The op's complete-tree mode (spec delta 2026-10-06): it reads the genuine root (the run root after S2's publish),
    // unlocks it with the vault's own passphrase via the test-only unwrap hook inside its own child bundle, copies EVERY
    // blob below <runRoot>/tamper with exactly one bit flipped in one of them, and writes a new authentic manifest.enc
    // at a higher sequence — every write below <runRoot>/tamper, every request through the proxy. The complete tree is
    // what lets a fresh device fetch every intact file: the pull fetches exclusively from the tree the manifest names
    // (src/sync/encrypted-pull-stage.ts:210-213).
    const hostile = await loadHostile07();
    const tamperDir = `${context.runRoot}/tamper`;
    const prepareMark = S.proxy.mark();
    const prepared = await hostile.prepareTamper(join(context.tempDir, "hostile"), {
      rpc: proxyUrl,
      gateway: proxyUrl,
      mfsRoot: context.runRoot,
      sourceRoot: context.runRoot,
      tamperDir,
      passphraseFile: context.passphraseFile,
      bump: hostile.sequenceBump,
      completeTree: true,
    }, process.env);
    const prepareSlice = S.proxy.since(prepareMark);
    const writes = prepareSlice.filter((entry) => entry.mutating);
    const outside = writes.filter((entry) => !(["files/write", "files/mkdir"].includes(entry.command) && tools.isWithin(`${entry.arg}`, tamperDir, { allowEqual: true })));
    expect(prepareSlice.length, "the preparer went through the proxy").toBeGreaterThan(0);
    expect(outside, `every preparer write is a files/write or files/mkdir inside ${tamperDir}: ${outside.map((entry) => `${entry.command} ${entry.arg ?? ""}`).join("; ")}`).toEqual([]);
    expect(writes.length, "the preparer wrote the tampered tree").toBeGreaterThan(0);
    const refusedPrep = prepareSlice.filter((entry) => !entry.allowed).map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refusedPrep, `the proxy refused nothing the preparer sent: ${refusedPrep.join("; ")}`).toEqual([]);
    expect(prepared.mode, "the preparer ran in its complete-tree mode").toBe("complete-tree");
    expect(prepared.blobsWritten, `every one of the ${expectedPaths.length} blobs was copied into the tamper tree`).toBe(expectedPaths.length);
    expect(prepared.sequence, `the tampered manifest carries sequence ${prepared.sequence}, above the genuine ${prepared.sourceSequence}`).toBe(prepared.sourceSequence + hostile.sequenceBump);
    expect(expectedPaths.includes(prepared.target), `the tampered file ${prepared.target} is a published path`).toBe(true);
    announce(
      `S4: prepare-tamper (complete-tree) — target ${prepared.target}, sequence ${prepared.sourceSequence} -> ${prepared.sequence}, root ${prepared.root}, ${prepared.blobsWritten} blobs written; ` +
        `write audit: ${writes.length} mutating request(s), all files/write|files/mkdir inside ${tamperDir} [${writes.map((entry) => `${entry.command} ${entry.arg ?? ""}`).join("; ")}]`,
    );

    // ---- fresh device D pulls the tampered root by --root-cid ------------------------------------------------------
    const deviceD = await makeDevice(context, "e2e-d");
    await writeFile(deviceD.configFile, "{}\n");
    const cliD = await makeCliRunner({
      context,
      device: deviceD,
      proxyUrl,
      ownedKeyIds: [S.keyId],
      secrets: () => S.secrets,
      needles: () => S.contentNeedles,
    });
    expect((await tools.walkFiles(deviceD.vaultDir)).length, "D starts empty").toBe(0);
    const markD = S.proxy.mark();
    const pullD = await cliD("pull", [deviceD.vaultDir], {
      passphraseFile: context.passphraseFile,
      extra: ["--accept-first-pull", "--expect-vault-id", vaultId, "--root-cid", prepared.root],
    });
    S.childResults.push({ label: "pull D (tampered root)", result: pullD });
    const traceD = S.proxy.since(markD);
    expect(pullD.code, `D's pull of the tampered root must fail closed; stderr: ${tools.firstLine(pullD.stderr)}`).toBe(1);
    expect(pullD.stderr, "stderr reports the tampered file integrity-failed").toContain(`integrity-failed ${prepared.target}`);
    const integrityLine = pullD.stderr
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(`integrity-failed ${prepared.target}`));
    announce(`S4: D's pull exited ${String(pullD.code)} in ${String(pullD.ms)} ms; stderr: ${integrityLine ?? "(line not found)"}`);
    const pulledD = tools.parsePullOutput(pullD.stdout);
    expect(pulledD.sequence, "the pull settled on the tampered sequence").toBe(prepared.sequence);
    expect(pulledD.rootCid, "the pull settled on the tampered root").toBe(prepared.root);
    expect(
      [pulledD.fetched, pulledD.unchanged, pulledD.conflicts, pulledD.integrityFailed, pulledD.unfetched],
      `every other file fetched, the tampered one integrity-failed: ${String(pulledD.fetched)} fetched, ${String(pulledD.unchanged)} unchanged, ${String(pulledD.conflicts)} conflicts, ${String(pulledD.integrityFailed)} integrity-failed, ${String(pulledD.unfetched)} unfetched`,
    ).toEqual([expectedPaths.length - 1, 0, 0, 1, 0]);
    announce(`S4: pull counts — ${String(pulledD.fetched)} fetched of ${expectedPaths.length - 1} fetchable, ${String(pulledD.integrityFailed)} integrity-failed (${prepared.target})`);

    // ---- fail closed on disk: the tampered file absent, every other file present, no temporary file left -------------
    const filesD = await listAllFiles(deviceD.vaultDir);
    expect(filesD.includes(prepared.target), "the tampered file is absent in the destination").toBe(false);
    const nonStateD = filesD.filter((path) => !path.startsWith(".ipfs-sync/"));
    expect(nonStateD, `D holds every published file but the tampered one: ${nonStateD.join(", ")}`).toEqual(expectedPaths.filter((path) => path !== prepared.target));
    const tempLeftovers = filesD.filter((path) => path.startsWith(".ipfs-sync/tmp/"));
    expect(tempLeftovers, `no .ipfs-sync/tmp/ leftover file remains: ${tempLeftovers.join(", ")}`).toEqual([]);
    // Directories too: anything BELOW the staging folder, not only regular files, is a leftover. The pull may leave the
    // empty staging folder itself behind — it is created before the first blob stages and holds nothing after the discard.
    const entriesD = await readdir(deviceD.vaultDir, { recursive: true }).catch(() => [] as string[]);
    const tempEntries = entriesD.filter((entry) => entry.startsWith(".ipfs-sync/tmp/"));
    expect(tempEntries, `nothing below .ipfs-sync/tmp remains: ${tempEntries.join(", ")}`).toEqual([]);
    announce(`S4: D's vault — ${nonStateD.length} files (all but ${prepared.target}); nothing below .ipfs-sync/tmp (${entriesD.includes(".ipfs-sync/tmp") ? "the empty staging folder itself remains" : "the staging folder is gone"})`);

    // ---- no mutation besides the preparer's confined writes ---------------------------------------------------------
    expect(traceD.length, "D's pull went through the proxy").toBeGreaterThan(0);
    const mutationsD = traceD.filter((entry) => entry.mutating).map((entry) => `${entry.command} ${entry.arg ?? ""}`);
    expect(mutationsD, `no mutation reached the node during D's pull (${traceD.length} requests in the slice): ${mutationsD.join("; ")}`).toEqual([]);
    const refusedD = traceD.filter((entry) => !entry.allowed).map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refusedD, `the proxy refused nothing D's pull sent: ${refusedD.join("; ")}`).toEqual([]);
    announce(`S4: proxy slice of D's pull — ${traceD.length} requests, all reads, none refused`);

    // ---- the suite invariant re-checked over everything S4 added ----------------------------------------------------
    expect(pullD.leaked, `D's scrubbed pull output held a secret or plaintext${pullD.needle === undefined ? "" : ` (${pullD.needle})`}`).toBe(false);
    const leaks = S.childResults.filter((entry) => entry.result.leaked).map((entry) => `${entry.label}${entry.result.needle === undefined ? "" : ` (${entry.result.needle})`}`);
    expect(leaks, `no child output holds a passphrase spelling or fixture plaintext: ${leaks.join(", ")}`).toEqual([]);
    const wireHits = S.proxy.log.filter((entry) => entry.needle !== undefined).map((entry) => `${entry.command} ${entry.arg ?? ""}: ${entry.needle ?? ""}`);
    expect(wireHits, `no request URL or body holds fixture plaintext or a passphrase spelling: ${wireHits.join("; ")}`).toEqual([]);
    const refused = S.proxy.violations.map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refused, `the proxy refused nothing a correct CLI sends: ${refused.join("; ")}`).toEqual([]);
    announce("S4: needle scan still clean across all child output, request URLs and request bodies");
  });

  it("S5: the cleanup as an ordered step — the run root removed through the confined proxy, then no e2e- entry left under /obsidian-vault-sync (a stale root fails loudly with its operator removal command)", async () => {
    const S = must(suite, "the suite state (beforeAll failed)");
    const { tools, context } = S;

    // ---- cleanupRunRoot, through the proxy so the allowlist confines it to exactly the run root ------------------
    const cleanupMark = S.proxy.mark();
    const outcome = await cleanupRunRoot(S.proxyClient, context.runRoot);
    expect(outcome, "the run root was present through S4 and is removed now").toBe("removed");
    const cleanupSlice = S.proxy.since(cleanupMark);
    const cleanupWrites = cleanupSlice.filter((entry) => entry.mutating).map((entry) => `${entry.command} ${entry.arg ?? ""}`);
    expect(cleanupWrites, `the cleanup's only mutation is files/rm -r of exactly the run root: ${cleanupWrites.join("; ")}`).toEqual([`files/rm ${context.runRoot}`]);
    const refusedCleanup = cleanupSlice.filter((entry) => !entry.allowed).map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refusedCleanup, `the proxy refused nothing the cleanup sent: ${refusedCleanup.join("; ")}`).toEqual([]);
    announce(`S5: cleanupRunRoot removed ${context.runRoot} from the node (files/rm -r, confirmed by files/stat); proxy slice ${cleanupSlice.length} requests, the files/rm the only mutation`);

    // ---- the no-leftovers gate: re-list the base; any e2e- entry fails loudly with its exact removal command -------
    // Read-only and upstream-direct like the beforeAll snapshot. A failed listing FAILS the gate (fail, never skip).
    const finalEntries = await S.node.filesLs(BASE_PATH);
    const finalNames = finalEntries.map((entry) => entry.name ?? "?");
    const staleRoots = finalNames.filter((name) => name.startsWith("e2e-"));
    for (const stale of staleRoots) {
      announce(
        `S5: STALE RUN ROOT ${BASE_PATH}/${stale} left by a previously crashed run. Automatic removal of any root but this run's own is refused by the policy ` +
          `(pinned by tests/unit/e2e-proxy-policy.test.ts). Remove it by hand with: files/rm -r ${BASE_PATH}/${stale}`,
      );
    }
    expect(
      staleRoots,
      `no e2e- prefixed entry under ${BASE_PATH}; remove stale roots by hand: ${staleRoots.map((name) => `files/rm -r ${BASE_PATH}/${name}`).join("; ")}`,
    ).toEqual([]);
    announce(`S5: final listing of ${BASE_PATH}: [${finalNames.join(", ")}] — no e2e- entries; the afterAll safety net will find nothing to do`);

    // ---- the suite invariant re-checked over everything S5 added ------------------------------------------------------
    const leaks = S.childResults.filter((entry) => entry.result.leaked).map((entry) => `${entry.label}${entry.result.needle === undefined ? "" : ` (${entry.result.needle})`}`);
    expect(leaks, `no child output holds a passphrase spelling or fixture plaintext: ${leaks.join(", ")}`).toEqual([]);
    const wireHits = S.proxy.log.filter((entry) => entry.needle !== undefined).map((entry) => `${entry.command} ${entry.arg ?? ""}: ${entry.needle ?? ""}`);
    expect(wireHits, `no request URL or body holds fixture plaintext or a passphrase spelling: ${wireHits.join("; ")}`).toEqual([]);
    const refused = S.proxy.violations.map((entry) => `${entry.command} ${entry.arg ?? ""} (${entry.reason})`);
    expect(refused, `the proxy refused nothing a correct CLI sends: ${refused.join("; ")}`).toEqual([]);
    announce("S5: needle scan still clean across all child output, request URLs and request bodies");
  });
});
