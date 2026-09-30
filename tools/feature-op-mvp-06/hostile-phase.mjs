// The local-fixture phase: hostile objects against a script-hosted stub node.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeCliRunner } from "./children.mjs";
import { canonicalJson, firstLine, parsePublishOutput, rootDigest, scrubbedDetail, sha256 } from "./policy.mjs";
import { check, note, out } from "./report.mjs";
import { startStub } from "./stub-node.mjs";
import { appendNote, ensureConfig, generateVault } from "./workspace.mjs";

// ======================================================================================================================
// Local-fixture phase: hostile objects against a stub node
// ======================================================================================================================

const copyTree = async (from, to) => {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
};

export async function hostilePhase(S) {
  out("\n== local-fixture phase: hostile objects against a script-hosted stub node (never the shared node) ==");
  const { tb } = S;
  const dir = join(S.work, "stub");
  const stub = await startStub(tb);
  try {
    const secrets = join(dir, "secrets");
    await mkdir(secrets, { recursive: true, mode: 0o700 });
    const config = join(dir, "config.json");
    await ensureConfig(config);
    const vault = join(dir, "vault");
    await generateVault(vault);
    const passFile = join(secrets, "passphrase.txt");
    const stubSecrets = [];
    const cli = makeCliRunner({ tb, cwd: S.cwd, apiUrl: stub.url, configFile: config, demoRoot: S.demoRoot, ownedFlags: [], secrets: () => stubSecrets });
    const init = await cli("init", [vault], { extra: ["--passphrase-file", passFile] });
    const text = await readFile(passFile, "utf8").catch(() => "");
    stubSecrets.push(text.trimEnd(), text.trimEnd().replaceAll("-", ""));
    const p1 = await cli("publish", [vault], { passphraseFile: passFile });
    const afterFirst = join(dir, "after-first-publish");
    await copyTree(vault, join(afterFirst, "vault"));
    await copyTree(config, join(afterFirst, "config.json"));
    const oldManifest = Buffer.from(stub.node.files.get(`${S.demoRoot}/manifest.enc`) ?? new Uint8Array());
    await appendNote(vault, "notes/welcome.md", "\nstub edit\n");
    const p2 = await cli("publish", [vault], { passphraseFile: passFile });
    if (!check("stub setup: init and two genuine publishes succeed on the stub", init.code === 0 && p1.code === 0 && p2.code === 0, scrubbedDetail(p2, stubSecrets) || scrubbedDetail(p1, stubSecrets) || scrubbedDetail(init, stubSecrets))) return;
    const snapshot = tb.snapshotNode(stub.node);
    const pristine = join(dir, "pristine");
    await copyTree(vault, join(pristine, "vault"));
    await copyTree(config, join(pristine, "config.json"));
    const digest = rootDigest(S.demoRoot);
    let index = 0;
    const prepareScenario = async (prepare, from) => {
      index += 1;
      const copy = join(dir, `scenario-${index}`);
      await copyTree(join(from, "vault"), join(copy, "vault"));
      await copyTree(join(from, "config.json"), join(copy, "config.json"));
      stub.swap(tb.restoreNode(snapshot));
      await prepare({ node: stub.node, vault: join(copy, "vault") });
      await appendNote(join(copy, "vault"), "notes/welcome.md", `\nedit ${index}\n`);
      const runner = makeCliRunner({ tb, cwd: S.cwd, apiUrl: stub.url, configFile: join(copy, "config.json"), demoRoot: S.demoRoot, ownedFlags: [], secrets: () => stubSecrets });
      return { runner, vault: join(copy, "vault"), mark: stub.requests.length };
    };
    const scenario = async (name, prepare, { extra = [], forbiddenGet, from = pristine, mustSay } = {}) => {
      const { runner, vault: target, mark } = await prepareScenario(prepare, from);
      const run = await runner("publish", [target], { passphraseFile: passFile, extra });
      const seen = stub.requests.slice(mark);
      check(`hostile "${name}": refused with a typed message (exit ${run.code})`, run.code !== 0 && /ipfs-sync: publish failed:/.test(run.stderr), firstLine(run.stderr));
      check(`hostile "${name}": no write, delete, pin, name or key request reached the stub`, stub.mutationsSince(mark).length === 0, `${seen.length} request(s)`);
      if (mustSay !== undefined) check(`hostile "${name}": the refusal names the reason`, mustSay.test(run.stderr), firstLine(run.stderr));
      if (forbiddenGet !== undefined) check(`hostile "${name}": the oversize object was refused without downloading it`, !seen.some((line) => line.startsWith("GET ") && line.includes(forbiddenGet)), seen.filter((line) => line.startsWith("GET ")).length + " gateway read(s)");
    };
    const slotsPath = `${S.demoRoot}/keyslots.json`;
    const editSlots = (mutate, { alsoLocal }) => async ({ node, vault: target }) => {
      const document = JSON.parse(Buffer.from(node.files.get(slotsPath)).toString("utf8"));
      mutate(document.slots[0]);
      const bytes = Buffer.from(canonicalJson(document));
      node.files.set(slotsPath, bytes);
      if (!alsoLocal) return;
      await writeFile(join(target, ".ipfs-sync", `keyslots.${digest}.json`), bytes);
      const statePath = join(target, ".ipfs-sync", `state.${digest}.json`);
      try {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        await writeFile(statePath, JSON.stringify({ ...state, keyslotsSha256: sha256(bytes) }));
      } catch (error) {
        note(`the recorded key-slot hash in ${statePath} could not be rewritten (${firstLine(error.message)}); the publish will be refused earlier than the check this scenario aims at`);
      }
    };
    const flipCommit = (slot) => {
      slot.commit = `${slot.commit[0] === "A" ? "B" : "A"}${slot.commit.slice(1)}`;
    };
    await scenario("oversize keyslots.json", ({ node }) => (node.sizeLie = (name) => (name === "keyslots.json" ? 20 * 1024 : undefined)), { forbiddenGet: "keyslots.json" });
    await scenario("oversize manifest.enc", ({ node }) => (node.sizeLie = (name) => (name === "manifest.enc" ? 64 * 1024 * 1024 + 1 : undefined)), { forbiddenGet: "manifest.enc" });
    await scenario("keyslots.json differing from the local copy", editSlots(flipCommit, { alsoLocal: false }));
    await scenario("a slot with a modified commitment", editSlots(flipCommit, { alsoLocal: true }));
    await scenario("a 4 GiB memory parameter", editSlots((slot) => (slot.kdf.m = 4194304), { alsoLocal: true }));
    const rollback = ({ node }) => node.files.set(`${S.demoRoot}/manifest.enc`, oldManifest);
    await scenario("an older genuine manifest", rollback);
    // repair.ts / tasks 3.3: an older genuine manifest (node BEHIND, key slots equal to the local copy) is repaired by --repair without a prompt;
    // only the AHEAD case asks. So the behind case must succeed on the stub (a script-hosted node), and the ahead case must be refused with no terminal.
    const { runner: repairRun, vault: repairVault } = await prepareScenario(rollback, pristine);
    const repaired = await repairRun("publish", [repairVault], { passphraseFile: passFile, extra: ["--repair"] });
    const repairedSequence = parsePublishOutput(repaired.stdout).sequence;
    check("hostile \"an older genuine manifest with --repair\": the documented repair (node behind, key slots equal to the local copy) completes on the stub without a prompt, at the greater sequence plus one", repaired.code === 0 && repairedSequence === 3, `exit ${repaired.code}, reported sequence ${repairedSequence}: ${firstLine(repaired.stderr) || firstLine(repaired.stdout)}`);
    await scenario("the node ahead of this device with --repair (no terminal to confirm)", () => undefined, { extra: ["--repair"], from: afterFirst, mustSay: /--repair was not confirmed|--repair is not allowed here|cannot ask/ });
  } finally {
    await stub.stop();
  }
}
