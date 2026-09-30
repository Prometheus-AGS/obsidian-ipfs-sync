// The shared-node phase: init, encrypted publishes, killed publishes and their reruns, refusals, Argon2id timing, node comparison, proxy audit.
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { scrub } from "./children.mjs";
import { BASE, BLOB_HEADER_BYTES, DEMO_PARENT, KEY, LARGE_NOTE, LARGE_NOTE_BYTES, MIN_PUBLISHED_FILES, REPO, STAGING_ROOT, UNLOCK_GAP_TARGET_MS, UNLOCK_TARGET_MS } from "./constants.mjs";
import { inspectRoot } from "./inspection.mjs";
import { buildLargeNote, firstLine, parsePublishOutput, plaintextNeedles, scrubbedDetail, sha256 } from "./policy.mjs";
import { check, note, out, skip } from "./report.mjs";
import { diffMaps, editNote, exists, generateVault, nodeSnapshot, vaultPath, walkFiles } from "./workspace.mjs";

// ======================================================================================================================
// Shared-node phase
// ======================================================================================================================

async function prepareVault(S) {
  const generated = await generateVault(S.vault);
  if (!check("step 1: fixture vault generated (marker `fixture`)", generated.code === 0 && (await exists(join(S.vault, ".ipfs-sync-fixture"))), firstLine(generated.text))) throw new Error("no fixture vault, nothing further can run");
  await writeFile(vaultPath(S.vault, LARGE_NOTE), buildLargeNote());
  S.files = await walkFiles(S.vault);
  S.plainNeedles = plaintextNeedles(S.files);
  const large = S.files.find((file) => file.path === LARGE_NOTE);
  check(`step 1: the repetitive note is exactly ${LARGE_NOTE_BYTES} bytes and ${S.plainNeedles.length} plaintext needles (titles, paths, folders, body words) are recorded`, large?.size === LARGE_NOTE_BYTES && S.plainNeedles.length > 20, `${S.files.length} files`);
  S.proxy.setNeedles(S.plainNeedles);
}

async function loadPassphrase(S) {
  const text = await readFile(S.passFile, "utf8");
  const info = await stat(S.passFile);
  check("step 2: the passphrase file is 0600, has the generated 5x5 shape and is outside the repository", /^[A-Z2-7]{5}(?:-[A-Z2-7]{5}){4}\n$/.test(text) && (process.platform === "win32" || (info.mode & 0o077) === 0) && !S.passFile.startsWith(REPO));
  S.passphrase = S.tb.canonicalizePassphrase(Buffer.from(text.trimEnd(), "utf8"));
  S.secrets.push(text.trimEnd(), text.trimEnd().replaceAll("-", ""));
  S.secretNeedles = [{ label: "passphrase (grouped)", bytes: Buffer.from(text.trimEnd()) }, { label: "passphrase (canonical)", bytes: Buffer.from(text.trimEnd().replaceAll("-", "")) }];
}

/** Failure detail for init, re-scrubbed with the passphrase read back from the file (the run's secrets are empty until init has written it). */
async function initFailureDetail(S, init) {
  const text = (await readFile(S.passFile, "utf8").catch(() => "")).trimEnd();
  return scrubbedDetail(init, [...S.secrets, text, text.replaceAll("-", "")]);
}

async function initVault(S) {
  const init = await S.cli("init", [S.vault], { extra: ["--passphrase-file", S.passFile] });
  if (!check("step 2: `init --passphrase-file <per-run temp path>` exits 0 and creates the vault", init.code === 0, init.code === 0 ? "" : await initFailureDetail(S, init))) throw new Error("init failed, nothing further can run");
  await loadPassphrase(S);
  S.proxy.setNeedles([...S.plainNeedles, ...S.secretNeedles]);
  const rescanned = scrub(init, S.secrets);
  check("step 2: init printed no passphrase (output scanned for both spellings)", !rescanned.leaked);
  const keyslots = S.proxy.log.filter((entry) => entry.mutating && entry.command === "files/write");
  check("step 2: init wrote only keyslots.json to the node", keyslots.length > 0 && keyslots.every((entry) => entry.arg === `${S.demoRoot}/keyslots.json`), keyslots.map((entry) => entry.arg).join(", "));
}

