// Reference ENCRYPTOR and vector generator paired with reference-decryptor.ts (test-only, node:crypto only).
// The AAD, header and slot constructions below are re-typed from the specification rather than imported from the
// decryptor, so a round trip between the two also compares two readings. Nothing here imports the production crypto module.
// Emit the vectors: node --experimental-strip-types tests/support/reference-decryptor-fixtures.ts
import * as nodeCrypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { b32Encode, canonicalPassphrase, generatePassphrase, hkdf, passphraseCheck, nodeKek, sha256hex, u32, u64, type KekFn, type Json } from "./reference-decryptor.ts";

export type Rand = (n: number) => Buffer;
const sha = (s: string | Uint8Array): Buffer => nodeCrypto.createHash("sha256").update(s).digest();
const cat = (...p: Uint8Array[]): Buffer => Buffer.concat(p);
const ascii = (s: string): Buffer => Buffer.from(s, "utf8");
export const detRand = (seed: string): Rand => {
  let c = 0;
  return (n) => { const ps: Buffer[] = []; for (let len = 0; len < n; len += 32) ps.push(sha(`${seed}:${c++}`)); return cat(...ps).subarray(0, n); };
};
export const secureRand: Rand = (n) => nodeCrypto.randomBytes(n);
const sortDeep = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v;
function gcmSeal(key: Uint8Array, nonce: Uint8Array, pt: Uint8Array, aad: Uint8Array): Buffer {
  const c = nodeCrypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  c.setAAD(aad);
  return cat(c.update(pt), c.final(), c.getAuthTag());
}

export interface Keys { vck: Buffer; vaultId: Buffer }
export const nameOf = (k: Keys, path: string): Buffer =>
  nodeCrypto.createHmac("sha256", hkdf(k.vck, k.vaultId, "ipfs-sync/name/v1", 32)).update(Buffer.from(path, "utf8")).digest();

export function encryptBlob(plain: Uint8Array, k: Keys, name: Uint8Array, rand: Rand, exp = 23): Buffer {
  const fileId = rand(16), header = cat(ascii("ISBL"), Buffer.from([1, exp]), fileId), key = hkdf(k.vck, fileId, "ipfs-sync/file/v1", 32);
  const size = 2 ** exp, n = Math.max(1, Math.ceil(plain.length / size)), segs: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const aad = cat(ascii("ipfs-sync/blob/v1"), k.vaultId, header, name, u64(i), Buffer.from([i === n - 1 ? 1 : 0]));
    const nonce = rand(12);
    segs.push(cat(nonce, gcmSeal(key, nonce, plain.subarray(i * size, (i + 1) * size), aad)));
  }
  return cat(header, ...segs);
}
export const blobFileId = (blob: Uint8Array): string => Buffer.from(blob.subarray(6, 22)).toString("hex");

export interface SlotParams { m: number; t: number; p: number }
export interface SlotInputs extends Keys { passphrase: string; slotId: Buffer; salt: Buffer; nonce: Buffer; params: SlotParams; kek?: KekFn }
/** Returns keyslots.json bytes plus the intermediate values used, for vectors. */
export function createKeyslots(i: SlotInputs): { bytes: Buffer; kek: Buffer; wrapKey: Buffer; commitInfo: Buffer; commit: Buffer; aad: Buffer; ct: Buffer } {
  const { m, t, p } = i.params;
  const kek = Buffer.from((i.kek ?? nodeKek)(ascii(canonicalPassphrase(i.passphrase)), i.salt, m, t, p, 32));
  const commitInfo = cat(ascii("ipfs-sync/slot/commit/v1"), i.slotId, u32(19), u32(m), u32(t), u32(p), u32(32), i.salt);
  const commit = hkdf(kek, i.vaultId, commitInfo, 32), wrapKey = hkdf(kek, i.vaultId, "ipfs-sync/slot/wrap/v1", 32);
  const aad = cat(ascii("ipfs-sync/slot/v1"), i.vaultId, i.slotId, u32(19), u32(m), u32(t), u32(p), u32(32), i.salt, ascii("argon2id"), Buffer.from([0]), ascii("aes-256-gcm"));
  const ct = gcmSeal(wrapKey, i.nonce, i.vck, aad);
  const doc = { version: 1, vaultId: i.vaultId.toString("hex"), slots: [{ id: i.slotId.toString("hex"), type: "passphrase",
    kdf: { alg: "argon2id", v: 19, m, t, p, dkLen: 32, salt: i.salt.toString("base64") },
    wrap: { alg: "aes-256-gcm", nonce: i.nonce.toString("base64"), ct: ct.toString("base64") }, commit: commit.toString("base64") }] };
  return { bytes: Buffer.from(JSON.stringify(sortDeep(doc), null, 2) + "\n"), kek, wrapKey, commitInfo, commit, aad, ct };
}

