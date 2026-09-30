// The dry run: the plan and offline self-checks, no request.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { assertEffectiveTarget } from "./children.mjs";
import { BLOB_HEADER_BYTES, DEMO_PARENT, EXIT_FAILED, EXIT_OK, KEY, RUN_ID_PATTERN, Refusal } from "./constants.mjs";
import { RPC_ALLOWLIST, buildLargeNote, byteEntropy, canonicalJson, childEnv, demoRootFor, newRunId, sha256 } from "./policy.mjs";
import { check, checks, note, out } from "./report.mjs";
import { buildToolbox, checkBuildFresh } from "./toolbox.mjs";

// ======================================================================================================================
// Dry run: the plan and offline self-checks, no request
// ======================================================================================================================

const PLAN = [
  "1. build guard: dist/cli/ipfs-sync.mjs must exist and be newer than cli/ and src/ (this script never builds)",
  "2. read-only snapshot of the node: files/ls of /obsidian-vault-sync and /obsidian-vault-sync/mvp06-demo, key/list; refuse if the owned key is not recorded",
  "3. start the loopback forwarding proxy; self-test that out-of-policy requests are refused and not forwarded",
  "4. fixture vault + 256 KiB repetitive note; record titles, paths, folders, body words as plaintext needles",
  "5. `init --passphrase-file <per-run temp path>`; then `publish` with IPFS_SYNC_PASSPHRASE_FILE: sequence 1",
  "6. read-only inspection of the immutable root: one-level listings, layout rule with the anomaly rule, no plaintext anywhere, magic/version/length, entropy >= 7.99, test-only unwrap + key-material search, manifest content",
  "7. edit one note, publish: `1 written, 0 removed`, sequence 2, only that blob's CID changed, second history file",
  "8. three killed publishes through the proxy (before the manifest write, between manifest.enc and the history file, after the history file) each followed by a rerun: sequence +1, no `another device` refusal, consistent node",
  "9. refusals with the proxy's own trace: wrong passphrase, non-fixture directory with and without a passphrase, pulled-fixture marker (all with an empty trace), publish against an empty root (no mutation, points to init)",
  "10. hostile objects against a script-hosted stub node: oversize keyslots.json and manifest.enc, keyslots.json differing from the local copy, modified commitment, 4 GiB memory parameter, older genuine manifest with and without --repair; each refused, no write",
  "11. Argon2id timing (three runs, largest event-loop gap) and a one-bit-flip tamper check on a fetched blob",
  "12. node-state comparison: only the demo folder under /obsidian-vault-sync/mvp06-demo and at most the key obsidian-vault-sync changed; proxy audit",
];

