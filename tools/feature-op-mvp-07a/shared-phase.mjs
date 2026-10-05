// The shared-node phase: device A publishes, device B (an empty directory) pulls, both edit, B publishes, A pulls, replay and restore.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeCliRunner, scrub } from "./children.mjs";
import { DEVICE_A, DEVICE_B, EDIT_A_ONLY, EDIT_B_ONLY, EDIT_BOTH, KEY, MIN_PUBLISHED_FILES } from "./constants.mjs";
import { checkNameAtRoot, listBlobNames, readNodeManifest, readPassphraseFile } from "./node-view.mjs";
import { firstLine, parseInitOutput, parsePublishOutput, parsePullOutput, plaintextNeedles, pullTraceProblems, scrubbedDetail, sha256, withPassphraseSpellings } from "./policy.mjs";
import { check, out, skip } from "./report.mjs";
import { tamperOnce } from "./tamper.mjs";
import { appendNote, exists, generateVault, readLocalState, sameDigest, setMarker, treeDigest, vaultPath, walkFiles } from "./workspace.mjs";

// ======================================================================================================================
// Shared-node phase
// ======================================================================================================================

const CONFLICT_COPY = /^projects\/alpha\/tasks \(ipfs conflict \d{4}-\d{2}-\d{2}(?: \d+)?\)\.md$/;
const DAY_PATTERN = /\d{4}-\d{2}-\d{2}/;

const publishedDigest = async (vault, paths) => {
  const found = new Map();
  for (const path of paths) found.set(path, await readFile(vaultPath(vault, path)).then(sha256, () => "absent"));
  return found;
};

const countCommands = (trace) => {
  const counts = new Map();
  for (const entry of trace) counts.set(entry.command, (counts.get(entry.command) ?? 0) + 1);
  return [...counts].map(([command, count]) => `${command} x${count}`).join(", ") || "none";
};

/** The audit of one pull's slice of the proxy log. `planted` is the pull-writes tamper: one synthetic mutating entry in this copy of the slice only. */
function pullTraceCheck(S, label, trace, planted) {
  const shown = planted === undefined ? trace : [...trace, planted];
  const problems = pullTraceProblems(shown);
  for (const entry of trace) S.pullReads.set(entry.command, (S.pullReads.get(entry.command) ?? 0) + 1);
  return check(`${label}: the proxy log shows ${shown.length} request(s) (${countCommands(shown)}), none mutating and none outside the pull read set`, problems.length === 0, problems.slice(0, 3).join("; "));
}

async function pullAs(S, device, { extra = [] } = {}) {
  const mark = S.proxy.mark();
  const run = await device.cli("pull", [device.vault], { passphraseFile: S.passFile, extra });
  return { run, trace: S.proxy.since(mark), summary: parsePullOutput(run.stdout) };
}

async function publishAs(S, device, label, expected) {
  const run = await device.cli("publish", [device.vault], { passphraseFile: S.passFile });
  const summary = parsePublishOutput(run.stdout);
  check(`${label}: exits 0 and prints no passphrase`, run.code === 0 && !run.leaked, firstLine(run.stderr) || `${run.ms} ms`);
  if (expected !== undefined) check(`${label}: reports "${expected.written} written, ${expected.removed} removed" with sequence ${expected.sequence}`, summary.written === expected.written && summary.removed === expected.removed && summary.sequence === expected.sequence, `${summary.written} written, ${summary.removed} removed, sequence ${summary.sequence}`);
  return { run, summary };
}

// ---- step 1: vault A, init and the first publish --------------------------------------------------------------------

async function prepareVaultA(S) {
  const generated = await generateVault(S.A.vault);
  if (!check("step 1: vault A is a generated fixture vault (marker `fixture`)", generated.code === 0 && (await exists(join(S.A.vault, ".ipfs-sync-fixture"))), firstLine(generated.text))) throw new Error("no fixture vault, nothing further can run");
  S.filesA = await walkFiles(S.A.vault);
  S.plainNeedles = plaintextNeedles(S.filesA);
  S.proxy.setNeedles(S.plainNeedles);
  check(`step 1: ${S.filesA.length} generated files; vault B is an empty directory`, S.filesA.length >= MIN_PUBLISHED_FILES && (await exists(S.B.vault)) && (await walkFiles(S.B.vault)).length === 0);
}

async function initFailureDetail(S, init) {
  return scrubbedDetail(init, withPassphraseSpellings(S.secrets, await readFile(S.passFile, "utf8").catch(() => "")));
}