export interface ManifestInput { sequence: number; rootCID: string; files: Record<string, { plain: Uint8Array; blob: Uint8Array }>; publishedAt?: string; device?: string; excludesHash?: string }
export function buildManifest(k: Keys, m: ManifestInput): Record<string, unknown> {
  const files = Object.fromEntries(Object.entries(m.files).map(([path, f]) => [path, {
    sha256: sha256hex(f.plain), size: f.plain.length, blob: b32Encode(nameOf(k, path)), fileId: blobFileId(f.blob), cid: "b" + b32Encode(sha(f.blob)) }]));
  return { version: 2, vaultId: k.vaultId.toString("hex"), sequence: m.sequence, rootCID: m.rootCID, publishedAt: m.publishedAt ?? "2026-09-30T00:00:00.000Z",
    device: m.device ?? "ref-device", excludesHash: m.excludesHash ?? sha256hex(Buffer.from("ref-excludes")), files };
}
export const serializeManifest = (m: unknown): string => JSON.stringify(sortDeep(m));
export function encryptManifestText(text: string, k: Keys, rand: Rand): { bytes: Buffer; header: Buffer; aad: Buffer } {
  const header = cat(ascii("ISMF"), Buffer.from([2]), rand(12));
  const aad = cat(ascii("ipfs-sync/manifest/v1"), k.vaultId, header);
  const key = hkdf(k.vck, k.vaultId, "ipfs-sync/manifest/v1", 32);
  return { bytes: cat(header, gcmSeal(key, header.subarray(5), Buffer.from(text, "utf8"), aad)), header, aad };
}

