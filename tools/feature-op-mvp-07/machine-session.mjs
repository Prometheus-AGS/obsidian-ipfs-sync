// The throwaway devices of the machine steps (task 4.7a): vault A (a generated fixture vault, plus an optional large blob), an empty directory
// for device B, and a CLI runner for each. Set up once per run and shared by every phase that needs it. The CLI stands in for the plugin here:
// it is the only code that talks to the node, always through the confinement proxy (see cli-runner.mjs).
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { DEVICE_A, DEVICE_B, MIN_PUBLISHED_FILES } from "../feature-op-mvp-07a/constants.mjs";
import { parseInitOutput, parsePublishOutput, plaintextNeedles, scrubbedDetail, withPassphraseSpellings } from "../feature-op-mvp-07a/policy.mjs";
import { ensureConfig, generateVault, walkFiles } from "../feature-op-mvp-07a/workspace.mjs";
import { makeCliRunner } from "./cli-runner.mjs";
import { KEY } from "./constants.mjs";
import { firstLine } from "./policy.mjs";

const PASSPHRASE_SHAPE = /^[A-Z2-7]{5}(?:-[A-Z2-7]{5}){4}\n$/;
const BLOB_NEEDLE_OFFSET = 1000;
const BLOB_NEEDLE_BYTES = 32;
export const BLOB_PATH = "attachments/large-blob.bin";
export const MARKER = ".ipfs-sync-fixture";

/** The files the CLI publishes from the fixture vault: not the configuration folder, the trash or the fixture marker (the generator writes all three). */
export const isPublished = (path) => !path.startsWith(".obsidian/") && !path.startsWith(".trash/") && path !== MARKER;

const inLog = (S, mark) => S.proxy.since(mark);

/** `--owned-key` goes to a child only when the owned key already existed on the node and is the one the operator confirmed; a key made by this run needs no flag, and a flag for another ID would make the CLI call the new key foreign. */
export const ownedFlagsForA = (S) => {
  const existing = S.before.keys.get(KEY);
  return existing !== undefined && existing === S.opts.ownedKey ? ["--owned-key", existing] : [];
};

/** Creates vault A, runs `init` and the first publish, and builds the runner of device B. Throws with a one-line reason when setup cannot finish. */
async function openSession(S, { withBlob }) {
  const { work } = S;
  // The main vault lives in <DEMO_ROOT>/main, so the scenarios and the tamper folder can sit beside it without making its MFS root "not a vault".
  const demoRoot = S.mainRoot;
  const secretsDir = join(work, "secrets");
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const X = {
    A: { vault: join(work, "vault-a"), stateHome: join(work, "state-a") },
    B: { vault: join(work, "vault-b"), stateHome: join(work, "state-b"), configFile: join(work, "config-b.json") },
    cwd: join(work, "cwd"),
    passFile: join(secretsDir, "passphrase.txt"),
    secrets: [],
    setupChecks: [],
    pulls: [],
  };
  for (const dir of [X.cwd, X.B.vault, X.A.stateHome, X.B.stateHome]) await mkdir(dir, { recursive: true });
  await ensureConfig(X.B.configFile);
  const common = { cliPath: join(S.distDir, "cli", "ipfs-sync.mjs"), cwd: X.cwd, apiUrl: S.apiUrl, demoRoot, secrets: () => X.secrets, env: S.env, localStub: S.opts.localStub, onRun: (run) => S.t.out(`  cli ${run.device} ${run.command}: exit ${run.code}, ${run.ms} ms`) };
  X.A.cli = makeCliRunner({ ...common, configFile: S.configFile, ownedFlags: ownedFlagsForA(S), device: DEVICE_A, stateHome: X.A.stateHome });

  const generated = await generateVault(X.A.vault);
  if (generated.code !== 0) throw new Error(`the fixture vault was not generated: ${firstLine(generated.text)}`);
  let blob;
  if (withBlob) {
    blob = randomBytes(S.machine.blobBytes);
    await mkdir(join(X.A.vault, "attachments"), { recursive: true });
    await writeFile(join(X.A.vault, ...BLOB_PATH.split("/")), blob);
  }
  X.filesA = await walkFiles(X.A.vault);
  X.published = X.filesA.filter((file) => isPublished(file.path));
  X.blobBytes = blob?.length ?? 0;
  if (X.published.length < MIN_PUBLISHED_FILES) throw new Error(`only ${X.published.length} publishable files in the fixture vault`);
  X.needles = [...plaintextNeedles(X.filesA), ...(blob === undefined ? [] : [{ label: "large blob bytes", bytes: blob.subarray(BLOB_NEEDLE_OFFSET, BLOB_NEEDLE_OFFSET + BLOB_NEEDLE_BYTES) }])];
  S.proxy.setNeedles(X.needles);

  S.t.out(`step 1: vault A has ${X.published.length} publishable files${blob === undefined ? "" : ` and a ${blob.length}-byte blob`}; init and publish #1 through the CLI (the V1 stand-in), device B is an empty directory`);
  const mark = S.proxy.mark();
  const init = await X.A.cli("init", [X.A.vault], { extra: ["--passphrase-file", X.passFile] });
  if (init.code !== 0) throw new Error(`init exited ${init.code}: ${scrubbedDetail(init, X.secrets)}`);
  const text = await readFile(X.passFile, "utf8");
  X.secrets.push(...withPassphraseSpellings([], text));
  X.passphraseOk = PASSPHRASE_SHAPE.test(text) && (process.platform === "win32" || ((await stat(X.passFile)).mode & 0o077) === 0);
  S.proxy.setNeedles([...X.needles, ...X.secrets.map((secret, index) => ({ label: index === 0 ? "passphrase (grouped)" : "passphrase (canonical)", bytes: Buffer.from(secret) }))]);
  X.vaultId = parseInitOutput(init.stdout).vaultId;
  X.initWrites = inLog(S, mark).filter((entry) => entry.mutating && entry.command === "files/write").map((entry) => entry.arg);
  X.initLeaked = init.leaked;
  const publish = await X.A.cli("publish", [X.A.vault], { passphraseFile: X.passFile });
  X.publish1 = { run: publish, summary: parsePublishOutput(publish.stdout) };
  if (publish.code !== 0) throw new Error(`publish #1 exited ${publish.code}: ${scrubbedDetail(publish, X.secrets)}`);
  X.lastSequence = X.publish1.summary.sequence ?? 0;
  X.lastRoot = X.publish1.summary.rootCid;
  X.keyId = (await S.client.keyList()).find((key) => key.name === KEY)?.id;
  if (typeof X.keyId !== "string" || X.keyId === "") throw new Error(`the owned key ${KEY} is not on the node after publish #1`);
  X.B.cli = makeCliRunner({ ...common, configFile: X.B.configFile, ownedFlags: ["--owned-key", X.keyId], device: DEVICE_B, stateHome: X.B.stateHome });
  return X;
}

/** The session of this run, made on first use and shared. The blob is written only when the first caller asks for it. */
export function getSession(S, { withBlob }) {
  S.sessionPromise ??= openSession(S, { withBlob });
  return S.sessionPromise;
}