async function initVaultA(S) {
  const init = await S.A.cli("init", [S.A.vault], { extra: ["--passphrase-file", S.passFile] });
  if (!check("step 1: `init --passphrase-file <per-run path>` exits 0 and creates the vault", init.code === 0, init.code === 0 ? "" : await initFailureDetail(S, init))) throw new Error("init failed, nothing further can run");
  const loaded = await readPassphraseFile(S.tb, S.passFile);
  check("step 1: the passphrase file is 0600, has the generated 5x5 shape and is outside the repository", loaded.shapeOk && loaded.modeOk && loaded.outsideRepo);
  S.passphrase = loaded.passphrase;
  S.view.passphrase = loaded.passphrase;
  S.secrets.push(...loaded.secrets);
  S.proxy.setNeedles([...S.plainNeedles, ...loaded.secrets.map((text, index) => ({ label: index === 0 ? "passphrase (grouped)" : "passphrase (canonical)", bytes: Buffer.from(text) }))]);
  S.vaultId = parseInitOutput(init.stdout).vaultId;
  check("step 1: init printed the vault id (32 hex characters, kept for --expect-vault-id) and no passphrase", S.vaultId !== undefined && !scrub(init, S.secrets).leaked, S.vaultId === undefined ? scrubbedDetail({ stdout: init.stdout }, withPassphraseSpellings(S.secrets, await readFile(S.passFile, "utf8").catch(() => ""))) : "");
  const writes = S.proxy.log.filter((entry) => entry.mutating && entry.command === "files/write");
  check("step 1: init wrote only keyslots.json to the node", writes.length > 0 && writes.every((entry) => entry.arg === `${S.demoRoot}/keyslots.json`), writes.map((entry) => entry.arg).join(", "));
}

async function firstPublishA(S) {
  const first = await publishAs(S, S.A, "publish #1 (device A)");
  check("publish #1: sequence 1, nothing removed, every published file written", first.summary.sequence === 1 && first.summary.removed === 0 && (first.summary.written ?? 0) >= MIN_PUBLISHED_FILES, `${first.summary.written} written, sequence ${first.summary.sequence}`);
  S.root1 = first.summary.rootCid;
  const keyId = (await S.client.keyList()).find((key) => key.name === KEY)?.id;
  check(`publish #1: the owned key ${KEY} exists on the node after the publish`, typeof keyId === "string" && keyId !== "");
  S.keyId = keyId;
  const { root, manifest } = await readNodeManifest(S.view);
  await checkNameAtRoot(S.view, "publish #1", keyId, root);
  check("publish #1: the authenticated manifest has sequence 1, the vault id init printed and the published paths", manifest.sequence === 1 && S.view.vaultId === S.vaultId && Object.keys(manifest.files).length >= MIN_PUBLISHED_FILES, `sequence ${manifest.sequence}, ${Object.keys(manifest.files).length} paths`);
  check("publish #1: the root CID the CLI printed is the immutable root the node holds", S.root1 === root, `${S.root1} vs ${root}`);
  S.manifest1 = manifest;
  S.digest1 = await publishedDigest(S.A.vault, Object.keys(manifest.files));
  return keyId;
}

// ---- step 2: B's first pull -----------------------------------------------------------------------------------------

async function declinedFirstPull(S) {
  out("\n-- step 2a: the first pull of B is declined (no terminal, no --accept-first-pull) --");
  const { run, trace } = await pullAs(S, S.B, { extra: ["--expect-vault-id", S.vaultId, "--expect-min-sequence", "1"] });
  check("declined first pull: exit 1 with the stop message \"the first pull was declined; nothing was written\" (a child has no terminal, so the question is answered no)", run.code === 1 && /pull stopped: the first pull was declined; nothing was written/.test(run.stderr), `exit ${run.code}: ${firstLine(run.stderr)}`);
  pullTraceCheck(S, "declined first pull", trace);
  const after = await treeDigest(S.B.vault);
  if (tamperOnce(S, "declined-writes")) after.set("notes/leaked.md", "planted by --tamper declined-writes");
  const outside = [...after.keys()].filter((path) => !path.startsWith(".ipfs-sync/"));
  check("declined first pull: no vault file and no fixture marker was written", outside.length === 0, outside.slice(0, 3).join(", "));
  const kept = [...after.keys()].filter((path) => /^\.ipfs-sync\/(?:state|keyslots)\./.test(path));
  check("declined first pull: no state file and no key-slot copy was written", kept.length === 0, kept.join(", "));
  const floor = join(S.B.stateHome, "ipfs-sync", "sequence-floor.json");
  check("declined first pull: no sequence floor was written in the device's per-user store", !(await exists(floor)));
}

