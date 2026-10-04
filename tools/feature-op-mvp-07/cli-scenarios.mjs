// The script-only CLI scenarios of task 4.7b (design decision 11 step 8), each on its own MFS root below the run's demo root, through the
// hash-bound CLI bundle as child processes and the confinement proxy: older root by name, restore by --root-cid, fork and --resolve-fork, rewrap
// and accept, increase-cost, and prune-history. A scenario records checks against assertion ids; it never throws past its own boundary.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withPassphraseSpellings } from "../feature-op-mvp-07a/policy.mjs";
import { appendNote, exists, readLocalState, sameDigest, setMarker, treeDigest, walkFiles } from "../feature-op-mvp-07a/workspace.mjs";
import { runHostile } from "./hostile-tools.mjs";
import { KEY } from "./constants.mjs";
import { firstLine, isWithin } from "./policy.mjs";
import { SEED_PATHS, openScenario, outcome } from "./scenario-kit.mjs";

export const OLDER_ROOT = "older-root-by-name-refused";
export const RESTORE = "restore-older-version";
export const FORK = "fork-resolved";
export const REWRAP = "rewrap-and-accept";
export const COST = "increase-cost";
export const PRUNE = "prune-history";
/** History files a prune must leave (the CLI always keeps at least this many), and the publishes the prune scenario makes. */
export const PRUNE_KEEP = 20;
export const PRUNE_ROUNDS = 25;

const message = (error) => firstLine(error instanceof Error ? error.message : String(error));
const noMutation = (trace) => trace.every((entry) => !entry.mutating);
const seed = { first: SEED_PATHS[0], second: SEED_PATHS[1], third: SEED_PATHS[2] };

/** Points the owned key at an immutable root the node already reported (the proxy allows only the owned key and such roots). */
export async function repointName(S, sc, cid) {
  const tools = await S.hostileTools();
  const mark = S.proxy.mark();
  const answer = await runHostile({ tools, op: "name-publish", input: { rpc: S.apiUrl, gateway: S.apiUrl, mfsRoot: sc.root, key: KEY, cid }, env: S.env, localStub: S.opts.localStub });
  const writes = S.proxy.since(mark).filter((entry) => entry.mutating);
  return { answer, onlyNamePublish: writes.length > 0 && writes.every((entry) => entry.command === "name/publish" && entry.key === KEY) };
}

