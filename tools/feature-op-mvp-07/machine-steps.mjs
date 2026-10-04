// The machine side of the Obsidian steps (task 4.7a, design decision 11 steps 1 to 5 and 7), driven through the built CLI as a child process:
// V1 setup and publish, the ciphertext-only check of the node, V2 pull with a wrong passphrase, the first pull and byte equality, the edit-both
// conflict, the large blob, and the mass-removal stop. Every request goes through the confinement proxy; the proxy log is the evidence of what
// each step sent. Each step records checks against assertion ids; an assertion passes only when every one of its checks held.
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EDIT_A_ONLY, EDIT_B_ONLY, EDIT_BOTH } from "../feature-op-mvp-07a/constants.mjs";
import { parsePublishOutput, parsePullOutput, pullTraceProblems } from "../feature-op-mvp-07a/policy.mjs";
import { appendNote, exists, readLocalState, sameDigest, treeDigest, walkFiles } from "../feature-op-mvp-07a/workspace.mjs";
import { LARGE_BLOB_MIN_BYTES, blobNamesFetched, blobSizeProblem, scanProblems, treeMismatches } from "./machine-checks.mjs";
import { BLOB_PATH, MARKER, getSession } from "./machine-session.mjs";
import { repointName } from "./cli-scenarios.mjs";
import { scanTree } from "./node-reader.mjs";
import { firstLine, sha256 } from "./policy.mjs";
import { makeRecorder } from "./recorder.mjs";

export const MACHINE_IDS = Object.freeze(["ciphertext-only-on-node", "plaintext-restored-byte-equal", "wrong-passphrase-refused", "sequence-recorded", "pull-no-node-mutation", "conflict-copy-kept", "multi-segment-blob-pulled-in-plugin"]);
const CIPHER = "ciphertext-only-on-node";
const BYTES = "plaintext-restored-byte-equal";
const WRONG = "wrong-passphrase-refused";
const SEQUENCE = "sequence-recorded";
const NO_MUTATION = "pull-no-node-mutation";
const CONFLICT = "conflict-copy-kept";
const BLOB = "multi-segment-blob-pulled-in-plugin";
const MASS_REMOVAL = "mass-removal-stopped";
const WRONG_PASSPHRASE = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
const CONFLICT_COPY = /^projects\/alpha\/tasks \(ipfs conflict \d{4}-\d{2}-\d{2}(?: \d+)?\)\.md$/;

const message = (error) => firstLine(error instanceof Error ? error.message : String(error));
const floorOf = (device) => join(device.stateHome, "ipfs-sync", "sequence-floor.json");

async function hashesOf(vault, paths) {
  const found = new Map();
  for (const path of paths) found.set(path, await readFile(join(vault, ...path.split("/"))).then(sha256, () => "absent"));
  return found;
}

/** One pull of `device` through the proxy; the audit of its slice of the proxy log (the one place every request passes) goes on the session for the no-mutation assertion. */
async function pullAs(S, X, device, label, { passphraseFile = X.passFile, extra = [] } = {}) {
  const mark = S.proxy.mark();
  const run = await device.cli("pull", [device.vault], { passphraseFile, extra });
  const trace = S.proxy.since(mark);
  X.pulls.push({ label, problems: pullTraceProblems(trace), requests: trace.length });
  return { run, trace, summary: parsePullOutput(run.stdout) };
}

async function ciphertextStep(S, X, { add }) {
  add(CIPHER, "init wrote only keyslots.json to the node and printed no passphrase", X.initWrites.length > 0 && X.initWrites.every((path) => path === `${S.mainRoot}/keyslots.json`) && !X.initLeaked, X.initWrites.join(", "));
  add(CIPHER, "the passphrase file is 0600 and has the generated 5x5 shape", X.passphraseOk === true);
  const root = (await S.client.filesStat(S.mainRoot)).cid;
  const needles = [...X.needles, ...X.secrets.map((secret) => ({ label: "a passphrase spelling", bytes: Buffer.from(secret) }))];
  const scan = await scanTree({ bundle: S.bundle, env: S.env, localStub: S.opts.localStub, rpc: S.apiUrl, gateway: S.apiUrl, mfsRoot: S.mainRoot, root, needles });
  const plainBytes = X.published.reduce((sum, file) => sum + file.size, 0);
  const problems = scanProblems({ log: S.proxy.log, scan, minFiles: X.published.length, minBytes: plainBytes });
  add(CIPHER, `the node's ${scan.files} files (${scan.bytes} bytes) and all ${S.proxy.log.length} proxied requests hold none of ${needles.length} plaintext needles (paths, titles, body words, blob bytes, passphrase)`, problems.length === 0, problems.join("; "));
}

