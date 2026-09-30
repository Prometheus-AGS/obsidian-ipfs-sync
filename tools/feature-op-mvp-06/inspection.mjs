// Read-only inspection of the node's immutable root (listings, ciphertext, key-material search, manifest content) and the read-boundary tamper points.
import { BLOB_EXPONENT, BLOB_HEADER_BYTES, BLOB_MAGIC_TEXT, KEY, LARGE_NOTE, LARGE_NOTE_BYTES, MIN_ENTROPY, MIN_PUBLISHED_FILES, TAMPER_AT } from "./constants.mjs";
import { byteEntropy, canonicalJson, checkNodeLayout, findNeedle, firstLine, keyMaterialNeedles } from "./policy.mjs";
import { check } from "./report.mjs";

/** Tamper "corrupted-commitment": the copy of keyslots.json the commitment check is shown has one flipped commitment character. */
function withFlippedCommitment(bytes) {
  const document = JSON.parse(Buffer.from(bytes).toString("utf8"));
  document.slots[0].commit = `${document.slots[0].commit[0] === "A" ? "B" : "A"}${document.slots[0].commit.slice(1)}`;
  return Buffer.from(canonicalJson(document));
}

async function unlockForInspection(S, keyslotsBytes) {
  const { tb } = S;
  const label = "step 3c: the test-only unwrap opens keyslots.json with the generated passphrase (same routine as production unlock, commitment checked)";
  let detail = "";
  let ok = false;
  try {
    const raw = await tb.unwrapVckForTest(keyslotsBytes, S.passphrase);
    const slot = tb.parseKeySlots(keyslotsBytes).slots.find(tb.isPassphraseSlot);
    const kek = await tb.deriveKek(S.passphrase, tb.fromBase64(slot.kdf.salt), { m: slot.kdf.m, t: slot.kdf.t, p: slot.kdf.p });
    S.keyNeedles = [...keyMaterialNeedles("vault content key", raw.vck), ...keyMaterialNeedles("key-encryption key", kek), ...S.secretNeedles];
    S.keys = await tb.createVaultKeys(raw.vaultId, raw.vck);
    S.keyslotsBytes = Buffer.from(keyslotsBytes);
    S.slotParams = { m: slot.kdf.m, t: slot.kdf.t, p: slot.kdf.p };
    tb.wipe(raw.vck, kek);
    ok = true;
    detail = `slot m=${slot.kdf.m} KiB t=${slot.kdf.t} p=${slot.kdf.p}`;
  } catch (error) {
    detail = firstLine(error.message);
  }
  if (ok && S.opts.tamper === "corrupted-commitment") {
    await tb.unwrapVckForTest(withFlippedCommitment(keyslotsBytes), S.passphrase).then(
      (shown) => {
        tb.wipe(shown.vck);
        detail = "the corrupted document was accepted";
      },
      (error) => {
        ok = false;
        detail = `tamper corrupted-commitment: ${firstLine(error.message)}`;
      },
    );
  }
  check(label, ok, detail);
}

/** Tamper "flipped-listing-name": one blob name in the listing the checks are shown differs from the fetched object in its last character. */
function flipOneBlobName(listings) {
  const prefixes = new Map(listings.prefixes);
  const [prefix, entries] = [...prefixes][0];
  const [first, ...rest] = entries;
  prefixes.set(prefix, [{ ...first, name: `${first.name.slice(0, -1)}${first.name.endsWith("a") ? "b" : "a"}` }, ...rest]);
  return { ...listings, prefixes };
}

async function fetchListings(S, root) {
  const { client } = S;
  const at = (path = "") => `/ipfs/${root}${path}`;
  const rootEntries = await client.ipfsLs(at());
  const current = await client.ipfsLs(at("/current"));
  const prefixes = new Map();
  for (const entry of current) if (/^[a-z2-7]{2}$/.test(entry.name)) prefixes.set(entry.name, await client.ipfsLs(at(`/current/${entry.name}`)));
  const manifests = await client.ipfsLs(at("/manifests"));
  return { rootEntries, current, prefixes, manifests };
}