async function acceptedFirstPull(S) {
  out("\n-- step 2b: the first pull of B is accepted (--accept-first-pull, --expect-vault-id, --expect-min-sequence) --");
  const { run, trace, summary } = await pullAs(S, S.B, { extra: ["--accept-first-pull", "--expect-vault-id", S.vaultId, "--expect-min-sequence", "1"] });
  const paths = Object.keys(S.manifest1.files);
  check("first pull: exits 0 and prints no passphrase", run.code === 0 && !run.leaked, firstLine(run.stderr) || `${run.ms} ms`);
  check(`first pull: sequence 1, every one of the ${paths.length} published files fetched, none unchanged, no conflict, no failure`, summary.sequence === 1 && summary.fetched === paths.length && summary.unchanged === 0 && summary.conflicts === 0 && summary.integrityFailed === 0 && summary.unfetched === 0, `${summary.fetched} fetched, ${summary.unchanged} unchanged, ${summary.conflicts} conflicts, ${summary.integrityFailed} integrity-failed, ${summary.unfetched} unfetched`);
  const planted = tamperOnce(S, "pull-writes") ? { command: "files/write", mutating: true, allowed: true, arg: `${S.demoRoot}/planted-by-tamper` } : undefined;
  pullTraceCheck(S, "first pull", trace, planted);
  const theirs = await publishedDigest(S.B.vault, paths);
  if (tamperOnce(S, "hash-mismatch")) theirs.set(paths[0], sha256("one byte of this file differs"));
  const mismatches = paths.filter((path) => theirs.get(path) !== S.digest1.get(path) || theirs.get(path) !== S.manifest1.files[path].sha256);
  out(`      sha256 of the ${paths.length} published files in B against A's and the manifest's: ${mismatches.length} mismatches`);
  check(`first pull: every file's sha256 in B equals A's and the manifest's (${mismatches.length} mismatches)`, mismatches.length === 0, mismatches.slice(0, 3).join(", "));
  const present = (await walkFiles(S.B.vault)).map((file) => file.path);
  const extra = present.filter((path) => !(path in S.manifest1.files));
  check("first pull: B holds exactly the published paths and no fixture marker, nothing else", extra.length === 0 && !present.includes(".ipfs-sync-fixture"), extra.slice(0, 3).join(", "));
  const state = await readLocalState(S.B.vault, S.demoRoot);
  check("first pull: B recorded state (sequence 1, complete), the key-slot copy and the floor", state?.highestSequence === 1 && state.complete === true && (await exists(join(S.B.vault, ".ipfs-sync")))
    && (await exists(join(S.B.stateHome, "ipfs-sync", "sequence-floor.json"))), `state sequence ${state?.highestSequence}`);
}

// ---- step 3: both edit, A publishes, B pulls, B publishes, A pulls --------------------------------------------------

