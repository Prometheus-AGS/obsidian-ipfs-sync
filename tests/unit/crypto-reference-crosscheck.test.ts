// PERMANENT two-way cross-check between the production crypto module and the independent reference
// (tests/support/reference-decryptor.ts, written from the spec text). Each side uses its own randomness.
// A failure here is a real disagreement between two readings of the spec: fix the spec or one side, never the test.
import * as nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { blobNameFor, canonicalizePassphraseText, createKeySlots, decryptBlobBytes, encryptBlobBytes, unlockKeySlotsBytes, type Bytes, type CanonicalPassphrase, type VaultKeys } from "../../src/crypto";
import { parseStrictJson } from "../../src/crypto/strict-json";
import { decryptManifestEnvelope, encryptManifestEnvelope } from "../../src/crypto/manifest-envelope";
import { asGenerated } from "../../src/crypto/testing/generated-passphrase";
import { decryptBlobBytesUnchecked, encryptBlobBytesWith } from "../../src/crypto/blob";
import { parseManifestV2 } from "../../src/sync/encrypted-manifest";
import * as R from "../support/reference-decryptor";
import {
  buildManifest, createKeyslots, encryptBlob, encryptManifestText, nameOf, secureRand, serializeManifest, type Keys,
} from "../support/reference-decryptor-fixtures";

const FLOOR = { m: 19456, t: 2, p: 1 };
const PASS = R.generatePassphrase(secureRand);
const B = (u: Uint8Array): Bytes => Uint8Array.from(u);
const passBytes = (text: string): CanonicalPassphrase => canonicalizePassphraseText(text);
const ok = async (f: () => unknown): Promise<boolean> => { try { await f(); return true; } catch { return false; } };
const rand = (n: number): Buffer => nodeCrypto.randomBytes(n);
const SIZES: Array<[string, number, number]> = [["empty", 0, 23], ["1 byte", 1, 23], ["exactly one segment", 65536, 16], ["one segment + 1 byte", 65537, 16], ["three segments", 2 * 65536 + 1, 16], ["one 8 MiB segment", 5, 23]];
const tally: Record<string, number> = {};
const count = (k: string, n = 1): void => { tally[k] = (tally[k] ?? 0) + n; };

interface Side { prodKeys: VaultKeys; ref: Keys; slotBytes: Uint8Array }
async function productionVault(): Promise<Side> {
  const created = await createKeySlots({ passphrase: asGenerated(PASS), params: FLOOR });
  const u = R.unlockKeyslots(created.bytes, PASS);
  expect(u.vaultId.toString("hex")).toBe(created.keys.vaultId);
  return { prodKeys: created.keys, ref: { vck: u.vck, vaultId: u.vaultId }, slotBytes: created.bytes };
}
async function referenceVault(): Promise<Side> {
  const ref: Keys = { vck: rand(32), vaultId: rand(16) };
  const slotBytes = createKeyslots({ ...ref, passphrase: PASS, slotId: rand(16), salt: rand(16), nonce: rand(12), params: FLOOR }).bytes;
  const un = await unlockKeySlotsBytes(slotBytes, passBytes(PASS.toLowerCase().replaceAll("-", " ")));
  expect(un.keys.vaultId).toBe(ref.vaultId.toString("hex"));
  return { prodKeys: un.keys, ref, slotBytes };
}