async function wrongPassphraseStep(S, X, { add }) {
  const wrongFile = join(dirname(X.passFile), "wrong-passphrase.txt");
  await writeFile(wrongFile, `${WRONG_PASSPHRASE}\n`, { mode: 0o600 });
  X.secrets.push(WRONG_PASSPHRASE, WRONG_PASSPHRASE.replaceAll("-", ""));
  const before = await treeDigest(X.B.vault);
  const { run } = await pullAs(S, X, X.B, "wrong passphrase", { passphraseFile: wrongFile, extra: ["--accept-first-pull", "--expect-vault-id", X.vaultId, "--expect-min-sequence", "1"] });
  add(WRONG, "the pull with a wrong passphrase exits nonzero with an error message and prints no passphrase", run.code !== 0 && run.stderr.trim() !== "" && !run.leaked, `exit ${run.code}: ${firstLine(run.stderr)}`);
  add(WRONG, "V2 is unchanged: no vault file, marker, state or key-slot copy was written", sameDigest(before, await treeDigest(X.B.vault)));
  add(WRONG, "no sequence floor was written in V2's per-user store", !(await exists(floorOf(X.B))));
  X.wrongOutcome = firstLine(run.stderr);
}

async function firstPullStep(S, X, { add }) {
  const { run, trace, summary } = await pullAs(S, X, X.B, "first pull", { extra: ["--accept-first-pull", "--expect-vault-id", X.vaultId, "--expect-min-sequence", "1"] });
  const count = X.published.length;
  add(BYTES, "the first pull exits 0 and prints no passphrase", run.code === 0 && !run.leaked, `exit ${run.code}: ${firstLine(run.stderr)}`);
  add(BYTES, `sequence 1; every one of the ${count} published files fetched; no conflict, integrity failure or unfetched file`, summary.sequence === 1 && summary.fetched === count && summary.unchanged === 0 && summary.conflicts === 0 && summary.integrityFailed === 0 && summary.unfetched === 0, JSON.stringify(summary));
  const expected = new Map(X.published.map((file) => [file.path, file.sha256]));
  const present = await walkFiles(X.B.vault);
  const actual = new Map(present.filter((file) => file.path !== MARKER).map((file) => [file.path, file.sha256]));
  const mismatches = treeMismatches(expected, actual);
  add(BYTES, `V2 holds exactly the ${count} published files, each byte-equal to V1's (${mismatches.length} mismatches)`, mismatches.length === 0, mismatches.slice(0, 3).join(", "));
  add(BYTES, "V2's fixture marker is pulled-fixture", (await readFile(join(X.B.vault, MARKER), "utf8").catch(() => "")).trim() === "pulled-fixture");
  add(BYTES, "the blobs the pull fetched match the files it reports fetching", blobNamesFetched(trace).length === summary.fetched, `${blobNamesFetched(trace).length} blob names, ${summary.fetched} fetched`);
  X.expected = expected;
  X.afterFirst = actual;

  const state = await readLocalState(X.B.vault, S.mainRoot);
  const kept = await readdir(join(X.B.vault, ".ipfs-sync")).catch(() => []);
  add(SEQUENCE, "publish #1 reported sequence 1, nothing removed and every published file written", X.publish1.summary.sequence === 1 && X.publish1.summary.removed === 0 && X.publish1.summary.written === count && !X.publish1.run.leaked, JSON.stringify(X.publish1.summary));
  add(SEQUENCE, "V2 recorded highestSequence 1, complete, a key-slot copy and the sequence floor", state?.highestSequence === 1 && state.complete === true && kept.some((name) => name.startsWith("keyslots.")) && (await exists(floorOf(X.B))), `state sequence ${state?.highestSequence}, ${kept.join(",")}`);
  add(SEQUENCE, "V1 recorded highestSequence 1 and its sequence floor", (await readLocalState(X.A.vault, S.mainRoot))?.highestSequence === 1 && (await exists(floorOf(X.A))));

  const blobHash = expected.get(BLOB_PATH);
  const sizeProblem = blobSizeProblem(X.blobBytes, S.machine.blobMinBytes);
  add(BLOB, `the blob ${BLOB_PATH} (${X.blobBytes} bytes) is in the published set and byte-equal in V2 after the CLI pull`, blobHash !== undefined && actual.get(BLOB_PATH) === blobHash, "missing or different");
  add(BLOB, `the blob is at least ${S.machine.blobMinBytes} bytes${S.machine.blobMinBytes === LARGE_BLOB_MIN_BYTES ? " (20 MiB)" : ""}`, sizeProblem === undefined, sizeProblem);
}