/** Older root by name (refused) and restore by --root-cid (refused without the flag, restored with it, publish after is sequence + 1). */
export async function replayScenario(S, { add }) {
  S.t.out("\n-- older root by name, and restore by --root-cid --");
  try {
    const sc = await openScenario(S, "replay");
    const { primary } = await sc.setup();
    const root1 = sc.roots[0];
    await appendNote(primary.vault, seed.first, "\nversion two\n");
    const second = await sc.publish(primary);
    const root2 = second.summary.rootCid;
    add(OLDER_ROOT, "setup: publish #2 reports sequence 2", second.run.code === 0 && second.summary.sequence === 2 && root2 !== undefined, outcome(second.run, sc.secrets));
    const q = primary; // it recorded sequence 2 when it published it; no second device is needed to be the one that restores
    const before = await treeDigest(q.vault);

    const rewound = await repointName(S, sc, root1);
    add(OLDER_ROOT, "the owned key was pointed at the sequence-1 root (only name/publish for the owned key was sent)", rewound.onlyNamePublish);
    const byName = await sc.pull(q, "older root by name");
    add(OLDER_ROOT, "a pull by name of the older root is refused with exit 1 and the older-sequence message", byName.run.code === 1 && /the node serves sequence 1 but this device has recorded sequence 2/.test(byName.run.stderr), outcome(byName.run, sc.secrets));
    add(OLDER_ROOT, "that refusal changed no file or state of the device and sent no mutating request", sameDigest(before, await treeDigest(q.vault)) && noMutation(byName.trace) && !byName.run.leaked);
    const back = await repointName(S, sc, root2);
    add(OLDER_ROOT, "the owned key was pointed back at the sequence-2 root", back.onlyNamePublish);

    const noFlag = await sc.pull(q, "root-cid without the flag", { extra: ["--root-cid", root1] });
    add(RESTORE, "by --root-cid of the sequence-1 root without --allow-rollback: refused with exit 1 and a message that names the flag", noFlag.run.code === 1 && /pull stopped: the target has sequence 1 but this device has recorded sequence 2/.test(noFlag.run.stderr) && /--allow-rollback/.test(noFlag.run.stderr), outcome(noFlag.run, sc.secrets));
    add(RESTORE, "that refusal changed no file or state of the device", sameDigest(before, await treeDigest(q.vault)) && noMutation(noFlag.trace));
    const restored = await sc.pull(q, "root-cid with the flag", { extra: ["--root-cid", root1, "--allow-rollback"] });
    add(RESTORE, "with --allow-rollback: exit 0, the restore note says nothing is deleted", restored.run.code === 0 && /note: restore of sequence 1:/.test(restored.run.stdout) && /not removed/.test(restored.run.stdout), outcome(restored.run, sc.secrets));
    add(RESTORE, "the restore sent no mutating request and printed no passphrase", noMutation(restored.trace) && !restored.run.leaked);
    const text = (await walkFiles(q.vault)).find((file) => file.path === seed.first)?.text ?? "";
    add(RESTORE, "the edited note is back at its sequence-1 text", !text.includes("version two") && text.includes("version one"));
    const state = await readLocalState(q.vault, sc.root);
    add(RESTORE, "the recorded highest sequence stays 2 and restoredFrom is 1", state?.highestSequence === 2 && state.restoredFrom === 1, `highest ${state?.highestSequence}, restoredFrom ${state?.restoredFrom}`);
    await setMarker(q.vault, "fixture");
    const after = await sc.publish(q);
    add(RESTORE, "the publish after the restore is sequence 3 (the recorded highest + 1)", after.run.code === 0 && after.summary.sequence === 3, outcome(after.run, sc.secrets));
  } catch (error) {
    for (const id of [OLDER_ROOT, RESTORE]) add(id, "the replay scenario ran to completion", false, message(error));
  }
}

/** Two publishers at the same sequence, then pull (refused, names the flag) and pull --resolve-fork (answered yes by the script, see hostile-tools.mjs). */
export async function forkScenario(S, { add }) {
  S.t.out("\n-- fork and --resolve-fork --");
  try {
    const sc = await openScenario(S, "fork");
    const { primary } = await sc.setup();
    await appendNote(primary.vault, seed.first, "\nfork: edit by the first device\n");
    const second = await sc.publish(primary);
    add(FORK, "setup: the first device published sequence 2 (it recorded that manifest)", second.run.code === 0 && second.summary.sequence === 2, outcome(second.run, sc.secrets));

    // One MFS root cannot hold two publishers' sequence 2. The other half of the fork is prepared by the script below <DEMO_ROOT>/tamper/fork: an authentic
    // manifest of the same vault and sequence with another device name and time, so another identity (the identity covers both), then served by the name.
    const forkDir = `${S.demoRoot}/tamper/fork`;
    const tools = await S.hostileTools();
    const mark = S.proxy.mark();
    const prepared = await runHostile({ tools, op: "prepare-fork", input: { rpc: S.apiUrl, gateway: S.apiUrl, mfsRoot: sc.root, sourceRoot: sc.root, forkDir, passphraseFile: sc.passFile }, env: S.env, localStub: S.opts.localStub });
    const writes = S.proxy.since(mark).filter((entry) => entry.mutating);
    add(FORK, `the preparer made ${writes.length} writes, every one a files/write or files/mkdir inside ${forkDir}`, writes.length > 0 && writes.every((entry) => ["files/write", "files/mkdir"].includes(entry.command) && isWithin(`${entry.arg}`, forkDir, { allowEqual: true })), writes.slice(0, 2).map((entry) => `${entry.command} ${entry.arg}`).join(", "));
    const served = await repointName(S, sc, prepared.root);
    add(FORK, "the owned key now serves the other manifest of sequence 2 (only name/publish for the owned key was sent)", prepared.sequence === 2 && served.onlyNamePublish);

    const before = await treeDigest(primary.vault);
    const plain = await sc.pull(primary, "fork, plain pull");
    add(FORK, "a pull by name on the device that recorded the other manifest is refused (exit 1) with a message that names --resolve-fork", plain.run.code === 1 && /sequence 2 exists here with different content/.test(plain.run.stderr) && /--resolve-fork/.test(plain.run.stderr), outcome(plain.run, sc.secrets));
    add(FORK, "that refusal changed no file or state of the device and sent no mutating request", sameDigest(before, await treeDigest(primary.vault)) && noMutation(plain.trace));

    const resolved = await sc.pull(primary, "fork, --resolve-fork", { extra: ["--resolve-fork"], runner: primary.makeRunner(tools.cliYes) });
    add(FORK, "--resolve-fork (the terminal question answered yes by the script): exit 0 and the output says the fork was resolved", resolved.run.code === 0 && /fork/i.test(resolved.run.stdout), outcome(resolved.run, sc.secrets));
    add(FORK, "the resolution sent no mutating request and printed no passphrase", noMutation(resolved.trace) && !resolved.run.leaked);
    const again = await sc.pull(primary, "after the resolution");
    add(FORK, "after the resolution a plain pull by name succeeds (exit 0): the fork no longer stands", again.run.code === 0 && noMutation(again.trace), outcome(again.run, sc.secrets));
  } catch (error) {
    add(FORK, "the fork scenario ran to completion", false, message(error));
  }
}

