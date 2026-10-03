// The dry run: the plan and offline self-checks, no request.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { assertEffectiveTarget } from "./children.mjs";
import { BASE, CLI, DEMO_PARENT, EXIT_FAILED, EXIT_OK, KEY, RUN_ID_PATTERN, STAGING_ROOT, Refusal } from "./constants.mjs";
import { PULL_READ_COMMANDS, RPC_ALLOWLIST, childEnv, cleanupTarget, decideRequest, demoRootFor, newRunId, pullTraceProblems } from "./policy.mjs";
import { check, checks, note, out } from "./report.mjs";
import { buildToolbox, checkBuildFresh } from "./toolbox.mjs";

// ======================================================================================================================
// Dry run: the plan and offline self-checks, no request
// ======================================================================================================================

const PLAN = [
  "1. build guard: dist/cli/ipfs-sync.mjs must exist and be newer than cli/ and src/ (this script never builds); its sha256 is printed and recorded",
  "2. read-only snapshot of the node: files/ls of /obsidian-vault-sync and /obsidian-vault-sync/mvp07a-demo, key/list, name/resolve of the owned key; the pointer line is printed before the first mutation; on the shared-node path only the node's never-published answer is accepted as unresolved (anything else is retried, then refused unless --accept-unresolved-pointer)",
  "3. start the loopback forwarding proxy; self-test, against a second proxy whose upstream is the dead address 127.0.0.1:9, that out-of-policy requests are refused and not forwarded",
  "4. device A: fixture vault; `init --passphrase-file <per-run path>`; `publish` (sequence 1) to the demo root with the own key",
  "5. device B: an EMPTY directory pulls; the first pull is declined first (no terminal, no --accept-first-pull: no state, no floor, no key-slot copy, no file), then accepted with --expect-vault-id and --expect-min-sequence; every file's sha256 equals A's; the pull's proxy log holds reads only",
  "6. A edits two files and B edits two (one of them the same file); A publishes; B pulls (own edit kept, A's edit arrives, dated conflict copy for the same-file edit, the node's text at the path); B publishes from its pulled state (sequence 3, devicesSeen holds both devices, no blob of A removed); A pulls and sees B's edit",
  "7. replay: a pull by --root-cid of A's sequence-1 root is refused without --allow-rollback (read-only request); on the stub only, the name is set to the older root and a pull by name is refused",
  "8. restore: the same --root-cid with --allow-rollback restores the sequence-1 content, keeps the files it does not have, leaves the recorded highest sequence at 3",
  "9. hostile and forked objects against a script-hosted stub node, never the shared node: forged manifest, wrong vault, unmet minimum sequence, flipped blob bit, planted manifest.json, fork (refused by name; --resolve-fork is declined without a terminal)",
  "10. node-state comparison: only the demo folder under /obsidian-vault-sync/mvp07a-demo and at most the key obsidian-vault-sync changed; proxy audit; dist sha256 recomputed (a check); the owned key's pointer is printed before and after, with the restore command",
];