async function conflictStep(S, X, { add }) {
  S.t.out("step 4: A and B edit; A publishes; B pulls");
  const aOnly = await appendNote(X.A.vault, EDIT_A_ONLY, "\nedit by device A only\n");
  const aBoth = await appendNote(X.A.vault, EDIT_BOTH, "\nedit by device A, same file\n");
  const bOnly = await appendNote(X.B.vault, EDIT_B_ONLY, "\nedit by device B only\n");
  const bBoth = await appendNote(X.B.vault, EDIT_BOTH, "\nedit by device B, same file\n");
  const publish = await X.A.cli("publish", [X.A.vault], { passphraseFile: X.passFile });
  const published = parsePublishOutput(publish.stdout);
  add(CONFLICT, "publish #2 (device A) reports 2 written, 0 removed, sequence 2 and prints no passphrase", publish.code === 0 && published.written === 2 && published.removed === 0 && published.sequence === 2 && !publish.leaked, `exit ${publish.code}: ${firstLine(publish.stderr)} ${JSON.stringify(published)}`);
  X.lastSequence = published.sequence ?? X.lastSequence;
  X.lastRoot = published.rootCid ?? X.lastRoot;
  const edited = new Set([EDIT_A_ONLY, EDIT_B_ONLY, EDIT_BOTH]);
  const untouched = [...X.expected.keys()].filter((path) => !edited.has(path));
  const { run, trace, summary } = await pullAs(S, X, X.B, "conflict pull", { extra: ["--expect-min-sequence", "2"] });
  add(CONFLICT, "pull #2 (device B) exits 0 and prints no passphrase", run.code === 0 && !run.leaked, `exit ${run.code}: ${firstLine(run.stderr)}`);
  const pair = summary.conflictPairs[0];
  add(CONFLICT, "sequence 2; the same-file edit made exactly one conflict copy, dated, next to the original", summary.sequence === 2 && summary.conflicts === 1 && summary.conflictPairs.length === 1 && pair?.path === EDIT_BOTH && CONFLICT_COPY.test(pair.copy), JSON.stringify(summary.conflictPairs));
  const copy = pair?.copy ?? "";
  const files = await hashesOf(X.B.vault, [EDIT_A_ONLY, EDIT_B_ONLY, EDIT_BOTH, copy]);
  add(CONFLICT, "A's edit to its own file arrived; B's edit to its own file is kept and reported as locally modified", files.get(EDIT_A_ONLY) === sha256(aOnly) && files.get(EDIT_B_ONLY) === sha256(bOnly) && summary.locallyModified === 1 && run.stdout.includes(`locally modified ${EDIT_B_ONLY}`), `locally modified ${summary.locallyModified}`);
  add(CONFLICT, "the file edited on both sides holds the node's text and the conflict copy holds B's text", files.get(EDIT_BOTH) === sha256(aBoth) && files.get(copy) === sha256(bBoth));
  const fetchedBlobs = blobNamesFetched(trace);
  add(CONFLICT, "only the 2 changed blobs were fetched; every other file is untouched (including the large blob)", summary.fetched === 2 && fetchedBlobs.length === 2 && summary.unchanged >= untouched.length, `${summary.fetched} fetched, ${fetchedBlobs.length} blob names, ${summary.unchanged} unchanged`);
  const after = await hashesOf(X.B.vault, untouched);
  const moved = untouched.filter((path) => after.get(path) !== X.expected.get(path));
  add(CONFLICT, `the ${untouched.length} other published files are byte-identical to before the pull`, moved.length === 0, moved.slice(0, 3).join(", "));
  const stateB = await readLocalState(X.B.vault, S.mainRoot);
  const stateA = await readLocalState(X.A.vault, S.mainRoot);
  add(SEQUENCE, "after publish #2 and pull #2, both devices recorded highestSequence 2", stateA?.highestSequence === 2 && stateB?.highestSequence === 2, `A ${stateA?.highestSequence}, B ${stateB?.highestSequence}`);
}