/** keys change-passphrase on one device, the other refused until keys accept-slots; the old passphrase fails on the node's current file and opens the previous root. */
export async function rewrapScenario(S, { add }) {
  S.t.out("\n-- rewrap and accept --");
  try {
    const sc = await openScenario(S, "keys");
    const { primary } = await sc.setup();
    const root1 = sc.roots[0];
    const { device: q } = await sc.joiner("q");
    const newPass = join(sc.secretsDir, "pass1.txt");
    const rewrap = await sc.cli(primary, "keys", ["change-passphrase", primary.vault], { extra: ["--passphrase-file", newPass, "--accept-no-revocation"] });
    add(REWRAP, "keys change-passphrase on the first device exits 0 and writes the new passphrase to a file", rewrap.code === 0 && (await exists(newPass)), outcome(rewrap, sc.secrets));
    sc.secrets.push(...withPassphraseSpellings([], await readFile(newPass, "utf8").catch(() => "")));
    const refused = await sc.pull(q, "second device before accept");
    add(REWRAP, "the second device is refused until it accepts the changed key slots (the message names keys accept-slots)", refused.run.code !== 0 && /accept-slots/.test(refused.run.stderr) && noMutation(refused.trace), outcome(refused.run, sc.secrets));
    const accept = await sc.cli(q, "keys", ["accept-slots", q.vault], { pass: newPass });
    add(REWRAP, "keys accept-slots on the second device, with the new passphrase, exits 0", accept.code === 0 && !accept.leaked, outcome(accept, sc.secrets));
    const old = await sc.pull(q, "old passphrase on the current file");
    add(REWRAP, "the old passphrase fails on the accepted, current key-slot file (exit nonzero)", old.run.code !== 0 && noMutation(old.trace), outcome(old.run, sc.secrets));
    const { joined } = await sc.joiner("r", ["--root-cid", root1]).catch((error) => ({ joined: { run: { code: 1, stderr: message(error) } } }));
    add(REWRAP, "the old passphrase opens the previous root (a fresh device pulls --root-cid of the sequence-1 root with it)", joined.run.code === 0, firstLine(joined.run.stderr ?? ""));
  } catch (error) {
    add(REWRAP, "the rewrap scenario ran to completion", false, message(error));
  }
}