async function publishOnce(S, label, expected) {
  const run = await S.cli("publish", [S.vault], { passphraseFile: S.passFile });
  const summary = parsePublishOutput(run.stdout);
  check(`${label}: exits 0 and prints no passphrase`, run.code === 0 && !run.leaked, firstLine(run.stderr) || `${run.ms} ms`);
  if (expected !== undefined) check(`${label}: reports "${expected.written} written, ${expected.removed} removed" with sequence ${expected.sequence}`, summary.written === expected.written && summary.removed === expected.removed && summary.sequence === expected.sequence, `${summary.written} written, ${summary.removed} removed, sequence ${summary.sequence}`);
  return { run, summary };
}


async function readNodeSequence(S) {
  try {
    const root = (await S.client.filesStat(S.demoRoot)).cid;
    return (await S.tb.decodeManifestFile(S.keys, await S.client.gatewayFetch(root, "manifest.enc"))).sequence;
  } catch {
    return -1;
  }
}

async function resumeScenario(S, scenario, previous) {
  const { kind, note: path, describe } = scenario;
  const tag = `step 5 (${describe})`;
  const before = previous.manifest.sequence;
  const edited = await editNote(S, path, `\nedit for ${kind}\n`);
  // Tamper "resume-fails": on the first scenario only, the fault stays armed through the rerun, so the rerun cannot resume; it is lifted afterwards.
  const resumeFails = S.opts.tamper === "resume-fails" && kind === "before-manifest";
  S.proxy.setFault(kind, resumeFails);
  const killed = await S.cli("publish", [S.vault], { passphraseFile: S.passFile });
  const fired = S.proxy.faultFired();
  S.proxy.clearFault();
  check(`${tag}: the proxy dropped the connections at the planned point and the publish failed`, fired && killed.code !== 0, `${fired ? "fault fired" : "fault never fired"}, exit ${killed.code}`);
  const mid = await readNodeSequence(S);
  const expectedMid = kind === "before-manifest" ? before : before + 1;
  check(`${tag}: the node holds sequence ${expectedMid} after the kill`, mid === expectedMid, `sequence ${mid}`);
  const rerun = await S.cli("publish", [S.vault], { passphraseFile: S.passFile });
  const summary = parsePublishOutput(rerun.stdout);
  if (resumeFails) {
    S.proxy.liftFault();
    await S.cli("publish", [S.vault], { passphraseFile: S.passFile });
  }
  check(`${tag}: the rerun without the proxy fault exits 0 and does not refuse with "another device"`, rerun.code === 0 && !/another device/i.test(`${rerun.stdout}\n${rerun.stderr}`), firstLine(rerun.stderr) || `${summary.written} written, ${summary.removed} removed`);
  check(`${tag}: the rerun rewrites only what differs (at most one blob, no removal)`, (summary.written ?? 0) <= 1 && (summary.removed ?? 0) === 0, `${summary.written} written, ${summary.removed} removed`);
  const after = await inspectRoot(S, tag, { sequence: before + 1 });
  check(`${tag}: sequence advanced by exactly one (${before} to ${after.manifest?.sequence}), the edited note's hash is in the manifest, one history file per publish (${after.historyCount})`, after.manifest?.sequence === before + 1 && after.manifest.files[path]?.sha256 === sha256(edited) && after.historyCount === before + 1);
  return after;
}

const RESUMES = [
  { kind: "before-manifest", note: "notes/daily/2026-01-02.md", describe: "killed before the manifest write" },
  { kind: "between", note: "notes/daily/2026-01-03.md", describe: "killed between manifest.enc and the history file" },
  { kind: "after-history", note: "projects/alpha/tasks.md", describe: "killed after manifest and history, before pin and name publish" },
];

/** `keylessReads`: the refusal comes after the keyless idle check, which legitimately issues these read-only commands before it unlocks (finding: the design text says "empty trace"). */
export async function refusal(S, label, { vault, passphraseFile, mfsRoot, strictEmpty, keylessReads, mustSay }) {
  const mark = S.proxy.mark();
  const run = await S.cli("publish", [vault], { passphraseFile, mfsRoot });
  const trace = S.proxy.since(mark);
  check(`${label}: refused (nonzero exit, no crash)`, run.code !== 0 && !/unexpected error/.test(run.stderr), `exit ${run.code}: ${firstLine(run.stderr)}`);
  check(`${label}: no mutating request reached the node`, trace.filter((entry) => entry.mutating).length === 0, `${trace.length} request(s) in total`);
  if (strictEmpty) check(`${label}: the request trace is empty`, trace.length === 0, trace.map((entry) => entry.command).join(", "));
  if (keylessReads !== undefined) check(`${label}: the request trace holds only the keyless idle-check reads (${keylessReads.join(", ")}), no other command`, trace.every((entry) => keylessReads.includes(entry.command) && !entry.mutating), trace.map((entry) => entry.command).join(", "));
  if (mustSay !== undefined) check(`${label}: the message points to \`init\``, mustSay.test(`${run.stdout}\n${run.stderr}`), firstLine(run.stderr));
}

