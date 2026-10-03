// Read-only views of the node's published root: the key slots unlocked with the generated passphrase (test-only unwrap), the decoded manifest, blob names.
import { readFile, stat } from "node:fs/promises";
import { isOutsideRepo } from "./policy.mjs";
import { check } from "./report.mjs";

/** Read the generated passphrase file and return the canonical passphrase plus the two spellings the output scrubber must know. */
export async function readPassphraseFile(tb, passFile) {
  const text = await readFile(passFile, "utf8");
  const info = await stat(passFile);
  const shapeOk = /^[A-Z2-7]{5}(?:-[A-Z2-7]{5}){4}\n$/.test(text);
  const modeOk = process.platform === "win32" || (info.mode & 0o077) === 0;
  return { passphrase: tb.canonicalizePassphrase(Buffer.from(text.trimEnd(), "utf8")), secrets: [text.trimEnd(), text.trimEnd().replaceAll("-", "")], shapeOk, modeOk, outsideRepo: isOutsideRepo(passFile) };
}

/** The vault keys, from the key slots the node serves, opened with the test-only unwrap. Cached on `view`. */
export async function unlockKeys(view) {
  if (view.keys !== undefined) return view.keys;
  const { tb, client, demoRoot } = view;
  const root = (await client.filesStat(demoRoot)).cid;
  const slots = await client.gatewayFetch(root, "keyslots.json");
  const raw = await tb.unwrapVckForTest(slots, view.passphrase);
  view.keys = await tb.createVaultKeys(raw.vaultId, raw.vck);
  view.vaultId = Buffer.from(raw.vaultId).toString("hex");
  tb.wipe(raw.vck);
  return view.keys;
}

/** The immutable root the MFS root currently has and the decoded, authenticated manifest.enc inside it. */
export async function readNodeManifest(view) {
  const root = (await view.client.filesStat(view.demoRoot)).cid;
  const bytes = await view.client.gatewayFetch(root, "manifest.enc");
  return { root, manifest: await view.tb.decodeManifestFile(await unlockKeys(view), bytes) };
}

/** Every 52-character blob name below `<root>/current/<xx>/`, by one-level listings of the immutable tree. */
export async function listBlobNames(client, root) {
  const names = new Set();
  const prefixes = (await client.ipfsLs(`/ipfs/${root}/current`)).filter((entry) => /^[a-z2-7]{2}$/.test(entry.name));
  for (const prefix of prefixes) for (const entry of await client.ipfsLs(`/ipfs/${root}/current/${prefix.name}`)) if (/^[a-z2-7]{52}$/.test(entry.name)) names.add(entry.name);
  return names;
}

/** After a publish: the IPNS name of the owned key resolves to the immutable root that was just read. */
export async function checkNameAtRoot(view, label, keyId, root) {
  const resolved = await view.client.nameResolve(keyId).catch(() => "unresolved");
  return check(`${label}: name/resolve of the owned key points at the immutable root read below`, resolved === `/ipfs/${root}`, `${resolved} vs /ipfs/${root}`);
}