function noMutationVerdict(X, { add }) {
  add(NO_MUTATION, `${X.pulls.length} pulls were made (${X.pulls.map((pull) => pull.label).join(", ")})`, X.pulls.length >= 3, `${X.pulls.length}`);
  for (const pull of X.pulls) {
    add(NO_MUTATION, `${pull.label}: ${pull.requests} proxied request(s), none mutating, refused or outside the pull read set`, pull.problems.length === 0, pull.problems.slice(0, 2).join("; "));
  }
}

/**
 * The seven machine assertions of the Obsidian phase, as results [{ id, passed, detail }]. Needs the session (so a failed setup fails all seven).
 * Never rejects for a failed step: a step that throws fails the assertions it feeds.
 */
export async function runMachineSteps(S) {
  const recorder = makeRecorder(S);
  let X;
  try {
    X = await getSession(S, { withBlob: true });
  } catch (error) {
    return MACHINE_IDS.map((id) => ({ id, passed: false, detail: `setup failed: ${message(error)}` }));
  }
  const steps = [
    ["the ciphertext-only check", [CIPHER], ciphertextStep],
    ["the wrong-passphrase pull", [WRONG], wrongPassphraseStep],
    ["the first pull", [BYTES, SEQUENCE, BLOB], firstPullStep],
    ["the conflict step", [CONFLICT, SEQUENCE], conflictStep],
  ];
  for (const [name, ids, step] of steps) {
    try {
      S.t.out(`\n-- ${name} --`);
      await step(S, X, recorder);
    } catch (error) {
      for (const id of ids) recorder.add(id, `${name} ran to completion`, false, message(error));
    }
  }
  noMutationVerdict(X, recorder);
  return MACHINE_IDS.map((id) => recorder.verdictFor(id));
}

/**
 * Step 7: a publish from a vault emptied past the guard stops with the mass-removal refusal and writes nothing; the same publish with
 * --allow-mass-removal removes every entry and moves the sequence by one. Returns [{ id, passed, detail }].
 */
export async function runMassRemoval(S) {
  const recorder = makeRecorder(S);
  try {
    const X = await getSession(S, { withBlob: false });
    S.t.out("\n-- step 7: mass-removal stop --");
    if (S.pointerMoved === true && X.lastRoot !== undefined) {
      const back = await repointName(S, { root: S.mainRoot }, X.lastRoot);
      recorder.add(MASS_REMOVAL, "the owned key was pointed back at this vault's last root (earlier scenarios moved it; only name/publish for the owned key was sent)", back.onlyNamePublish);
    }
    const count = X.published.length;
    for (const file of await walkFiles(X.A.vault)) if (file.path !== MARKER) await rm(join(X.A.vault, ...file.path.split("/")), { force: true });
    const mark = S.proxy.mark();
    const refused = await X.A.cli("publish", [X.A.vault], { passphraseFile: X.passFile });
    const trace = S.proxy.since(mark);
    const counts = /would remove (\d+) of (\d+) entries/.exec(refused.stderr);
    recorder.add(MASS_REMOVAL, `the publish of a vault emptied of ${count} files exits nonzero with the mass-removal message naming ${count} of ${count}`, refused.code !== 0 && counts !== null && Number(counts[1]) === count && Number(counts[2]) === count && /mass-removal|--allow-mass-removal/.test(refused.stderr), `exit ${refused.code}: ${firstLine(refused.stderr)}`);
    recorder.add(MASS_REMOVAL, `the refused publish sent no mutating request (${trace.length} proxied request(s): reads only, so no file, pin or name publish) and printed no passphrase`, trace.every((entry) => !entry.mutating) && !refused.leaked, trace.filter((entry) => entry.mutating).map((entry) => entry.command).join(", "));
    const allowed = await X.A.cli("publish", [X.A.vault], { passphraseFile: X.passFile, extra: ["--allow-mass-removal"] });
    const summary = parsePublishOutput(allowed.stdout);
    recorder.add(MASS_REMOVAL, `with --allow-mass-removal the publish exits 0, removes all ${count} entries and moves the sequence to ${X.lastSequence + 1}`, allowed.code === 0 && summary.removed === count && summary.written === 0 && summary.sequence === X.lastSequence + 1 && !allowed.leaked, `exit ${allowed.code}: ${firstLine(allowed.stderr)} ${JSON.stringify(summary)}`);
    X.lastSequence = summary.sequence ?? X.lastSequence;
  } catch (error) {
    recorder.add(MASS_REMOVAL, "the mass-removal step ran to completion", false, message(error));
  }
  return [recorder.verdictFor(MASS_REMOVAL)];
}