export async function refusals(S) {
  out("\n-- step 6: refusals with the proxy's own request trace --");
  const secrets = join(S.work, "secrets");
  const wrongFile = join(secrets, "wrong-passphrase.txt");
  // The idle fast path returns before unlocking when no file changed (by design); touching one file sends the run down the normal path, which unlocks.
  const touched = new Date();
  await utimes(vaultPath(S.vault, "notes/welcome.md"), touched, touched);
  const wrong = S.tb.generatePassphrase();
  await writeFile(wrongFile, `${S.tb.formatPassphrase(wrong)}\n`, { mode: 0o600, flag: "wx" });
  S.tb.wipe(wrong);
  await refusal(S, "wrong passphrase (local key-slot copy present)", { vault: S.vault, passphraseFile: wrongFile, keylessReads: ["files/stat", "key/list"] });
  const plain = join(S.work, "plain-directory");
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, "private.md"), "synthetic stand-in for a real note\n");
  await refusal(S, "non-fixture directory without a passphrase", { vault: plain, strictEmpty: true });
  await refusal(S, "non-fixture directory with a passphrase", { vault: plain, passphraseFile: S.passFile, strictEmpty: true });
  const pulled = join(S.work, "pulled-directory");
  await mkdir(pulled, { recursive: true });
  await writeFile(join(pulled, ".ipfs-sync-fixture"), "pulled-fixture\n");
  await writeFile(join(pulled, "note.md"), "synthetic pulled note\n");
  await refusal(S, "directory with a pulled-fixture marker", { vault: pulled, passphraseFile: S.passFile, strictEmpty: true });
  const empty = join(S.work, "empty-root-vault");
  await mkdir(empty, { recursive: true });
  await writeFile(join(empty, ".ipfs-sync-fixture"), "fixture\n");
  await writeFile(join(empty, "note.md"), "synthetic note\n");
  await refusal(S, "publish against an empty root with no vault", { vault: empty, passphraseFile: S.passFile, mfsRoot: `${S.demoRoot}/no-vault`, mustSay: /init/ });
}

function startGapSampler() {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 5);
    last = now;
  }, 5);
  return () => {
    clearInterval(timer);
    return Math.max(0, max);
  };
}

export async function argonAndTamper(S, final) {
  out("\n-- step 8: Argon2id timing and a local tamper check --");
  if (S.keys === undefined || S.keyslotsBytes === undefined) return skip("Argon2id timing and tamper check", "the vault keys were not recovered above");
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const stop = startGapSampler();
    const started = performance.now();
    const unlocked = await S.tb.unlockKeySlotsBytes(S.keyslotsBytes, S.passphrase);
    runs.push({ ms: Math.round(performance.now() - started), gap: Math.round(stop()), ok: unlocked.keys.vaultId === S.keys.vaultId });
  }
  check("step 8: three default-cost unlocks (64 MiB, t=3, p=1) succeed", runs.every((run) => run.ok), `slot m=${S.slotParams.m} t=${S.slotParams.t} p=${S.slotParams.p}`);
  out(`      Argon2id timing (wall ms / largest event-loop gap ms): ${runs.map((run) => `${run.ms}/${run.gap}`).join(", ")}`);
  const met = runs.every((run) => run.ms <= UNLOCK_TARGET_MS && run.gap <= UNLOCK_GAP_TARGET_MS);
  note(`design targets are at most ${UNLOCK_TARGET_MS} ms wall and ${UNLOCK_GAP_TARGET_MS} ms gap on the development machine: ${met ? "met" : "NOT MET, report to the lead (not a script failure)"}`);
  const entries = Object.entries(final.manifest.files).sort((a, b) => a[1].size - b[1].size);
  const [path, entry] = entries[0];
  const blob = final.blobs.get(entry.blob);
  const flipped = Buffer.from(blob);
  flipped[BLOB_HEADER_BYTES + 12 + Math.floor(Math.max(0, entry.size - 1) / 2)] ^= 0x01;
  const flippedFailed = await S.tb.decryptBlobBytes(S.keys, entry.blob, flipped, entry.fileId, entry.size).then(() => false, () => true);
  const plain = await S.tb.decryptBlobBytes(S.keys, entry.blob, Buffer.from(blob), entry.fileId, entry.size).catch(() => undefined);
  check("step 8: a fetched blob (the smallest file's) copied in memory with one bit flipped fails to decrypt; the unmodified copy decrypts to the local file's sha256", flippedFailed && plain !== undefined && sha256(plain) === S.files.find((file) => file.path === path)?.sha256);
}