export async function dryRun(opts) {
  out("feature operation mvp-07a: DRY RUN (no request is sent, no socket is opened)\n");
  out(PLAN.join("\n"));
  out(`\ndemo root pattern      ${DEMO_PARENT}/<runid>   (runid ${RUN_ID_PATTERN}, e.g. ${newRunId()})`);
  out(`owned key              ${KEY} (the only key ever named; key/gen only for it)`);
  out(`proxy allowlist        ${RPC_ALLOWLIST.join(", ")}`);
  out("proxy also forwards   GET|HEAD /ipfs/<cid>[/path]");
  out(`pull read set          ${PULL_READ_COMMANDS.join(", ")} (a pull's slice of the proxy log must hold nothing else)`);
  out("never sent            key/rm, key/rename, key/import, key/export, pin/rm, files/mv, files/cp, any path outside the demo root, anything naming /obsidian-vault-staging");
  out("direct reads          files/ls, files/stat, ls, key/list, name/resolve, gateway GET (read-only view of the shared client)");
  out(`cleanup (opt-in)       files/stat + files/rm -r on ${DEMO_PARENT}/<runid> only`);
  const cli = opts.cli ?? CLI;
  const fresh = checkBuildFresh(cli);
  note(fresh.ok ? `${opts.cli === undefined ? "dist/cli/ipfs-sync.mjs" : cli} is newer than its sources` : `build guard would refuse a real run: ${fresh.message}`);
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop07a-dry-"));
  try {
    const tb = await buildToolbox(work);
    check("dry run: the toolbox bundle (crypto, test-only unwrap, manifest decoder, CLI config loader, stub node) builds and loads", typeof tb.unwrapVckForTest === "function" && typeof tb.decodeManifestFile === "function" && typeof tb.createFakeNode === "function" && typeof tb.effectiveConfig === "function");
    const config = join(work, "config.json");
    await writeFile(config, `${JSON.stringify({ ownedKeys: [] })}\n`);
    const demoRoot = demoRootFor(newRunId());
    const base = ["--config", config, "--rpc-url", "http://127.0.0.1:9", "--gateway-url", "http://127.0.0.1:9", "--mfs-root", demoRoot, "--key", KEY];
    for (const command of ["publish", "pull"]) {
      const argv = [command, join(work, "vault"), ...base];
      await assertEffectiveTarget(tb, argv, childEnv({ IPFS_SYNC_RPC_URL: "https://elsewhere.example", IPFS_SYNC_MFS_ROOT: "/elsewhere", IPFS_SYNC_PASSPHRASE: "x", PATH: process.env.PATH }, {}), { url: "http://127.0.0.1:9", demoRoot });
    }
    check("dry run: for publish and pull, with hostile IPFS_SYNC_* variables in the environment, the effective API URL, gateway, MFS root and key are still the intended loopback target (variables stripped, flags win)", true);
    const rejected = await assertEffectiveTarget(tb, ["pull", join(work, "vault"), ...base], {}, { url: "http://127.0.0.1:10", demoRoot }).then(() => false, (error) => error instanceof Refusal);
    check("dry run: a child whose effective API URL is not the intended loopback target is refused before spawn", rejected);
    const outside = await assertEffectiveTarget(tb, ["pull", join(work, "vault"), ...base.map((value) => (value === demoRoot ? `${BASE}/mvp06-demo/elsewhere` : value))], {}, { url: "http://127.0.0.1:9", demoRoot }).then(() => false, (error) => error instanceof Refusal);
    check("dry run: a child whose MFS root lies outside the demo root (another operation's folder) is refused before spawn", outside);
    policySelfCheck(demoRoot);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return checks.every((entry) => entry.passed) ? EXIT_OK : EXIT_FAILED;
}

/** Offline: the proxy policy decides without a socket. */
function policySelfCheck(demoRoot) {
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const decide = (command, init) => decideRequest({ method: "POST", pathname: `/api/v0/${command}`, params: new URLSearchParams(init) }, { demoRoot, knownCids: new Set() });
  const refused = [
    decide("key/rm", { arg: KEY }),
    decide("pin/rm", { arg: cid }),
    decide("files/mv", { arg: `${demoRoot}/a` }),
    decide("key/gen", { arg: "obsidian-vault" }),
    decide("files/write", { arg: `${STAGING_ROOT}/x` }),
    decide("files/write", { arg: `${BASE}/mvp06-demo/x` }),
  ];
  check("dry run: the policy refuses key/rm, pin/rm, files/mv, a foreign key, the staging root and the mvp06-demo folder", refused.every((verdict) => !verdict.allowed));
  const reads = [
    decide("key/list", {}),
    decide("name/resolve", { arg: `/ipns/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8`, nocache: "true" }),
    decide("ls", { arg: `/ipfs/${cid}/manifests` }),
    decide("files/stat", { arg: demoRoot }),
    decideRequest({ method: "GET", pathname: `/ipfs/${cid}/manifest.enc`, params: new URLSearchParams() }, { demoRoot, knownCids: new Set() }),
  ];
  check("dry run: the policy allows exactly the reads a pull sends (key/list, name/resolve, ls of /ipfs/<cid>, files/stat, gateway GET) and none of them is mutating", reads.every((verdict) => verdict.allowed && !verdict.mutating));
  check("dry run: the pull trace audit accepts reads and reports a mutating request", pullTraceProblems([{ command: "gateway", mutating: false, allowed: true }]).length === 0 && pullTraceProblems([{ command: "files/write", mutating: true, allowed: true }]).length === 1);
  check("dry run: the cleanup target is strictly below the demo parent and built from a valid run identifier only", cleanupTarget("abcd1234") === `${DEMO_PARENT}/abcd1234` && (() => { try { cleanupTarget("../x"); return false; } catch { return true; } })());
}