export async function dryRun(opts) {
  out("feature operation mvp-06: DRY RUN (no request is sent, no socket is opened)\n");
  out(PLAN.join("\n"));
  out(`\ndemo root pattern      ${DEMO_PARENT}/<runid>   (runid ${RUN_ID_PATTERN}, e.g. ${newRunId()})`);
  out(`owned key              ${KEY} (the only key ever named; key/gen only for it)`);
  out(`proxy allowlist        ${RPC_ALLOWLIST.join(", ")}`);
  out("proxy also forwards   GET|HEAD /ipfs/<cid>[/path]");
  out("never sent            key/rm, key/rename, key/import, key/export, pin/rm, files/mv, files/cp, any path outside the demo root, anything naming /obsidian-vault-staging");
  out("direct reads          files/ls, files/stat, ls, key/list, name/resolve, gateway GET (read-only view of the shared client)");
  out(`cleanup (opt-in)       files/stat + files/rm -r on ${DEMO_PARENT}/<runid> only`);
  const fresh = checkBuildFresh();
  note(fresh.ok ? "dist/cli/ipfs-sync.mjs is newer than its sources" : `build guard would refuse a real run: ${fresh.message}`);
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop06-dry-"));
  try {
    const tb = await buildToolbox(work);
    check("dry run: the toolbox bundle (crypto, test-only unwrap, sync manifest codec, CLI config loader, stub node) builds and loads", typeof tb.unwrapVckForTest === "function" && typeof tb.createFakeNode === "function" && typeof tb.effectiveConfig === "function");
    const config = join(work, "config.json");
    await writeFile(config, `${JSON.stringify({ ownedKeys: [] })}\n`);
    const demoRoot = demoRootFor(newRunId());
    const argv = ["publish", join(work, "vault"), "--config", config, "--rpc-url", "http://127.0.0.1:9", "--gateway-url", "http://127.0.0.1:9", "--mfs-root", demoRoot, "--key", KEY];
    await assertEffectiveTarget(tb, argv, childEnv({ IPFS_SYNC_RPC_URL: "https://elsewhere.example", IPFS_SYNC_MFS_ROOT: "/elsewhere", IPFS_SYNC_PASSPHRASE: "x", PATH: process.env.PATH }, {}), { url: "http://127.0.0.1:9", demoRoot });
    check("dry run: with hostile IPFS_SYNC_* variables in the environment the effective API URL is still the loopback target (variables stripped, flags win)", true);
    const rejected = await assertEffectiveTarget(tb, argv, {}, { url: "http://127.0.0.1:10", demoRoot }).then(() => false, (error) => error instanceof Refusal);
    check("dry run: a child whose effective API URL is not the intended loopback target is refused before spawn", rejected);
    await cryptoSelfCheck(tb);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return checks.every((entry) => entry.passed) ? EXIT_OK : EXIT_FAILED;
}

/** Offline: create key slots, unwrap with the test-only hook, corrupt the commitment, round-trip and flip a bit in a blob. */
async function cryptoSelfCheck(tb) {
  const passphrase = tb.generatePassphrase();
  const created = await tb.createKeySlots({ passphrase });
  const raw = await tb.unwrapVckForTest(created.bytes, passphrase);
  check("dry run: the test-only unwrap recovers a vault content key from freshly created key slots", raw.vck.length === 32 && raw.vaultId.length === 16);
  const genuine = JSON.parse(Buffer.from(created.bytes).toString("utf8"));
  check("dry run: this script's canonical-JSON writer reproduces the product's keyslots.json bytes exactly (so a tampered document is refused for the tamper, not for its form)", canonicalJson(genuine) === Buffer.from(created.bytes).toString("utf8"));
  const corrupted = JSON.parse(Buffer.from(created.bytes).toString("utf8"));
  corrupted.slots[0].commit = `${corrupted.slots[0].commit[0] === "A" ? "B" : "A"}${corrupted.slots[0].commit.slice(1)}`;
  const refused = await tb.unwrapVckForTest(Buffer.from(canonicalJson(corrupted)), passphrase).then(() => false, () => true);
  check("dry run: a modified commitment makes the test-only unwrap fail (it cannot bypass the commitment check)", refused);
  const path = "notes/example.md";
  const name = await tb.blobNameFor(created.keys, path);
  const data = Buffer.from(buildLargeNote(4096));
  const { blob, fileId } = await tb.encryptBlobBytes(created.keys, name, data);
  const flipped = Buffer.from(blob);
  flipped[BLOB_HEADER_BYTES + 20] ^= 1;
  const decrypted = await tb.decryptBlobBytes(created.keys, name, Buffer.from(blob), fileId, data.length);
  const failed = await tb.decryptBlobBytes(created.keys, name, flipped, fileId, data.length).then(() => false, () => true);
  check("dry run: a blob round-trips and a one-bit flip fails to decrypt; its body entropy is high", sha256(decrypted) === sha256(data) && failed && blob.length === tb.blobLength(data.length) && byteEntropy(blob.subarray(BLOB_HEADER_BYTES)) > 7.9);
  tb.wipe(passphrase, raw.vck);
}