async function twoDeviceEdits(S) {
  out("\n-- step 3: A and B edit, A publishes, B pulls, B publishes, A pulls --");
  const aOnly = await appendNote(S.A.vault, EDIT_A_ONLY, "\nedit by device A only\n");
  const aBoth = await appendNote(S.A.vault, EDIT_BOTH, "\nedit by device A, same file\n");
  const bOnly = await appendNote(S.B.vault, EDIT_B_ONLY, "\nedit by device B only\n");
  const bBoth = await appendNote(S.B.vault, EDIT_BOTH, "\nedit by device B, same file\n");
  const publishA = await publishAs(S, S.A, "publish #2 (device A)", { written: 2, removed: 0, sequence: 2 });
  const second = await readNodeManifest(S.view);
  check("publish #2: the authenticated manifest has sequence 2 and the two edited notes' hashes", second.manifest.sequence === 2 && second.manifest.files[EDIT_A_ONLY].sha256 === sha256(aOnly) && second.manifest.files[EDIT_BOTH].sha256 === sha256(aBoth));
  S.manifest2 = second.manifest;
  S.root2 = publishA.summary.rootCid;

  const pulled = await pullAs(S, S.B, { extra: ["--expect-min-sequence", "2"] });
  const { run, trace, summary } = pulled;
  check("pull #2 (device B): exits 0 and prints no passphrase", run.code === 0 && !run.leaked, `exit ${run.code}: ${firstLine(run.stderr)}`);
  pullTraceCheck(S, "pull #2", trace);
  check("pull #2: sequence 2; the same-file edit made exactly one conflict copy (dated name, next to the original)", summary.sequence === 2 && summary.conflicts === 1 && summary.conflictPairs.length === 1 && summary.conflictPairs[0].path === EDIT_BOTH && CONFLICT_COPY.test(summary.conflictPairs[0].copy), JSON.stringify(summary.conflictPairs));
  const copyPath = summary.conflictPairs[0]?.copy ?? "";
  const bFiles = await publishedDigest(S.B.vault, [EDIT_A_ONLY, EDIT_B_ONLY, EDIT_BOTH, copyPath]);
  check("pull #2: A's edit to its own file arrived; B's edit to its own file is kept (reported as locally modified)", bFiles.get(EDIT_A_ONLY) === sha256(aOnly) && bFiles.get(EDIT_B_ONLY) === sha256(bOnly) && summary.locallyModified === 1 && run.stdout.includes(`locally modified ${EDIT_B_ONLY}`), `locally modified ${summary.locallyModified}`);
  check("pull #2: the file edited on both sides holds the node's text, and the conflict copy holds B's text", bFiles.get(EDIT_BOTH) === sha256(aBoth) && bFiles.get(copyPath) === sha256(bBoth) && DAY_PATTERN.test(copyPath));
  S.conflictCopy = copyPath;

  await setMarker(S.B.vault, "fixture");
  const publishB = await publishAs(S, S.B, "publish #3 (device B, from its pulled state; marker set to `fixture` by hand)", { written: 2, removed: 0, sequence: 3 });
  const third = await readNodeManifest(S.view);
  await checkNameAtRoot(S.view, "publish #3", S.keyId, third.root);
  const stateB = await readLocalState(S.B.vault, S.demoRoot);
  const devices = stateB?.devicesSeen ?? [];
  check("publish #3: the manifest's sequence is one above A's, it carries device B's label, and the conflict copy is in it", third.manifest.sequence === 3 && third.manifest.device.startsWith(`${DEVICE_B}-`) && third.manifest.files[copyPath] !== undefined, `sequence ${third.manifest.sequence}, device ${third.manifest.device}`);
  check("publish #3: B's devicesSeen holds both devices (A's and B's labels with their id suffixes)", devices.length === 2 && devices.some((name) => name.startsWith(`${DEVICE_A}-`)) && devices.some((name) => name.startsWith(`${DEVICE_B}-`)), devices.join(", "));
  const names = await listBlobNames(S.client, third.root);
  const lost = Object.entries(S.manifest2.files).filter(([, entry]) => !names.has(entry.blob));
  check(`publish #3: no blob of A was removed (${Object.keys(S.manifest2.files).length} blobs of the sequence-2 manifest are all still listed; ${publishB.summary.removed} removed)`, lost.length === 0 && publishB.summary.removed === 0, lost.slice(0, 2).map(([path]) => path).join(", "));
  S.manifest3 = third.manifest;
  S.root3 = third.root;

  const back = await pullAs(S, S.A, { extra: ["--expect-min-sequence", "3"] });
  check("pull #3 (device A): exits 0, sequence 3, B's edit and the conflict copy arrive, nothing conflicts", back.run.code === 0 && back.summary.sequence === 3 && back.summary.fetched === 2 && back.summary.conflicts === 0, `exit ${back.run.code}: ${back.summary.fetched} fetched, ${back.summary.conflicts} conflicts, ${firstLine(back.run.stderr)}`);
  pullTraceCheck(S, "pull #3", back.trace);
  const paths = Object.keys(S.manifest3.files);
  const mine = await publishedDigest(S.A.vault, paths);
  const theirs = await publishedDigest(S.B.vault, paths);
  const apart = paths.filter((path) => mine.get(path) !== theirs.get(path) || mine.get(path) !== S.manifest3.files[path].sha256);
  check(`pull #3: A sees B's edit and every one of the ${paths.length} published files equals B's and the manifest's (${apart.length} mismatches)`, mine.get(EDIT_B_ONLY) === sha256(bOnly) && apart.length === 0, apart.slice(0, 3).join(", "));
  const stateA = await readLocalState(S.A.vault, S.demoRoot);
  check("pull #3: A's devicesSeen holds device B and its recorded sequence is 3", stateA?.highestSequence === 3 && (stateA.devicesSeen ?? []).some((name) => name.startsWith(`${DEVICE_B}-`)), `sequence ${stateA?.highestSequence}`);
}

// ---- step 4: replay and restore -------------------------------------------------------------------------------------