/** Steps 3a to 3c against the node's current root: one-level listings, ciphertext, key-material search, manifest content. */
export async function inspectRoot(S, label, { sequence, tamperPoint }) {
  const { client, tb } = S;
  const root = (await client.filesStat(S.demoRoot)).cid;
  const keyId = (await client.keyList()).find((key) => key.name === KEY)?.id ?? "";
  const resolved = await client.nameResolve(keyId).catch(() => "unresolved");
  check(`${label}: name/resolve of the owned key points at the immutable root inspected below`, resolved === `/ipfs/${root}`, `${resolved} vs /ipfs/${root}`);
  const listings = await fetchListings(S, root);
  const problems = checkNodeLayout({ root: listings.rootEntries, current: listings.current, prefixes: listings.prefixes, manifests: listings.manifests });
  check(`${label}: one-level listings match the encrypted layout (only current, manifests, manifest.enc, keyslots.json; two-character prefix folders; 52-character blob names; no stray entry)`, problems.length === 0, problems.slice(0, 3).join("; "));
  const keyslotsBytes = await client.gatewayFetch(root, "keyslots.json");
  const manifestBytes = await client.gatewayFetch(root, "manifest.enc");
  const blobs = new Map();
  for (const [prefix, entries] of listings.prefixes) for (const entry of entries) if (/^[a-z2-7]{52}$/.test(entry.name)) blobs.set(entry.name, Buffer.from(await client.gatewayFetch(root, `current/${prefix}/${entry.name}`)));
  const tamper = tamperPoint !== undefined && TAMPER_AT[S.opts.tamper] === tamperPoint ? S.opts.tamper : undefined;
  if (tamper === "title-in-blob") {
    // Same length, same header: only the plaintext search can notice this.
    const [name, bytes] = [...blobs][0];
    const planted = Buffer.from(bytes);
    planted.write("# Welcome", BLOB_HEADER_BYTES);
    blobs.set(name, planted);
  }
  const shownListings = tamper === "flipped-listing-name" ? flipOneBlobName(listings) : listings;
  if (S.keys === undefined) await unlockForInspection(S, keyslotsBytes);
  else check(`${label}: keyslots.json is byte-identical to the first inspection`, Buffer.compare(Buffer.from(keyslotsBytes), S.keyslotsBytes) === 0);
  const names = [...shownListings.rootEntries, ...shownListings.current, ...shownListings.manifests, ...[...shownListings.prefixes.values()].flat()].map((entry) => entry.name).join("\n");
  const objects = [["listing names", Buffer.from(names)], ["keyslots.json", Buffer.from(keyslotsBytes)], ["manifest.enc", Buffer.from(manifestBytes)], ...[...blobs].map(([name, bytes]) => [`blob ${name.slice(0, 8)}`, bytes])];
  const plainHit = objects.map(([name, bytes]) => [name, findNeedle(bytes, S.plainNeedles)]).find(([, hit]) => hit !== undefined);
  check(`${label}: no recorded title, path, folder name or body word occurs in any listing name or fetched byte (${objects.length} objects)`, plainHit === undefined, plainHit === undefined ? "" : `${plainHit[0]} contains ${plainHit[1]}`);
  const keyHit = S.keyNeedles === undefined ? undefined : objects.map(([name, bytes]) => [name, findNeedle(bytes, S.keyNeedles)]).find(([, hit]) => hit !== undefined);
  if (S.keyNeedles !== undefined) check(`${label}: neither the raw vault content key, the key-encryption key nor the passphrase (raw, hex, base64, base32) occurs in any fetched byte`, keyHit === undefined, keyHit === undefined ? "" : `${keyHit[0]} contains ${keyHit[1]}`);
  const manifest = await tb.decodeManifestFile(S.keys, manifestBytes).catch((error) => {
    check(`${label}: manifest.enc authenticates and decodes under the vault keys`, false, firstLine(error.message));
    return undefined;
  });
  if (manifest === undefined) return { root, manifest: undefined, blobs, historyCount: listings.manifests.length };
  // Tamper "stale-sequence": the checks are shown a manifest one sequence behind; the returned manifest (used by later steps) is the real one.
  const shown = tamper === "stale-sequence" ? { ...manifest, sequence: manifest.sequence - 1 } : manifest;
  await manifestChecks(S, label, { manifest: shown, blobs, listings: shownListings, sequence, keyslotsBytes });
  return { root, manifest, blobs, manifestBytes: Buffer.from(manifestBytes), historyCount: listings.manifests.length };
}

async function manifestChecks(S, label, { manifest, blobs, listings, sequence, keyslotsBytes }) {
  const { client, tb } = S;
  const entries = Object.entries(manifest.files);
  const current = await client.filesStat(`${S.demoRoot}/current`);
  const keySlotsVaultId = tb.parseKeySlots(keyslotsBytes).vaultId;
  check(`${label}: the fetched manifest decrypts, has sequence ${sequence}, the vault's id and rootCID equal to the CID of current/`, manifest.sequence === sequence && manifest.vaultId === keySlotsVaultId && manifest.rootCID === current.cid, `sequence ${manifest.sequence}, rootCID ${manifest.rootCID === current.cid ? "matches" : "differs"}`);
  const local = new Map(S.files.map((file) => [file.path, file]));
  const mismatched = entries.filter(([path, entry]) => local.get(path)?.size !== entry.size || local.get(path)?.sha256 !== entry.sha256);
  check(`${label}: the manifest lists ${entries.length} paths (at least ${MIN_PUBLISHED_FILES}), including the repetitive note, each with the local size and sha256`, entries.length >= MIN_PUBLISHED_FILES && manifest.files[LARGE_NOTE] !== undefined && mismatched.length === 0, mismatched.slice(0, 2).map(([path]) => path).join(", "));
  const listed = [...listings.prefixes.values()].flat().map((entry) => entry.name).filter((name) => /^[a-z2-7]{52}$/.test(name)).sort().join(",");
  const named = entries.map(([, entry]) => entry.blob).sort().join(",");
  check(`${label}: the blob names in the listing are exactly the manifest's node names (each recomputed from the path)`, listed === named);
  const byBlob = new Map(entries.map(([, entry]) => [entry.blob, entry]));
  const bad = [...blobs].filter(([name, bytes]) => {
    const entry = byBlob.get(name);
    return bytes.length < BLOB_HEADER_BYTES || bytes.subarray(0, 4).toString("latin1") !== BLOB_MAGIC_TEXT || bytes[4] !== 1 || bytes[5] !== BLOB_EXPONENT || entry === undefined || bytes.length !== tb.blobLength(entry.size);
  });
  check(`${label}: every blob starts with the magic ISBL, version 1, exponent ${BLOB_EXPONENT} and has exactly 22 + 28n + size bytes`, bad.length === 0, bad.slice(0, 2).map(([name]) => name.slice(0, 8)).join(", "));
  const large = manifest.files[LARGE_NOTE];
  const body = large === undefined ? undefined : blobs.get(large.blob)?.subarray(BLOB_HEADER_BYTES);
  const entropy = body === undefined ? 0 : byteEntropy(body);
  check(`${label}: the ${LARGE_NOTE_BYTES}-byte repetitive note's blob body has byte entropy of at least ${MIN_ENTROPY} bits per byte`, entropy >= MIN_ENTROPY, `${entropy.toFixed(4)} bits/byte over ${body?.length ?? 0} bytes`);
}
