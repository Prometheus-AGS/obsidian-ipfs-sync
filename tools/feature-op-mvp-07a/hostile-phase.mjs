// The local-fixture phase: hostile and forked objects against a script-hosted stub node. Never the shared node.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { makeCliRunner } from "./children.mjs";
import { DEVICE_A, DEVICE_B, KEY } from "./constants.mjs";
import { readNodeManifest, readPassphraseFile } from "./node-view.mjs";
import { firstLine, parsePublishOutput, parsePullOutput, scrubbedDetail, withPassphraseSpellings } from "./policy.mjs";
import { check, out } from "./report.mjs";
import { startStub } from "./stub-node.mjs";
import { appendNote, ensureConfig, exists, generateVault, readLocalState, sameDigest, setMarker, treeDigest, vaultPath } from "./workspace.mjs";

// ======================================================================================================================
// Local-fixture phase: hostile objects against a stub node
// ======================================================================================================================

const BLOB_GET = /^GET \/ipfs\/[^/]+\/[a-z2-7]{2}\/[a-z2-7]{52}/;
const GLOSSARY = "reference/glossary.md";
const PLAN = "projects/alpha/plan.md";
const NO_VAULT = "0".repeat(32);

/** The vault directory of a device that was refused: no vault file, no marker, no state, no key-slot copy, no floor. */
async function untouched(device) {
  const files = [...(await treeDigest(device.vault)).keys()];
  const problems = files.filter((path) => !path.startsWith(".ipfs-sync/") || /^\.ipfs-sync\/(?:state|keyslots)\./.test(path));
  if (await exists(join(device.stateHome, "ipfs-sync", "sequence-floor.json"))) problems.push("sequence-floor.json");
  return problems;
}