describe("cross-check (a) production encrypts, reference decrypts", () => {
  it("key slots, blobs of every shape, manifest.enc", async () => {
    const { prodKeys, ref } = await productionVault(); count("a.keyslots");
    const entries: Record<string, { plain: Buffer; blob: Buffer }> = {};
    for (const [label, size, exp] of SIZES) {
      const plain = rand(size), path = `dir/${label}.md`, name = await blobNameFor(prodKeys, path);
      expect(name, label).toBe(R.nodeName(ref.vck, ref.vaultId, path));
      const { blob, fileId } = await encryptBlobBytesWith(prodKeys, name, B(plain), { exponent: exp });
      expect(blob.length).toBe(22 + 28 * Math.max(1, Math.ceil(size / 2 ** exp)) + size);
      const got = R.decryptBlob(blob, { ...ref, nodeName: R.b32Decode(name) });
      expect(Buffer.from(got).equals(plain), label).toBe(true);
      expect(R.blobHeader(blob).fileId.toString("hex")).toBe(fileId);
      entries[path] = { plain, blob: Buffer.from(blob) }; count("a.blobs");
    }
    const text = serializeManifest(buildManifest(ref, { sequence: 7, rootCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", files: entries }));
    const env = await encryptManifestEnvelope(prodKeys, new TextEncoder().encode(text));
    const m = R.decryptManifest(env, ref.vck, ref.vaultId);
    expect(m.sequence).toBe(7); expect(Object.keys(m.files).length).toBe(SIZES.length);
    for (const [p, e] of Object.entries(entries)) expect(R.readVaultFile(m, p, e.blob, m.files[p]!.blob, ref).equals(e.plain)).toBe(true);
    count("a.manifest");
  }, 120_000);
});

describe("cross-check (b) reference encrypts, production decrypts", () => {
  it("key slots, blobs of every shape, manifest.enc", async () => {
    const { prodKeys, ref } = await referenceVault(); count("b.keyslots");
    const entries: Record<string, { plain: Buffer; blob: Buffer }> = {};
    for (const [label, size, exp] of SIZES) {
      const plain = rand(size), path = `dir/${label}.md`, name = nameOf(ref, path);
      expect(await blobNameFor(prodKeys, path)).toBe(R.b32Encode(name));
      const blob = encryptBlob(plain, ref, name, secureRand, exp);
      const got = await decryptBlobBytesUnchecked(prodKeys, R.b32Encode(name), blob, R.blobHeader(blob).fileId.toString("hex"));
      expect(Buffer.from(got).equals(plain), label).toBe(true);
      entries[path] = { plain, blob }; count("b.blobs");
    }
    const text = serializeManifest(buildManifest(ref, { sequence: 3, rootCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", files: entries }));
    const env = encryptManifestText(text, ref, secureRand).bytes;
    expect(new TextDecoder().decode(await decryptManifestEnvelope(prodKeys, env))).toBe(text);
    count("b.manifest");
  }, 120_000);
});

describe("cross-check (c) mutated inputs: both readers make the same accept/reject decision", () => {
  const decisions: Array<{ what: string; prod: boolean; ref: boolean }> = [];
  const agree = (what: string, prod: boolean, ref: boolean): void => { decisions.push({ what, prod, ref }); };
  it("blobs (bit flip of every byte, truncation at every length, extension, header edits, empty final segment)", async () => {
    const { prodKeys, ref } = await productionVault();
    const path = "n.md", name = await blobNameFor(prodKeys, path), nameRaw = R.b32Decode(name);
    const plain = rand(150), { blob } = await encryptBlobBytes(prodKeys, name, B(plain));
    const both = async (what: string, b: Uint8Array): Promise<void> => {
      agree(what, await ok(() => decryptBlobBytesUnchecked(prodKeys, name, b)), await ok(() => R.decryptBlob(b, { ...ref, nodeName: nameRaw })));
    };
    await both("unmodified", blob);
    for (let i = 0; i < blob.length; i++) { const x = Buffer.from(blob); x[i]! ^= 1; await both(`flip byte ${i}`, x); }
    for (let n = 0; n < blob.length; n++) await both(`truncate ${n}`, blob.subarray(0, n));
    for (const extra of [1, 12, 27, 28, 29, 100]) await both(`extend ${extra}`, Buffer.concat([blob, rand(extra)]));
    for (let e = 0; e < 32; e++) { const x = Buffer.from(blob); x[5] = e; await both(`exponent ${e}`, x); }
    for (const v of [0, 2, 255]) { const x = Buffer.from(blob); x[4] = v; await both(`version ${v}`, x); }
    const x = Buffer.from(blob); x[0] = 0x58; await both("magic", x);
    // multi-segment structure at exponent 16: boundaries, duplicated / swapped / dropped segments
    const big = await encryptBlobBytesWith(prodKeys, name, B(rand(2 * 65536 + 9)), { exponent: 16 }), b = big.blob, stride = 65536 + 28;
    const seg = (i: number): Buffer => Buffer.from(b.subarray(22 + i * stride, Math.min(22 + (i + 1) * stride, b.length))), h = Buffer.from(b.subarray(0, 22));
    await both("big unmodified", b);
    await both("big drop last", Buffer.concat([h, seg(0), seg(1)]));
    await both("big swap", Buffer.concat([h, seg(1), seg(0), seg(2)]));
    await both("big dup", Buffer.concat([h, seg(0), seg(0), seg(2)]));
    for (const cut of [22 + stride - 1, 22 + stride, 22 + stride + 1, 22 + 2 * stride, 22 + 2 * stride + 27, 22 + 2 * stride + 28]) await both(`big cut ${cut}`, b.subarray(0, cut));
    // an AUTHENTIC empty final segment after a full one (final holds 1..2^exp bytes, so it must be refused)
    const one = await encryptBlobBytesWith(prodKeys, name, B(rand(65536)), { exponent: 16 });
    const fid = Buffer.from(one.blob.subarray(6, 22)), hdr = Buffer.from(one.blob.subarray(0, 22)), key = R.fileKey(ref.vck, fid);
    const seal = (pt: Buffer, i: number, fin: number): Buffer => {
      const nonce = rand(12), c = nodeCrypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      c.setAAD(R.blobAad({ label: "ipfs-sync/blob/v1", vaultId: ref.vaultId, header: hdr, nodeName: nameRaw, index: BigInt(i), final: fin }));
      return Buffer.concat([nonce, c.update(pt), c.final(), c.getAuthTag()]);
    };
    const full = rand(65536);
    await both("authentic full + empty final", Buffer.concat([hdr, seal(full, 0, 0), seal(Buffer.alloc(0), 1, 1)]));
    await both("authentic single full final", Buffer.concat([hdr, seal(full, 0, 1)]));
    const bad = decisions.filter((d) => d.prod !== d.ref);
    count("c.blob", decisions.length);
    expect(bad).toEqual([]);
    expect(decisions.filter((d) => d.prod).length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("manifest.enc (byte flips, bit flips of the header, truncations, extension)", async () => {
    const { prodKeys, ref } = await productionVault();
    const text = serializeManifest(buildManifest(ref, { sequence: 2, rootCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", files: {} }));
    const env = Buffer.from(await encryptManifestEnvelope(prodKeys, new TextEncoder().encode(text)));
    const cases: Array<[string, Buffer]> = [["unmodified", env]];
    for (let i = 0; i < env.length; i++) { const x = Buffer.from(env); x[i]! ^= 0x80; cases.push([`flip ${i}`, x]); }
    for (let n = 0; n < env.length; n += 3) cases.push([`truncate ${n}`, env.subarray(0, n)]);
    cases.push(["extend", Buffer.concat([env, Buffer.from([0])])]);
    for (const [what, b] of cases) agree(what, await ok(() => decryptManifestEnvelope(prodKeys, b)), await ok(() => R.decryptManifestEnvelope(b, ref.vck, ref.vaultId)));
    count("c.manifest", cases.length);
    expect(decisions.filter((d) => d.what === "unmodified" && d.prod && d.ref).length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("keyslots.json (semantic and byte-level edits)", async () => {
    const { slotBytes } = await productionVault();
    const sortDeep = (v: unknown): unknown => Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v;
    const emit = (d: unknown): Buffer => Buffer.from(JSON.stringify(sortDeep(d), null, 2) + "\n");
    const edit = (f: (d: any, s: any) => void): Buffer => { const d = JSON.parse(Buffer.from(slotBytes).toString()); f(d, d.slots[0]); return emit(d); }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const flipB64 = (b: string): string => { const x = Buffer.from(b, "base64"); x[0]! ^= 1; return x.toString("base64"); };
    const text = Buffer.from(slotBytes).toString();
    const cases: Array<[string, Buffer]> = [
      ["unmodified", Buffer.from(slotBytes)], ["m+1", edit((_d, s) => { s.kdf.m += 1; })], ["t=3", edit((_d, s) => { s.kdf.t = 3; })], ["m below floor", edit((_d, s) => { s.kdf.m = 19455; })],
      ["m above ceiling", edit((_d, s) => { s.kdf.m = 131073; })], ["t=1", edit((_d, s) => { s.kdf.t = 1; })], ["t=5", edit((_d, s) => { s.kdf.t = 5; })], ["p=2", edit((_d, s) => { s.kdf.p = 2; })],
      ["v=18", edit((_d, s) => { s.kdf.v = 18; })], ["dkLen=64", edit((_d, s) => { s.kdf.dkLen = 64; })], ["kdf alg", edit((_d, s) => { s.kdf.alg = "argon2i"; })], ["wrap alg", edit((_d, s) => { s.wrap.alg = "aes-128-gcm"; })],
      ["commit flip", edit((_d, s) => { s.commit = flipB64(s.commit); })], ["ct flip", edit((_d, s) => { s.wrap.ct = flipB64(s.wrap.ct); })], ["nonce flip", edit((_d, s) => { s.wrap.nonce = flipB64(s.wrap.nonce); })],
      ["salt flip", edit((_d, s) => { s.kdf.salt = flipB64(s.kdf.salt); })], ["salt 15 bytes", edit((_d, s) => { s.kdf.salt = Buffer.alloc(15).toString("base64"); })], ["id changed", edit((_d, s) => { s.id = "00".repeat(16); })],
      ["vaultId changed", edit((d) => { d.vaultId = "00".repeat(16); })], ["vaultId upper hex", edit((d) => { d.vaultId = d.vaultId.toUpperCase(); })], ["version 2", edit((d) => { d.version = 2; })],
      ["extra top field", edit((d) => { d.extra = 1; })], ["extra slot field", edit((_d, s) => { s.extra = 1; })], ["unknown slot first", edit((d) => { d.slots.unshift({ type: "future", x: [1, 2] }); })],
      ["only unknown slot", edit((d) => { d.slots = [{ type: "future" }]; })], ["no slots", edit((d) => { d.slots = []; })], ["9 slots", edit((d, s) => { d.slots = Array.from({ length: 9 }, () => s); })],
      ["float in unknown slot", edit((d) => { d.slots.push({ type: "future", x: 1.5 }); })], ["__proto__ member in unknown slot", Buffer.from(text.replace('"commit"', '"__proto__": 1,\n      "commit"'))],
      ["no trailing newline", Buffer.from(text.slice(0, -1))], ["CRLF", Buffer.from(text.replaceAll("\n", "\r\n"))], ["4-space indent", Buffer.from(JSON.stringify(JSON.parse(text), null, 4) + "\n")],
      ["compact", Buffer.from(JSON.stringify(JSON.parse(text)))], ["duplicate version", Buffer.from(text.replace('"version": 1', '"version": 1,\n  "version": 1'))],
      ["unpadded base64 commit", edit((_d, s) => { s.commit = s.commit.replace(/=+$/, ""); })], ["oversize", Buffer.alloc(16385, 32)], ["empty", Buffer.alloc(0)], ["garbage", rand(64)],
    ];
    const wrongPass = R.generatePassphrase(secureRand);
    for (const [what, b] of cases) agree(what, await ok(() => unlockKeySlotsBytes(b, passBytes(PASS))), await ok(() => R.unlockKeyslots(b, PASS)));
    for (const [what, b] of [cases[0]!, cases[5]!]) agree(`wrong passphrase / ${what}`, await ok(() => unlockKeySlotsBytes(b, passBytes(wrongPass))), await ok(() => R.unlockKeyslots(b, wrongPass)));
    count("c.keyslots", cases.length + 2);
  }, 180_000);

  it("passphrase canonicalisation (generated, single-symbol mutations, garbage)", async () => {
    const texts: string[] = [];
    for (let k = 0; k < 20; k++) {
      const g = R.generatePassphrase(secureRand), c = g.replaceAll("-", "");
      texts.push(g, g.toLowerCase(), c, g.replaceAll("-", " "), c.slice(0, 24), c + "A", c.slice(0, 24) + "1", `${c.slice(0, 12)}_${c.slice(13)}`);
      for (let i = 0; i < 25; i += 4) texts.push(c.slice(0, i) + (c[i] === "A" ? "B" : "A") + c.slice(i + 1));
    }
    texts.push("Correct Horse Battery Staple", "CorrectHorseBatteryStaple", "", "İ".repeat(25), "A".repeat(25), "a\tb");
    for (const t of texts) agree(`pass ${JSON.stringify(t)}`, await ok(() => canonicalizePassphraseText(t)), await ok(() => R.canonicalPassphrase(t)));
    count("c.passphrase", texts.length);
  });

  it("no disagreement anywhere, and at least 200 mutated inputs were compared", () => {
    const rejected = decisions.filter((d) => !d.prod && !d.ref).length, accepted = decisions.filter((d) => d.prod && d.ref).length;
    expect(decisions.length).toBeGreaterThanOrEqual(200);
    expect(decisions.filter((d) => d.prod !== d.ref)).toEqual([]);
    process.stdout.write(`crosscheck decisions=${decisions.length} both-accept=${accepted} both-reject=${rejected} tally=${JSON.stringify(tally)}\n`);
  });
});

describe("cross-check (d) node-name derivation", () => {
  it("agrees on 50 random paths including NFC/NFD, __proto__ and lone surrogates", async () => {
    const { prodKeys, ref } = await productionVault();
    const alphabet = Array.from("abcXYZ019 ./-_éü中😀́");
    const paths = ["café.md", "café.md".normalize("NFD"), "café".normalize("NFC"), "__proto__", "constructor", "a/b/__proto__", "😀.md"];
    while (paths.length < 50) paths.push(Array.from({ length: 1 + (rand(1)[0]! % 20) }, () => alphabet[rand(1)[0]! % alphabet.length]).join("") || "x");
    expect(new Set(paths.map((p) => R.nodeName(ref.vck, ref.vaultId, p))).size).toBeGreaterThanOrEqual(paths.length - 3);
    for (const p of paths) expect(await blobNameFor(prodKeys, p), p).toBe(R.nodeName(ref.vck, ref.vaultId, p));
    expect(R.nodeName(ref.vck, ref.vaultId, "café")).not.toBe(R.nodeName(ref.vck, ref.vaultId, "café"));
    for (const lone of ["a\ud800b", "\udc00", "x\ud83d", ""]) {
      expect(await ok(() => blobNameFor(prodKeys, lone)), JSON.stringify(lone)).toBe(false);
      expect(await ok(() => R.nodeName(ref.vck, ref.vaultId, lone)), JSON.stringify(lone)).toBe(false);
    }
    count("d.paths", paths.length + 4);
  });
});

describe("cross-check (e) frozen format rows (review G-06): one row each, both readers must agree with the decided reading", () => {
  let side: Side; let baseObj: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ROOT = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  beforeAll(async () => {
    side = await productionVault();
    const plain = rand(20), blob = encryptBlob(plain, side.ref, nameOf(side.ref, "a.md"), secureRand);
    baseObj = buildManifest(side.ref, { sequence: 4, rootCID: ROOT, files: { "a.md": { plain, blob } } });
  });
  const sortDeep = (v: unknown): unknown => Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v;
  const manifestText = (edit: (o: any) => void, raw?: (t: string) => string): Uint8Array => { const o = structuredClone(baseObj); edit(o); return new TextEncoder().encode((raw ?? ((t: string) => t))(JSON.stringify(sortDeep(o)))); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const code = async (f: () => unknown): Promise<string> => { try { await f(); return "accept"; } catch (e) { return String((e as { code?: string }).code ?? "raw"); } };
  const rows: Array<[string, () => Uint8Array, boolean]> = [
    ["baseline", () => manifestText(() => {}), true],
    ["device empty", () => manifestText((o) => { o.device = ""; }), false], ["device 1 code point", () => manifestText((o) => { o.device = "x"; }), true],
    ["device 64 code points", () => manifestText((o) => { o.device = "x".repeat(64); }), true], ["device 65 code points", () => manifestText((o) => { o.device = "x".repeat(65); }), false],
    ["device 64 astral emoji (128 UTF-16 units)", () => manifestText((o) => { o.device = "\u{1F600}".repeat(64); }), true], ["device 65 astral emoji", () => manifestText((o) => { o.device = "\u{1F600}".repeat(65); }), false],
    ["device lone surrogate (\\ud800)", () => manifestText((o) => { o.device = "a\ud800b"; }), false], ["device U+0000", () => manifestText((o) => { o.device = "a\u0000b"; }), false],
    ["device U+001F", () => manifestText((o) => { o.device = "a\u001fb"; }), false], ["device U+007F", () => manifestText((o) => { o.device = "a\u007fb"; }), false],
    ["device newline", () => manifestText((o) => { o.device = "a\nb"; }), false], ["device ASCII with space", () => manifestText((o) => { o.device = "my laptop-2"; }), true],
    ["device astral emoji", () => manifestText((o) => { o.device = "\u{1F600}"; }), true], ["device U+0080", () => manifestText((o) => { o.device = "a\u0080b"; }), true],
    ["device U+00A0", () => manifestText((o) => { o.device = "a\u00a0b"; }), true],
    ["publishedAt Feb 30", () => manifestText((o) => { o.publishedAt = "2026-02-30T00:00:00Z"; }), false], ["publishedAt 24:00:00", () => manifestText((o) => { o.publishedAt = "2026-09-30T24:00:00Z"; }), false],
    ["publishedAt leap day 2024", () => manifestText((o) => { o.publishedAt = "2024-02-29T12:00:00Z"; }), true], ["publishedAt Feb 29 2023", () => manifestText((o) => { o.publishedAt = "2023-02-29T00:00:00Z"; }), false],
    ["publishedAt century non-leap 1900-02-29", () => manifestText((o) => { o.publishedAt = "1900-02-29T00:00:00Z"; }), false], ["publishedAt 2000-02-29", () => manifestText((o) => { o.publishedAt = "2000-02-29T00:00:00Z"; }), true],
    ["publishedAt 3 fractional digits", () => manifestText((o) => { o.publishedAt = "2026-09-30T00:00:00.123Z"; }), true], ["publishedAt 4 fractional digits", () => manifestText((o) => { o.publishedAt = "2026-09-30T00:00:00.1234Z"; }), false],
    ["publishedAt month 13", () => manifestText((o) => { o.publishedAt = "2026-13-01T00:00:00Z"; }), false], ["publishedAt minute 60", () => manifestText((o) => { o.publishedAt = "2026-09-30T00:60:00Z"; }), false],
    ["publishedAt second 60", () => manifestText((o) => { o.publishedAt = "2026-09-30T00:00:60Z"; }), false], ["publishedAt offset +00:00", () => manifestText((o) => { o.publishedAt = "2026-09-30T00:00:00+00:00"; }), false],
    ["sequence 1e2", () => manifestText((o) => { o.sequence = 0; }, (t) => t.replace('"sequence":0', '"sequence":1e2')), false], ["sequence 1.0", () => manifestText((o) => { o.sequence = 0; }, (t) => t.replace('"sequence":0', '"sequence":1.0')), false],
    ["sequence -0", () => manifestText((o) => { o.sequence = 0; }, (t) => t.replace('"sequence":0', '"sequence":-0')), false], ["sequence 01", () => manifestText((o) => { o.sequence = 0; }, (t) => t.replace('"sequence":0', '"sequence":01')), false],
    ["sequence 100", () => manifestText((o) => { o.sequence = 100; }), true], ["entry size 1e1", () => manifestText((o) => { o.files["a.md"].size = 0; }, (t) => t.replace('"size":0', '"size":2e1')), false],
    ["entry cid 128 chars", () => manifestText((o) => { o.files["a.md"].cid = "b" + "a".repeat(127); }), true], ["entry cid 129 chars", () => manifestText((o) => { o.files["a.md"].cid = "b" + "a".repeat(128); }), false],
    ["rootCID 128 chars", () => manifestText((o) => { o.rootCID = "b" + "a".repeat(127); }), true], ["rootCID 129 chars", () => manifestText((o) => { o.rootCID = "b" + "a".repeat(128); }), false],
  ];
  for (const [name, make, want] of rows) {
    it(name, async () => {
      const bytes = make();
      const prod = await code(() => parseManifestV2(side.prodKeys, bytes)), ref = await code(() => R.parseManifest(bytes, side.ref.vck, side.ref.vaultId));
      process.stdout.write(`row [${name}] want=${want ? "accept" : "reject"} reference=${ref} production=${prod}\n`);
      expect(ref === "accept", `reference: ${ref}`).toBe(want);
      expect(prod === "accept", `production: ${prod}`).toBe(want);
    });
  }
  const nest = (n: number): string => "[".repeat(n) + "]".repeat(n);
  for (const [n, want] of [[32, true], [33, false]] as const) {
    it(`JSON nesting depth ${n}`, () => {
      const prod = (() => { try { parseStrictJson(nest(n)); return true; } catch { return false; } })(), ref = (() => { try { R.parseStrictJson(nest(n)); return true; } catch { return false; } })();
      process.stdout.write(`row [json depth ${n}] want=${want} reference=${ref} production=${prod}\n`);
      expect(ref).toBe(want); expect(prod).toBe(want);
    });
  }
  it("bad blob magic is malformed on both sides; version/exponent out of range are unsupported-format on both", async () => {
    const name = await blobNameFor(side.prodKeys, "m.md"), { blob } = await encryptBlobBytes(side.prodKeys, name, B(rand(10)));
    const cases: Array<[string, number, number, string]> = [["magic", 0, 0x58, "malformed"], ["version", 4, 2, "unsupported-format"], ["exponent 15", 5, 15, "unsupported-format"], ["exponent 25", 5, 25, "unsupported-format"]];
    for (const [label, at, v, want] of cases) {
      const x = Buffer.from(blob); x[at] = v;
      const prod = await code(() => decryptBlobBytesUnchecked(side.prodKeys, name, x)), ref = await code(() => R.decryptBlob(x, { ...side.ref, nodeName: R.b32Decode(name) }));
      process.stdout.write(`row [blob ${label}] want=${want} reference=${ref} production=${prod}\n`);
      expect(ref).toBe(want); expect(prod === want || prod === want.replace("malformed", "malformed-input"), `production: ${prod}`).toBe(true);
    }
  });
  it("28-byte final piece after a full segment is malformed on both sides", async () => {
    const name = await blobNameFor(side.prodKeys, "f.md"), { blob } = await encryptBlobBytesWith(side.prodKeys, name, B(rand(65536)), { exponent: 16 });
    const x = Buffer.concat([blob, rand(28)]);
    const prod = await code(() => decryptBlobBytesUnchecked(side.prodKeys, name, x)), ref = await code(() => R.decryptBlob(x, { ...side.ref, nodeName: R.b32Decode(name) }));
    process.stdout.write(`row [28-byte final piece] want=malformed reference=${ref} production=${prod}\n`);
    expect(ref).toBe("malformed"); expect(prod.startsWith("malformed"), `production: ${prod}`).toBe(true);
  });
  it("passphrase: U+017F and U+0131 embedded in an otherwise valid passphrase are rejected by both", () => {
    const vectors = (JSON.parse(readFileSync(new URL("../support/reference-vectors.json", import.meta.url), "utf8")) as { passphraseCases: { foldBypassRejected: string[] } }).passphraseCases.foldBypassRejected;
    expect(vectors.length).toBe(2);
    for (const t of vectors) {
      const prod = (() => { try { canonicalizePassphraseText(t); return "accept"; } catch { return "reject"; } })(), ref = (() => { try { R.canonicalPassphrase(t); return "accept"; } catch { return "reject"; } })();
      process.stdout.write(`row [fold bypass ${JSON.stringify(t)}] want=reject reference=${ref} production=${prod}\n`);
      expect(ref).toBe("reject"); expect(prod).toBe("reject");
    }
  });
});