// ---- vectors: fixed inputs, every output computed with node:crypto ----
const hx = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export function buildVectors(): Json {
  const k: Keys = { vck: sha("ref-vector/vck"), vaultId: sha("ref-vector/vaultId").subarray(0, 16) as Buffer };
  const slotId = sha("ref-vector/slotId").subarray(0, 16) as Buffer, salt = sha("ref-vector/salt").subarray(0, 16) as Buffer, nonce = sha("ref-vector/wrapNonce").subarray(0, 12) as Buffer;
  const passphrase = generatePassphrase(detRand("ref-vector/passphrase"));
  const gen = [1, 2, 3].map((n) => generatePassphrase(detRand(`ref-vector/passphrase/${n}`)));
  const mutations = (() => { const c = canonicalPassphrase(passphrase); let n = 0, rejected = 0; for (let i = 0; i < 25; i++) for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") { if (ch === c[i]) continue; n++; try { canonicalPassphrase(c.slice(0, i) + ch + c.slice(i + 1)); } catch { rejected++; } } return { tried: n, rejected }; })();
  const foldBypass = (): string[] => { // an otherwise valid passphrase with S or I replaced by the look-alike that toUpperCase() would fold
    const out: string[] = [];
    for (const [from, to] of [["S", "\u017f"], ["I", "\u0131"]] as const) for (let n = 0; n < 500; n++) { const g = generatePassphrase(detRand(`ref-vector/fold/${from}/${n}`)); if (g.includes(from)) { out.push(g.replace(from, to)); break; } }
    return out;
  };
  const phrase = (p: string) => { const t = p.replaceAll(" ", "").toUpperCase(); return { input: p, symbols: t.length, expectedCheck: passphraseCheck(t.slice(0, 23)), presentedCheck: t.slice(23), rejected: (() => { try { canonicalPassphrase(p); return false; } catch { return true; } })() }; };
  const bulk = (() => { const r = detRand("ref-vector/bulk"); let ok = 0; for (let i = 0; i < 10000; i++) { const g = generatePassphrase(r); if (canonicalPassphrase(g.toLowerCase().replaceAll("-", " ")) === g.replaceAll("-", "")) ok++; } return { count: 10000, valid: ok }; })();
  const slot = (params: SlotParams) => createKeyslots({ ...k, passphrase, slotId, salt, nonce, params });
  const def = slot({ m: 65536, t: 3, p: 1 }), floor = slot({ m: 19456, t: 2, p: 1 });
  const rand = detRand("ref-vector/rand"), names = ["Quarterly plan.md", "__proto__", "café.md", "café.md"];
  const b32Last = b32Encode(nameOf(k, names[0]!));
  const nonCanonical = b32Last.slice(0, 51) + "abcdefghijklmnopqrstuvwxyz234567"[("abcdefghijklmnopqrstuvwxyz234567".indexOf(b32Last[51]!) | 1)];
  const blobSpecs: Array<[string, Buffer, number]> = [["empty", Buffer.alloc(0), 23], ["100-bytes", rand(100), 23], ["two-segments-exp16", detRand("ref-vector/big")(65546), 16]];
  const blobs = blobSpecs.map(([label, plain, exp], n) => {
    const path = `blob-${label}.md`, name = nameOf(k, path), blob = encryptBlob(plain, k, name, detRand(`ref-vector/blob/${n}`), exp);
    return { label, path, exp, nodeName: b32Encode(name), nodeNameRaw: hx(name), plaintextSha256: sha256hex(plain), plaintextHex: plain.length <= 100 ? hx(plain) : null, blobHex: hx(blob), blobLength: blob.length, fileId: blobFileId(blob) };
  });
  const entryPlain = ascii("reference vector note\n"), entryBlob = encryptBlob(entryPlain, k, nameOf(k, "a.md"), detRand("ref-vector/entry"));
  const mText = serializeManifest(buildManifest(k, { sequence: 2, rootCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", files: { "a.md": { plain: entryPlain, blob: entryBlob } } }));
  const env = encryptManifestText(mText, k, detRand("ref-vector/manifest"));
  return {
    generator: "tests/support/reference-decryptor-fixtures.ts (node:crypto only)",
    inputs: { vck: hx(k.vck), vaultId: hx(k.vaultId), slotId: hx(slotId), salt: hx(salt), wrapNonce: hx(nonce), passphrase, canonicalPassphrase: canonicalPassphrase(passphrase) },
    derivations: {
      nameKey: hx(hkdf(k.vck, k.vaultId, "ipfs-sync/name/v1", 32)), manifestKey: hx(hkdf(k.vck, k.vaultId, "ipfs-sync/manifest/v1", 32)),
      fileKeyForFileId0: hx(hkdf(k.vck, Buffer.alloc(16), "ipfs-sync/file/v1", 32)),
      u32Of65536: hx(u32(65536)), u64OfIndex2pow32plus5: hx(u64(2n ** 32n + 5n)),
    },
    slotDefaultParams: { params: { m: 65536, t: 3, p: 1 }, kek: hx(def.kek), commitInfo: hx(def.commitInfo), commit: hx(def.commit), wrapKey: hx(def.wrapKey), aad: hx(def.aad), wrappedVck: hx(def.ct), keyslotsJson: def.bytes.toString("utf8"), keyslotsSha256: sha256hex(def.bytes) },
    slotFloorParams: { params: { m: 19456, t: 2, p: 1 }, kek: hx(floor.kek), commit: hx(floor.commit), keyslotsJson: floor.bytes.toString("utf8") },
    passphraseCases: {
      checkLabel: "ipfs-sync/passphrase/check/v1",
      accepted: [...gen, gen[0]!.toLowerCase(), gen[1]!.replaceAll("-", ""), ` ${gen[2]!.replaceAll("-", " ")} `].map((s) => ({ input: s, canonical: canonicalPassphrase(s) })),
      humanPhrases: [phrase("Correct Horse Battery Staple"), phrase("CorrectHorseBatteryStaple")],
      singleSymbolMutationsOfPrimary: mutations, bulkGenerated: bulk,
      foldBypassRejected: foldBypass(),
      rejected: [gen[0]!.slice(0, -1), gen[0]! + "A", gen[0]!.slice(0, -1) + "1", gen[0]!.replaceAll("-", "_"), "Correct Horse Battery Staple", "CorrectHorseBatteryStaple"],
    },
    nodeNames: { entries: names.map((p) => ({ path: p, name: b32Encode(nameOf(k, p)) })), lonePathsRejected: ["a\ud800b", "\udc00", "x\ud83d"], nonCanonicalLastChar: nonCanonical, canonicalLastChar: b32Last },
    blobs,
    manifest: { plaintext: mText, header: hx(env.header), aad: hx(env.aad), manifestEncHex: hx(env.bytes), rootCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", historyFileName: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.enc", entryBlobHex: hx(entryBlob), entryPath: "a.md", entryFileId: blobFileId(entryBlob), entryPlaintextHex: hx(entryPlain) },
  } as Json;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = new URL("./reference-vectors.json", import.meta.url);
  writeFileSync(out, JSON.stringify(buildVectors(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  process.stdout.write(`wrote ${out.pathname}\n`);
}