async function replayAndRestore(S) {
  out("\n-- step 4: replay of an older root, and a deliberate restore --");
  const before = await treeDigest(S.B.vault);
  const refused = await pullAs(S, S.B, { extra: ["--root-cid", S.root1] });
  const run = tamperOnce(S, "replay-accepted") ? { ...refused.run, code: 0, stderr: "" } : refused.run;
  check("replay by --root-cid of A's sequence-1 root (a read-only request) without --allow-rollback: refused with exit 1 and the message that names the flag", run.code === 1 && /pull stopped: the target has sequence 1 but this device has recorded sequence 3/.test(run.stderr) && /--allow-rollback/.test(run.stderr), `exit ${run.code}: ${firstLine(run.stderr)}`);
  pullTraceCheck(S, "replay by --root-cid", refused.trace);
  check("replay by --root-cid: no file in B and no state of B changed", sameDigest(before, await treeDigest(S.B.vault)));

  if (S.stub === undefined) {
    skip("replay by name: the stub's name is set to the older root and B pulls by name", "runs against the local stub only; the shared node's name is never repointed to an older root");
  } else {
    const original = S.stub.node.published.get(S.keyId);
    S.stub.node.published.set(S.keyId, `/ipfs/${S.root1}`);
    const byName = await pullAs(S, S.B);
    S.stub.node.published.set(S.keyId, original);
    check("replay by name (stub: the name points at the sequence-1 root): refused with exit 1 and the older-sequence message", byName.run.code === 1 && /the node serves sequence 1 but this device has recorded sequence 3/.test(byName.run.stderr), `exit ${byName.run.code}: ${firstLine(byName.run.stderr)}`);
    check("replay by name: no file in B and no state of B changed, and no request mutated the stub", sameDigest(before, await treeDigest(S.B.vault)) && pullTraceProblems(byName.trace).length === 0);
    check("replay by name: the stub's name was put back to the real root afterwards", S.stub.node.published.get(S.keyId) === original);
  }

  const restored = await pullAs(S, S.B, { extra: ["--root-cid", S.root1, "--allow-rollback"] });
  check("restore by --root-cid --allow-rollback: exits 0 and says restore never deletes and the recorded highest sequence is unchanged", restored.run.code === 0 && /note: restore of sequence 1:/.test(restored.run.stdout) && /not removed/.test(restored.run.stdout), `exit ${restored.run.code}: ${firstLine(restored.run.stderr)}`);
  pullTraceCheck(S, "restore", restored.trace);
  const files = await publishedDigest(S.B.vault, [EDIT_A_ONLY, EDIT_B_ONLY, EDIT_BOTH, S.conflictCopy]);
  check("restore: the sequence-1 content is back in the three edited files and the conflict copy (a file the restored version does not have) is kept", [EDIT_A_ONLY, EDIT_B_ONLY, EDIT_BOTH].every((path) => files.get(path) === S.digest1.get(path)) && files.get(S.conflictCopy) !== "absent");
  const state = await readLocalState(S.B.vault, S.demoRoot);
  check("restore: the recorded highest sequence stays 3, the baseline stays sequence 3, and restoredFrom is 1", state?.highestSequence === 3 && state.sequence === 3 && state.restoredFrom === 1, `highest ${state?.highestSequence}, sequence ${state?.sequence}, restoredFrom ${state?.restoredFrom}`);
}

export async function sharedPhase(S) {
  out("\n== two-device phase: A publishes, B (empty directory) pulls, edits, second-device publish, replay, restore ==");
  await prepareVaultA(S);
  out("\n-- step 1: device A: init and publish #1 --");
  await initVaultA(S);
  await firstPublishA(S);
  S.B.cli = makeCliRunner({ tb: S.tb, cwd: S.cwd, apiUrl: S.apiUrl, configFile: S.B.configFile, demoRoot: S.demoRoot, ownedFlags: ["--owned-key", S.keyId], secrets: () => S.secrets, cli: S.cliPath, device: DEVICE_B, stateHome: S.B.stateHome, localStub: S.opts.localStub });
  await declinedFirstPull(S);
  await acceptedFirstPull(S);
  await twoDeviceEdits(S);
  await replayAndRestore(S);
}

/** Device A's runner and the directories of both devices. B's runner is built after publish #1, when the owned key's ID is known. */
export async function prepareDevices(S, configFileA) {
  await mkdir(S.B.vault, { recursive: true });
  await mkdir(S.A.stateHome, { recursive: true });
  await mkdir(S.B.stateHome, { recursive: true });
  S.A.cli = makeCliRunner({ tb: S.tb, cwd: S.cwd, apiUrl: S.apiUrl, configFile: configFileA, demoRoot: S.demoRoot, ownedFlags: S.ownedFlags, secrets: () => S.secrets, cli: S.cliPath, device: DEVICE_A, stateHome: S.A.stateHome, localStub: S.opts.localStub });
}