export async function hostilePhase(S) {
  out("\n== local-fixture phase: hostile and forked objects against a script-hosted stub node (never the shared node) ==");
  const { tb } = S;
  const dir = join(S.work, "hostile");
  const stub = await startStub(tb);
  try {
    const secretsDir = join(dir, "secrets");
    await mkdir(secretsDir, { recursive: true, mode: 0o700 });
    const passFile = join(secretsDir, "passphrase.txt");
    const secrets = [];
    const runner = (options) => makeCliRunner({ tb, cwd: S.cwd, apiUrl: stub.url, demoRoot: S.demoRoot, secrets: () => secrets, cli: S.cliPath, localStub: true, ...options });

    const home = join(dir, "device-h");
    const vaultH = join(home, "vault");
    const stateH = join(home, "state");
    const configH = join(home, "config.json");
    await mkdir(stateH, { recursive: true });
    await ensureConfig(configH);
    const cliH = runner({ configFile: configH, ownedFlags: [], device: DEVICE_A, stateHome: stateH });
    await generateVault(vaultH);
    const init = await cliH("init", [vaultH], { extra: ["--passphrase-file", passFile] });
    const loaded = await readPassphraseFile(tb, passFile).catch(() => undefined);
    if (loaded !== undefined) secrets.push(...loaded.secrets);
    const p1 = await cliH("publish", [vaultH], { passphraseFile: passFile });
    await appendNote(vaultH, "notes/welcome.md", "\nstub edit\n");
    const p2 = await cliH("publish", [vaultH], { passphraseFile: passFile });
    const sequence = parsePublishOutput(p2.stdout).sequence;
    const setupOk = init.code === 0 && p1.code === 0 && p2.code === 0 && sequence === 2 && loaded !== undefined;
    const detailSecrets = setupOk ? secrets : withPassphraseSpellings(secrets, await readFile(passFile, "utf8").catch(() => ""));
    if (!check("stub setup: init and two genuine publishes succeed on the stub (sequence 2)", setupOk, setupOk ? "" : scrubbedDetail(p2, detailSecrets) || scrubbedDetail(p1, detailSecrets) || scrubbedDetail(init, detailSecrets))) return;
    const keyId = stub.node.keys.find((key) => key.name === KEY)?.id;
    const view = { tb, client: tb.makeClient(process.env, stub.url, stub.url, S.demoRoot), demoRoot: S.demoRoot, passphrase: loaded.passphrase };
    const { manifest } = await readNodeManifest(view);
    const published = Object.keys(manifest.files);
    const snap2 = tb.snapshotNode(stub.node);
    const registered = () => stub.node.cidOf(S.demoRoot); // registers every block of the tree, so /ipfs/<cid> reads work after a restore
    let counter = 0;
    const makeDevice = async (tag) => {
      counter += 1;
      const base = join(dir, `${tag}-${counter}`);
      const device = { vault: join(base, "vault"), stateHome: join(base, "state"), configFile: join(base, "config.json") };
      await mkdir(device.vault, { recursive: true });
      await mkdir(device.stateHome, { recursive: true });
      await ensureConfig(device.configFile);
      return { ...device, cli: runner({ configFile: device.configFile, ownedFlags: ["--owned-key", keyId], device: DEVICE_B, stateHome: device.stateHome }) };
    };
    const freshNode = () => {
      stub.swap(tb.restoreNode(snap2));
      registered();
    };
    const firstPull = async (prepare, extra = []) => {
      freshNode();
      await prepare(stub.node);
      const device = await makeDevice("scenario");
      const mark = stub.requests.length;
      const run = await device.cli("pull", [device.vault], { passphraseFile: passFile, extra: ["--accept-first-pull", ...extra] });
      return { device, run, mark, seen: stub.requests.slice(mark), summary: parsePullOutput(run.stdout) };
    };
    const refused = async (name, result, say, { code = 1 } = {}) => {
      check(`hostile "${name}": refused with exit ${code} and the stated reason`, result.run.code === code && say.test(result.run.stderr), `exit ${result.run.code}: ${firstLine(result.run.stderr)}`);
      check(`hostile "${name}": no blob was requested and nothing was written in the vault, the state or the floor`, !result.seen.some((line) => BLOB_GET.test(line)) && (await untouched(result.device)).length === 0, (await untouched(result.device)).slice(0, 3).join(", "));
      check(`hostile "${name}": no write, delete, pin, name or key request reached the stub`, stub.mutationsSince(result.mark).length === 0, `${result.seen.length} request(s)`);
    };

    // 1. A forged manifest: manifest.enc is served with one flipped byte.
    const forged = await firstPull((node) => {
      const cid = node.cidOf(`${S.demoRoot}/manifest.enc`);
      const bytes = Buffer.from(node.bytesOf(cid));
      bytes[bytes.length - 1] ^= 1;
      node.corruptRead = (asked) => (asked === cid ? bytes : undefined);
    });
    await refused("forged manifest.enc", forged, /does not authenticate/);

    // 2. A wrong vault expectation and an unmet minimum sequence.
    await refused("wrong vault (--expect-vault-id of another vault)", await firstPull(() => undefined, ["--expect-vault-id", NO_VAULT]), /vault id is not the one expected/);
    await refused("unmet --expect-min-sequence (above the served sequence)", await firstPull(() => undefined, ["--expect-min-sequence", "99"]), /below the 99 required/);

    // 3. One flipped bit in one blob: that file fails, the others arrive, the state is incomplete.
    const flipped = await firstPull((node) => {
      const name = manifest.files[GLOSSARY].blob;
      const cid = node.cidOf(`${S.demoRoot}/current/${name.slice(0, 2)}/${name}`);
      const bytes = Buffer.from(node.bytesOf(cid));
      bytes[22 + 5] ^= 1;
      node.corruptRead = (asked) => (asked === cid ? bytes : undefined);
    });
    const state = await readLocalState(flipped.device.vault, S.demoRoot);
    const leftovers = [...(await treeDigest(flipped.device.vault)).keys()].filter((path) => path.startsWith(".ipfs-sync/tmp/"));
    check("hostile \"flipped blob bit\": exit 1, that file is integrity-failed and every other file was fetched", flipped.run.code === 1 && flipped.summary.integrityFailed === 1 && flipped.summary.fetched === published.length - 1 && flipped.run.stderr.includes(`integrity-failed ${GLOSSARY}`), `exit ${flipped.run.code}: ${flipped.summary.fetched} fetched, ${flipped.summary.integrityFailed} integrity-failed`);
    check("hostile \"flipped blob bit\": the file is absent in the destination, no temporary file remains and the state is marked incomplete with the path unmaterialized", !(await exists(vaultPath(flipped.device.vault, GLOSSARY))) && leftovers.length === 0 && state?.complete === false && (state.unmaterialized ?? []).includes(GLOSSARY), `complete ${state?.complete}, ${leftovers.length} leftovers`);
    check("hostile \"flipped blob bit\": no write, delete, pin, name or key request reached the stub", stub.mutationsSince(flipped.mark).length === 0);

    // 4. A planted manifest.json next to the key slots: the encrypted path is taken and manifest.json is never read.
    const planted = await firstPull((node) => {
      node.files.set(`${S.demoRoot}/manifest.json`, Buffer.from('{"version":1,"files":{"planted-by-hostile-phase.md":{"size":1}}}'));
      node.published.set(keyId, `/ipfs/${node.cidOf(S.demoRoot)}`);
    });
    check("hostile \"planted manifest.json\": the pull takes the encrypted path (exit 0, every published file fetched), never requests manifest.json and writes nothing it names", planted.run.code === 0 && planted.summary.fetched === published.length && !planted.seen.some((line) => line.includes("manifest.json")) && !(await exists(vaultPath(planted.device.vault, "planted-by-hostile-phase.md"))), `exit ${planted.run.code}: ${planted.summary.fetched} fetched`);
    check("hostile \"planted manifest.json\": no write, delete, pin, name or key request reached the stub", stub.mutationsSince(planted.mark).length === 0);

    // 5. A fork: two publishes at sequence 3 from the same sequence-2 root; device H recorded the one that lost.
    freshNode();
    const second = await makeDevice("fork");
    const joined = await second.cli("pull", [second.vault], { passphraseFile: passFile, extra: ["--accept-first-pull"] });
    await appendNote(vaultH, PLAN, "\nfork: edit by device H\n");
    const h3 = await cliH("publish", [vaultH], { passphraseFile: passFile });
    freshNode();
    await setMarker(second.vault, "fixture");
    await appendNote(second.vault, GLOSSARY, "\nfork: edit by the second device\n");
    const b3 = await second.cli("publish", [second.vault], { passphraseFile: passFile });
    check("fork setup: both devices published sequence 3 from the same sequence-2 root (the node now serves the second device's)", joined.code === 0 && h3.code === 0 && b3.code === 0 && parsePublishOutput(h3.stdout).sequence === 3 && parsePublishOutput(b3.stdout).sequence === 3, `${joined.code}/${h3.code}/${b3.code}: ${scrubbedDetail(b3, secrets) || scrubbedDetail(h3, secrets)}`);
    const before = await treeDigest(vaultH);
    const mark = stub.requests.length;
    const plain = await cliH("pull", [vaultH], { passphraseFile: passFile });
    check("fork: a pull by name on the device that lost is refused (exit 1) with a message that names --resolve-fork", plain.code === 1 && /sequence 3 exists here with different content/.test(plain.stderr) && /--resolve-fork/.test(plain.stderr), `exit ${plain.code}: ${firstLine(plain.stderr)}`);
    check("fork: that refusal changed no file or state of the device and sent no mutating request", sameDigest(before, await treeDigest(vaultH)) && stub.mutationsSince(mark).length === 0);
    const askedAt = stub.requests.length;
    const resolve = await cliH("pull", [vaultH], { passphraseFile: passFile, extra: ["--resolve-fork"] });
    check("fork: --resolve-fork without a terminal is declined (the question is answered no: exit 1, \"fork resolution was declined\") before any request, and changes nothing", resolve.code === 1 && /pull stopped: the fork resolution was declined; nothing was changed/.test(resolve.stderr) && stub.requests.length === askedAt && sameDigest(before, await treeDigest(vaultH)), `exit ${resolve.code}: ${firstLine(resolve.stderr)}; ${stub.requests.length - askedAt} request(s)`);
  } finally {
    await stub.stop();
  }
}