export async function nodeComparison(S, before) {
  out("\n-- step 9: what the run changed on the node --");
  const after = await nodeSnapshot(S.client);
  const baseChanges = diffMaps(before.base, after.base);
  const parentChanges = diffMaps(before.demoParent, after.demoParent);
  const keyChanges = diffMaps(before.keys, after.keys);
  check(`only ${DEMO_PARENT} changed under ${BASE}`, baseChanges.every((name) => name === "mvp06-demo"), `changed: ${baseChanges.join(", ") || "none"}`);
  check(`only this run's folder ${S.runId} was added under ${DEMO_PARENT}`, parentChanges.every((name) => name === S.runId && !before.demoParent.has(name)), `changed: ${parentChanges.join(", ") || "none"}`);
  check(`no key was changed or removed; at most ${KEY} was added`, keyChanges.every((name) => name === KEY && !before.keys.has(name)), `changed: ${keyChanges.join(", ") || "none"}`);
}

export function proxyAudit(S) {
  out("\n-- proxy audit: every request the CLI sent, from the proxy's own log --");
  const log = S.proxy.log;
  const counts = new Map();
  for (const entry of log) counts.set(entry.command, (counts.get(entry.command) ?? 0) + 1);
  out(`      requests by RPC path: ${[...counts].map(([command, count]) => `${command} x${count}`).join(", ")}`);
  check("proxy: no request left the allowlist (no key/rm, no pin/rm, no foreign key, nothing outside the demo root, no staging root)", S.proxy.violations.length === 0, S.proxy.violations.slice(0, 3).map((entry) => `${entry.command}: ${entry.reason}`).join("; "));
  const mutating = log.filter((entry) => entry.mutating);
  check(`proxy: all ${mutating.length} mutating requests were files/write|rm|mkdir below ${S.demoRoot}, key/gen or name/publish of ${KEY}, or pin/add of a CID the node reported for the demo root`, mutating.every((entry) => entry.allowed) && log.every((entry) => !`${entry.arg ?? ""}`.includes(STAGING_ROOT)));
  check(`proxy: every name/publish used the key ${KEY}`, log.filter((entry) => entry.command === "name/publish").every((entry) => entry.key === KEY));
  const leaks = log.filter((entry) => entry.needle !== undefined);
  check("proxy: no request path, query or body carried a recorded plaintext title, path, folder name, body word or the passphrase", leaks.length === 0, leaks.slice(0, 2).map((entry) => `${entry.command} ${entry.needle}`).join("; "));
}

export async function sharedPhase(S) {
  out("\n== shared-node phase: init, encrypted publish, listings, ciphertext, resume, refusals ==");
  await prepareVault(S);
  await initVault(S);
  out("\n-- step 2: publish #1 --");
  const first = await publishOnce(S, "publish #1");
  check("publish #1: sequence 1, nothing removed, every published file written", first.summary.sequence === 1 && first.summary.removed === 0 && (first.summary.written ?? 0) >= MIN_PUBLISHED_FILES, `${first.summary.written} written, sequence ${first.summary.sequence}`);
  out("\n-- step 3: read-only inspection of the immutable root --");
  const one = await inspectRoot(S, "step 3", { sequence: 1, tamperPoint: "first" });
  check("step 3: publish #1 wrote as many files as the manifest lists", one.manifest !== undefined && first.summary.written === Object.keys(one.manifest.files).length);
  out("\n-- step 4: edit one note, publish again --");
  const edit = "notes/welcome.md";
  await editNote(S, edit, "\nsecond publish edit\n");
  await publishOnce(S, "publish #2", { written: 1, removed: 0, sequence: 2 });
  const two = await inspectRoot(S, "step 4", { sequence: 2, tamperPoint: "second" });
  if (one.manifest !== undefined && two.manifest !== undefined) {
    const changed = Object.keys(two.manifest.files).filter((path) => one.manifest.files[path]?.cid !== two.manifest.files[path].cid);
    check("step 4: only the edited note's blob CID changed and a second history file exists", changed.join(",") === edit && two.historyCount === 2, `changed: ${changed.join(", ") || "none"}; history files ${two.historyCount}`);
  }
  out("\n-- step 5: killed publishes and their reruns --");
  let latest = two;
  for (const scenario of RESUMES) if (latest.manifest !== undefined) latest = await resumeScenario(S, scenario, latest);
  await refusals(S);
  return latest;
}
