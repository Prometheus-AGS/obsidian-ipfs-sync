// Phase hostile-preparer (task 4.7b, design decision 11 step 6): a tampered root is prepared by the script's own guarded writes, all of them
// below <DEMO_ROOT>/tamper (one bit flipped in one blob, a new authentic manifest.enc at a higher sequence built with the test-only unwrap hook, see
// hostile-tools.mjs), and a device that already holds the genuine vault pulls it: the pull must refuse the file as integrity-failed, leave the
// device's files as they were, leave no temporary file, and send no mutating request.
import { isWithin } from "./policy.mjs";
import { TAMPER_SEQUENCE_BUMP, runHostile } from "./hostile-tools.mjs";
import { sameDigestMap } from "./machine-checks.mjs";
import { makeRecorder } from "./recorder.mjs";
import { openScenario, outcome } from "./scenario-kit.mjs";
import { firstLine } from "./policy.mjs";
import { treeDigest, walkFiles } from "../feature-op-mvp-07a/workspace.mjs";

export const TAMPER_ID = "tamper-refused-nothing-written";
const message = (error) => firstLine(error instanceof Error ? error.message : String(error));
const publishedState = async (vault) => new Map((await walkFiles(vault)).map((file) => [file.path, file.sha256]));

export async function hostilePreparerPhase(S) {
  const recorder = makeRecorder(S);
  const { add } = recorder;
  if (!S.machine.scenarios.includes("tamper")) return [{ id: TAMPER_ID, passed: false, detail: "the tamper scenario was not selected (a test-only context option)" }];
  S.t.out("\n== hostile preparer: a tampered root confined to <DEMO_ROOT>/tamper ==");
  try {
    const sc = await openScenario(S, "tamper-src");
    await sc.setup();
    const { device: holder } = await sc.joiner("c");
    const before = await publishedState(holder.vault);
    const tamperDir = `${S.demoRoot}/tamper`;
    const tools = await S.hostileTools();
    const mark = S.proxy.mark();
    const prepared = await runHostile({ tools, op: "prepare-tamper", input: { rpc: S.apiUrl, gateway: S.apiUrl, mfsRoot: sc.root, sourceRoot: sc.root, tamperDir, passphraseFile: sc.passFile, bump: TAMPER_SEQUENCE_BUMP }, env: S.env, localStub: S.opts.localStub });
    const writes = S.proxy.since(mark).filter((entry) => entry.mutating);
    const outside = writes.filter((entry) => !(["files/write", "files/mkdir"].includes(entry.command) && isWithin(`${entry.arg}`, tamperDir, { allowEqual: true })));
    add(TAMPER_ID, `the preparer made ${writes.length} writes, every one a files/write or files/mkdir inside ${tamperDir}; the proxy refused nothing`, writes.length > 0 && outside.length === 0 && S.proxy.violations.length === 0, outside.slice(0, 2).map((entry) => `${entry.command} ${entry.arg}`).join(", "));
    add(TAMPER_ID, `the tampered root carries sequence ${prepared.sequence}, above the genuine ${prepared.sourceSequence}, with one blob of ${prepared.target} changed`, prepared.sequence > prepared.sourceSequence && typeof prepared.root === "string" && prepared.root !== "");

    const digest = await treeDigest(holder.vault);
    const refused = await sc.pull(holder, "tampered root", { extra: ["--root-cid", prepared.root] });
    add(TAMPER_ID, "the pull of the tampered root is refused: exit 1 and the changed file is reported integrity-failed", refused.run.code === 1 && refused.run.stderr.includes(`integrity-failed ${prepared.target}`), outcome(refused.run, sc.secrets));
    const after = await publishedState(holder.vault);
    add(TAMPER_ID, "the device's files are exactly as before (the tampered file kept its genuine content)", sameDigestMap(before, after));
    const leftovers = [...digest.keys()].filter((path) => path.startsWith(".ipfs-sync/tmp/"));
    const leftoversAfter = [...(await treeDigest(holder.vault)).keys()].filter((path) => path.startsWith(".ipfs-sync/tmp/"));
    add(TAMPER_ID, "no temporary file remains", leftovers.length === 0 && leftoversAfter.length === 0, leftoversAfter.slice(0, 2).join(", "));
    add(TAMPER_ID, "the pull sent no mutating request and printed no passphrase", refused.trace.every((entry) => !entry.mutating) && !refused.run.leaked);
  } catch (error) {
    add(TAMPER_ID, "the hostile preparer ran to completion", false, message(error));
  }
  return [recorder.verdictFor(TAMPER_ID)];
}