/** keys increase-cost: the command succeeds, and a run that cannot ask then refuses to unlock the vault at the higher cost. */
export async function costScenario(S, { add }) {
  S.t.out("\n-- increase-cost --");
  try {
    const sc = await openScenario(S, "cost");
    const { primary } = await sc.setup();
    const raise = await sc.cli(primary, "keys", ["increase-cost", primary.vault], { extra: ["--cost", "high", "--accept-no-revocation"] });
    add(COST, "keys increase-cost --cost high exits 0 under the same passphrase", raise.code === 0 && !raise.leaked, outcome(raise, sc.secrets));
    await appendNote(primary.vault, seed.first, "\nan edit, so that the publish has to unlock the vault\n");
    const mark = S.proxy.mark();
    const blocked = await sc.publish(primary);
    add(COST, "a publish that cannot ask now refuses to unlock the vault at the higher cost (nonzero exit, a message about the cost)", blocked.run.code !== 0 && /cost|above the default/i.test(blocked.run.stderr), outcome(blocked.run, sc.secrets));
    add(COST, "that refused publish sent no mutating request", noMutation(S.proxy.since(mark)));
  } catch (error) {
    add(COST, "the increase-cost scenario ran to completion", false, message(error));
  }
}

const historyOf = (S, root) => S.client.filesLs(`${root}/manifests`).then((entries) => entries.map((entry) => entry.name), () => []);
const treeCids = (S, root) => S.client.filesLs(root).then((entries) => entries.filter((entry) => entry.name !== "manifests").map((entry) => `${entry.name}:${entry.cid}`).sort(), () => []);

/** prune-history on its own root after `rounds` small publishes: a dry run lists, --yes-prune removes down to the keep count and changes nothing else. */
export async function pruneScenario(S, { add }, rounds = PRUNE_ROUNDS) {
  S.t.out(`\n-- prune-history after ${rounds} publishes --`);
  try {
    const sc = await openScenario(S, "prune");
    const { primary } = await sc.setup();
    let last = 1;
    for (let round = 2; round <= rounds; round += 1) {
      await appendNote(primary.vault, seed.first, `\nround ${round}\n`);
      const publish = await sc.publish(primary);
      if (publish.run.code !== 0) throw new Error(`publish ${round} exited ${publish.run.code}: ${outcome(publish.run, sc.secrets)}`);
      last = publish.summary.sequence;
    }
    const files = await historyOf(S, sc.root);
    add(PRUNE, `${rounds} publishes left ${rounds} history files (sequence ${last})`, files.length === rounds && last === rounds, `${files.length} history files, sequence ${last}`);
    const rest = await treeCids(S, sc.root);
    const dry = await sc.cli(primary, "prune-history", [primary.vault], { extra: ["--keep", String(PRUNE_KEEP), "--dry-run"] });
    add(PRUNE, "--dry-run exits 0, lists the files it would remove and removes nothing", dry.code === 0 && (await historyOf(S, sc.root)).length === files.length, outcome(dry, sc.secrets));
    const mark = S.proxy.mark();
    const pruned = await sc.cli(primary, "prune-history", [primary.vault], { extra: ["--keep", String(PRUNE_KEEP), "--yes-prune"] });
    const kept = await historyOf(S, sc.root);
    add(PRUNE, `--yes-prune exits 0 and leaves exactly ${PRUNE_KEEP} history files (the newest)`, pruned.code === 0 && kept.length === PRUNE_KEEP, `${outcome(pruned, sc.secrets)}; ${kept.length} left`);
    const sequences = kept.map((name) => Number(/^(\d+)-/.exec(name)?.[1])).sort((a, b) => a - b);
    const firstKept = rounds - PRUNE_KEEP + 1;
    add(PRUNE, `the files that remain are the newest ones (sequences ${firstKept} to ${rounds})`, sequences.length === PRUNE_KEEP && sequences.every((sequence, index) => sequence === firstKept + index), sequences.join(","));
    add(PRUNE, "manifest.enc, keyslots.json and current/ are unchanged by the prune", (await treeCids(S, sc.root)).join("|") === rest.join("|"));
    const removals = S.proxy.since(mark).filter((entry) => entry.mutating && entry.command === "files/rm");
    add(PRUNE, "the prune removed only history files (every files/rm names manifests/)", removals.length > 0 && removals.every((entry) => `${entry.arg}`.startsWith(`${sc.root}/manifests/`)), removals.map((entry) => entry.arg).slice(0, 2).join(", "));
  } catch (error) {
    add(PRUNE, "the prune scenario ran to completion", false, message(error));
  }
}
