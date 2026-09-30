// Self-test of the independent reference decryptor against its OWN reference encryptor (task 2.5).
// This proves internal consistency of the second reading of the spec; it says nothing about the production module.
import * as nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as R from "../support/reference-decryptor";
import {
  blobFileId, buildManifest, buildVectors, createKeyslots, detRand, encryptBlob, encryptManifestText, nameOf, serializeManifest, type Keys,
} from "../support/reference-decryptor-fixtures";

const sha = (s: string): Buffer => nodeCrypto.createHash("sha256").update(s).digest();
const keys: Keys = { vck: sha("st/vck"), vaultId: sha("st/vault").subarray(0, 16) as Buffer };
const other: Keys = { vck: sha("st/vck2"), vaultId: sha("st/vault2").subarray(0, 16) as Buffer };
const PASS = R.generatePassphrase(detRand("st/pass")), WRONG = R.generatePassphrase(detRand("st/wrong"));
const ROOT = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const calls = { n: 0 };
const cheapKek: R.KekFn = (p, s, m, t, pp, len) => { calls.n++; return nodeCrypto.createHash("sha256").update(Buffer.concat([p, s, Buffer.from(`${m}/${t}/${pp}/${len}`)])).digest().subarray(0, len); };
const params = { m: 19456, t: 2, p: 1 };
const slotIn = { ...keys, passphrase: PASS, slotId: sha("st/slot").subarray(0, 16) as Buffer, salt: sha("st/salt").subarray(0, 16) as Buffer, nonce: sha("st/nonce").subarray(0, 12) as Buffer, params };
const slots = (over: Partial<typeof slotIn> = {}) => createKeyslots({ ...slotIn, kek: cheapKek, ...over }).bytes;
const sortDeep = (v: unknown): unknown => Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v;
const emit = (d: unknown): Buffer => Buffer.from(JSON.stringify(sortDeep(d), null, 2) + "\n");
const mutSlots = (bytes: Buffer, f: (doc: any, slot: any) => void): Buffer => { const d = JSON.parse(bytes.toString()); f(d, d.slots[0]); return emit(d); }; // eslint-disable-line @typescript-eslint/no-explicit-any
const codeOf = (f: () => unknown): string => { try { f(); return "NO-ERROR"; } catch (e) { return e instanceof R.RefError ? e.code : `RAW:${String(e)}`; } };
const unlock = (b: Buffer, p = PASS): R.Unlocked => R.unlockKeyslots(b, p, cheapKek);

describe("key slots", () => {
  it("round-trips with the injected KEK and with node argon2 at the floor", () => {
    expect(unlock(slots()).vck.equals(keys.vck)).toBe(true);
    expect(typeof nodeCrypto.argon2Sync).toBe("function");
    const real = createKeyslots({ ...slotIn }).bytes;
    expect(R.unlockKeyslots(real, PASS.toLowerCase().replaceAll("-", " ")).vck.equals(keys.vck)).toBe(true);
  });
  it("matches the RFC 9106 section 5.3 Argon2id vector on node:crypto (independent KDF cross-check)", () => {
    const tag = nodeCrypto.argon2Sync("argon2id", { message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), associatedData: Buffer.alloc(12, 4), parallelism: 4, tagLength: 32, memory: 32, passes: 3 });
    expect(tag.toString("hex")).toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  });
  it("wrong passphrase, corrupted commit and corrupted wrap all give the one outcome", () => {
    expect(codeOf(() => unlock(slots(), WRONG))).toBe("wrong-passphrase-or-damaged-slot");
    const flip = (b64: string): string => { const x = Buffer.from(b64, "base64"); x[0]! ^= 1; return x.toString("base64"); };
    expect(codeOf(() => unlock(mutSlots(slots(), (_d, s) => { s.commit = flip(s.commit); })))).toBe("wrong-passphrase-or-damaged-slot");
    expect(codeOf(() => unlock(mutSlots(slots(), (_d, s) => { s.wrap.ct = flip(s.wrap.ct); })))).toBe("wrong-passphrase-or-damaged-slot");
    expect(codeOf(() => unlock(mutSlots(slots(), (_d, s) => { s.kdf.m += 1; })))).toBe("wrong-passphrase-or-damaged-slot");
    expect(codeOf(() => unlock(mutSlots(slots(), (d) => { d.vaultId = "00".repeat(16); })))).toBe("wrong-passphrase-or-damaged-slot");
  });
  it("every slot-AAD component is authenticated", () => {
    const parsed = R.parseKeyslots(slots()), s = parsed.slots[0] as R.PassphraseSlot;
    const kek = cheapKek(Buffer.from(R.canonicalPassphrase(PASS)), s.salt, s.m, s.t, s.p, 32);
    const wrap = R.hkdf(kek, parsed.vaultId, R.LABEL.wrap);
    const open = (aad: Buffer): boolean => { const d = nodeCrypto.createDecipheriv("aes-256-gcm", wrap, s.nonce, { authTagLength: 16 }); d.setAAD(aad); d.setAuthTag(s.ct.subarray(32)); try { d.update(s.ct.subarray(0, 32)); d.final(); return true; } catch { return false; } };
    const good = R.slotAad(parsed.vaultId, s);
    expect(open(good)).toBe(true);
    for (const pos of [0, 17, 33, 49, 53, 57, 61, 65, 81, 89, 90, 100]) { const b = Buffer.from(good); b[pos]! ^= 1; expect(open(b), `aad byte ${pos}`).toBe(false); }
    expect(open(good.subarray(0, good.length - 1))).toBe(false);
  });
  it("refuses fixed-field, floor and ceiling violations before any derivation", () => {
    const cases: Array<[string, (s: any) => void, string]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["v=18", (s) => { s.kdf.v = 18; }, "unsupported-format"], ["dkLen=64", (s) => { s.kdf.dkLen = 64; }, "unsupported-format"],
      ["kdf alg", (s) => { s.kdf.alg = "argon2i"; }, "unsupported-format"], ["wrap alg", (s) => { s.wrap.alg = "aes-128-gcm"; }, "unsupported-format"],
      ["m=1024", (s) => { s.kdf.m = 1024; }, "kdf-params"], ["m=floor-1", (s) => { s.kdf.m = 19455; }, "kdf-params"], ["m=4GiB", (s) => { s.kdf.m = 4194304; }, "kdf-params"],
      ["m=ceil+1", (s) => { s.kdf.m = 131073; }, "kdf-params"], ["t=1", (s) => { s.kdf.t = 1; }, "kdf-params"], ["t=5", (s) => { s.kdf.t = 5; }, "kdf-params"],
      ["p=2", (s) => { s.kdf.p = 2; }, "kdf-params"], ["salt 15B", (s) => { s.kdf.salt = Buffer.alloc(15).toString("base64"); }, "kdf-params"],
      ["extra field", (s) => { s.extra = 1; }, "malformed"], ["wrap.ct 47B", (s) => { s.wrap.ct = Buffer.alloc(47).toString("base64"); }, "malformed"],
    ];
    for (const [name, f, code] of cases) { const doc = mutSlots(slots(), (_d, s) => f(s)); calls.n = 0; expect(codeOf(() => unlock(doc)), name).toBe(code); expect(calls.n, name).toBe(0); }
    const v2 = mutSlots(slots(), (d) => { d.version = 2; }); calls.n = 0; expect(codeOf(() => unlock(v2))).toBe("unsupported-format"); expect(calls.n).toBe(0);
  });
  it("accepts ceiling parameters as in-bounds (bounds only)", () => {
    expect(codeOf(() => R.parseKeyslots(mutSlots(slots(), (_d, s) => { s.kdf.m = 131072; s.kdf.t = 4; })))).toBe("NO-ERROR");
  });
  it("skips unknown slot types, refuses a lone one, and tries at most two passphrase slots", () => {
    const withUnknown = mutSlots(slots(), (d) => { d.slots.unshift({ type: "future", __proto__x: 1 }); d.slots[0].__proto__ = { polluted: true }; });
    expect(unlock(withUnknown).vck.equals(keys.vck)).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(codeOf(() => unlock(mutSlots(slots(), (d) => { d.slots = [{ type: "future" }]; })))).toBe("no-usable-slot");
    const three = mutSlots(slots(), (d, s) => { d.slots = [1, 2, 3].map((n) => { const c = structuredClone(s); c.id = sha(`x${n}`).subarray(0, 16).toString("hex"); return c; }); });
    calls.n = 0;
    expect(codeOf(() => unlock(three))).toBe("wrong-passphrase-or-damaged-slot"); expect(calls.n).toBe(2);
    expect(codeOf(() => R.parseKeyslots(mutSlots(slots(), (d, s) => { d.slots = Array.from({ length: 9 }, () => s); })))).toBe("oversize");
    expect(codeOf(() => R.parseKeyslots(Buffer.alloc(16385, 32)))).toBe("oversize");
  });
  it("refuses non-canonical documents: reorder, indent, duplicate key, base64, trailing newline, __proto__ member", () => {
    const ok = slots().toString();
    expect(codeOf(() => R.parseKeyslots(Buffer.from(ok.replace(/\n$/, ""))))).toBe("non-canonical");
    expect(codeOf(() => R.parseKeyslots(Buffer.from(JSON.stringify(JSON.parse(ok), null, 4) + "\n")))).toBe("non-canonical");
    expect(codeOf(() => R.parseKeyslots(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(ok)).reverse()), null, 2) + "\n")))).toBe("non-canonical");
    expect(codeOf(() => R.parseKeyslots(Buffer.from(ok)))).toBe("NO-ERROR");
    expect(codeOf(() => R.parseKeyslots(Buffer.from(ok.replace('"version": 1', '"version": 1,\n  "version": 1'))))).toBe("malformed");
    expect(codeOf(() => R.parseKeyslots(mutSlots(slots(), (_d, s) => { s.commit = s.commit.replace(/=+$/, ""); })))).toBe("non-canonical");
    expect(codeOf(() => R.parseKeyslots(Buffer.from(ok.replace('"version": 1', '"__proto__": 1,\n  "version": 1'))))).not.toBe("NO-ERROR");
    expect(Object.getPrototypeOf(R.parseStrictJson('{"__proto__": {"x": 1}}'))).toBe(null);
  });
  it("canonical passphrase: 23 symbols + 2 check symbols, everything else rejected as passphrase-format", () => {
    const canon = PASS.replaceAll("-", "");
    expect(PASS).toMatch(/^([A-Z2-7]{5}-){4}[A-Z2-7]{5}$/);
    expect(R.canonicalPassphrase(PASS.toLowerCase().replaceAll("-", " "))).toBe(canon);
    for (const bad of [canon.slice(0, 24), canon + "A", canon.slice(0, 24) + "1", canon.slice(0, 12) + "_" + canon.slice(13), canon.slice(0, 5) + "\t" + canon.slice(5), "Correct Horse Battery Staple", "CorrectHorseBatteryStaple"])
      expect(codeOf(() => R.canonicalPassphrase(bad)), bad).toBe("passphrase-format");
  });
  it("every single-symbol mutation is rejected (25 positions x 31 symbols)", () => {
    const canon = PASS.replaceAll("-", ""); let n = 0;
    for (let i = 0; i < 25; i++) for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") { if (ch === canon[i]) continue; n++; expect(codeOf(() => R.canonicalPassphrase(canon.slice(0, i) + ch + canon.slice(i + 1))), `${i}${ch}`).toBe("passphrase-format"); }
    expect(n).toBe(775);
  });
  it("10,000 seeded generated passphrases all validate and round-trip through display form", () => {
    const r = detRand("st/bulk");
    for (let i = 0; i < 10000; i++) { const g = R.generatePassphrase(r); expect(R.displayPassphrase(R.canonicalPassphrase(g))).toBe(g); }
  });
});

describe("blobs", () => {
  const name = nameOf(keys, "n.md"), ctx = { ...keys, nodeName: name };
  const plain100 = detRand("st/p100")(100), enc = (p: Buffer, e = 23, seed = "", k = keys, n = name) => encryptBlob(p, k, n, detRand(`st/${p.length}/${e}/${seed}`), e);
  it("round-trips across segment boundaries and follows the size arithmetic", () => {
    for (const len of [0, 1, 100, 65535, 65536, 65537, 131072, 131073, 200000]) {
      const p = detRand(`st/rt${len}`)(len), b = enc(p, 16), n = Math.max(1, Math.ceil(len / 65536));
      expect(b.length).toBe(22 + 28 * n + len);
      expect(R.decryptBlob(b, ctx).equals(p)).toBe(true);
    }
    expect(enc(Buffer.alloc(0)).length).toBe(50);
  });
  it("every single bit flip of a 100-byte blob fails", () => {
    const b = enc(plain100);
    for (let i = 0; i < b.length * 8; i++) { const x = Buffer.from(b); x[i >> 3]! ^= 1 << (i & 7); expect(codeOf(() => R.decryptBlob(x, ctx)), `bit ${i}`).not.toBe("NO-ERROR"); }
  });
  it("sampled flips of a three-segment blob (header, nonce, tag, and one bit per 4 KiB) fail", () => {
    const p = detRand("st/three")(65536 * 2 + 100), b = enc(p, 16), stride = 65536 + 28, every = new Set<number>(), sampled = new Set<number>();
    for (let i = 0; i < 22; i++) every.add(i);
    for (let sgm = 0; sgm < 3; sgm++) {
      const st = 22 + sgm * stride, en = sgm < 2 ? st + stride : b.length;
      for (let i = st; i < st + 12; i++) every.add(i);
      for (let i = en - 16; i < en; i++) every.add(i);
    }
    for (let i = 22; i < b.length; i += 4096) sampled.add(i);
    const flips: Array<[number, number]> = [...every].flatMap((q) => [0, 1, 2, 3, 4, 5, 6, 7].map((bit): [number, number] => [q, bit]));
    for (const q of sampled) flips.push([q, 0]);
    expect(flips.length).toBeGreaterThan(700);
    for (const [q, bit] of flips) { const x = Buffer.from(b); x[q]! ^= 1 << bit; expect(codeOf(() => R.decryptBlob(x, ctx)), `byte ${q} bit ${bit}`).not.toBe("NO-ERROR"); }
  });
  it("fails at every truncation of a 100-byte blob and at segment boundaries of a multi-segment blob", () => {
    const b = enc(plain100); for (let n = 0; n < b.length; n++) expect(codeOf(() => R.decryptBlob(b.subarray(0, n), ctx)), `cut ${n}`).not.toBe("NO-ERROR");
    const m = enc(detRand("st/m")(65536 * 2 + 5), 16), stride = 65536 + 28;
    for (const cut of [22 + stride, 22 + 2 * stride, 22 + stride - 1, 22 + stride + 1, 22 + 2 * stride - 1]) expect(codeOf(() => R.decryptBlob(m.subarray(0, cut), ctx)), `cut ${cut}`).not.toBe("NO-ERROR");
  });
  it("rejects extension, reorder, duplication, splice, wrong name, vault, key and file id", () => {
    const p = detRand("st/x")(65536 * 3), b = enc(p, 16), stride = 65536 + 28, seg = (i: number) => b.subarray(22 + i * stride, 22 + (i + 1) * stride), h = b.subarray(0, 22);
    const bad = [Buffer.concat([b, seg(0)]), Buffer.concat([h, seg(1), seg(0), seg(2)]), Buffer.concat([h, seg(0), seg(0), seg(2)]), Buffer.concat([h, seg(0), seg(1)]), Buffer.concat([b, Buffer.from("x")])];
    for (const x of bad) expect(codeOf(() => R.decryptBlob(x, ctx))).not.toBe("NO-ERROR");
    const alien = enc(detRand("st/y")(65536 * 3), 16, "alien"), spliced = Buffer.concat([h, seg(0), alien.subarray(22 + stride, 22 + 2 * stride), seg(2)]);
    expect(codeOf(() => R.decryptBlob(spliced, ctx))).not.toBe("NO-ERROR");
    expect(codeOf(() => R.decryptBlob(b, { ...ctx, nodeName: nameOf(keys, "other.md") }))).toBe("authentication");
    expect(codeOf(() => R.decryptBlob(b, { ...ctx, vaultId: other.vaultId }))).toBe("authentication");
    expect(codeOf(() => R.decryptBlob(b, { ...ctx, vck: other.vck }))).toBe("authentication");
    const fid = Buffer.from(b); fid[6]! ^= 1; expect(codeOf(() => R.decryptBlob(fid, ctx))).toBe("authentication");
  });
  it("structural negatives: exponent, version, magic, short segments", () => {
    const b = enc(plain100);
    const set = (i: number, v: number) => { const x = Buffer.from(b); x[i] = v; return x; };
    expect(codeOf(() => R.decryptBlob(set(5, 15), ctx))).toBe("unsupported-format"); expect(codeOf(() => R.decryptBlob(set(5, 25), ctx))).toBe("unsupported-format");
    expect(codeOf(() => R.decryptBlob(set(4, 2), ctx))).toBe("unsupported-format"); expect(codeOf(() => R.decryptBlob(set(0, 88), ctx))).toBe("malformed");
    expect(codeOf(() => R.decryptBlob(b.subarray(0, 22 + 27), ctx))).toBe("malformed");
    const two = enc(detRand("st/two")(65536 + 10), 16);
    expect(codeOf(() => R.decryptBlob(Buffer.concat([two.subarray(0, 100), two.subarray(110)]), ctx))).not.toBe("NO-ERROR"); // short non-final segment
    expect(codeOf(() => R.decryptBlob(Buffer.concat([two.subarray(0, 22 + 65536 + 28), Buffer.alloc(0)]), ctx))).not.toBe("NO-ERROR"); // final segment missing
  });
  it("mutating any AAD component on the reference side fails (label, vault id, header, node name, index, final flag)", () => {
    const b = enc(detRand("st/aad")(65536 + 10), 16), flip = (u: Uint8Array): Uint8Array => { const x = Buffer.from(u); x[0]! ^= 1; return x; };
    expect(R.decryptBlob(b, ctx, (a) => a).length).toBe(65546);
    const muts: Record<string, (a: R.BlobAadParts, i: number) => R.BlobAadParts> = {
      label: (a) => ({ ...a, label: "ipfs-sync/blob/v2" }), vaultId: (a) => ({ ...a, vaultId: flip(a.vaultId) }), header: (a) => ({ ...a, header: flip(a.header) }),
      nodeName: (a) => ({ ...a, nodeName: flip(a.nodeName) }), index: (a, i) => ({ ...a, index: BigInt(i) + 2n ** 32n }), final: (a) => ({ ...a, final: a.final ^ 1 }),
    };
    for (const [n, f] of Object.entries(muts)) expect(codeOf(() => R.decryptBlob(b, ctx, f)), n).toBe("authentication");
    expect(codeOf(() => R.decryptBlob(b, ctx, (a, i) => (i === 1 ? { ...a, index: 0n } : a)))).toBe("authentication");
  });
});

describe("node names", () => {
  it("shape, determinism, cross-vault difference, path bytes as given, canonical last character", () => {
    const n = R.nodeName(keys.vck, keys.vaultId, "Quarterly plan.md");
    expect(n).toMatch(/^[a-z2-7]{52}$/); expect(R.nodeName(keys.vck, keys.vaultId, "Quarterly plan.md")).toBe(n);
    expect(R.nodeName(other.vck, other.vaultId, "Quarterly plan.md")).not.toBe(n);
    expect(R.nodeName(keys.vck, keys.vaultId, "café")).not.toBe(R.nodeName(keys.vck, keys.vaultId, "café"));
    expect(codeOf(() => R.nodeName(keys.vck, keys.vaultId, "a\ud800"))).toBe("malformed");
    expect(R.b32Decode(n).length).toBe(32); expect(R.b32Encode(R.b32Decode(n))).toBe(n);
    const A = "abcdefghijklmnopqrstuvwxyz234567", tweaked = n.slice(0, 51) + A[A.indexOf(n[51]!) ^ 1];
    expect(codeOf(() => R.b32Decode(tweaked))).toBe("non-canonical");
  });
  it("RFC 4648 base32 vectors (lowercased, unpadded)", () => {
    const v: Array<[string, string]> = [["", ""], ["f", "my"], ["fo", "mzxq"], ["foo", "mzxw6"], ["foob", "mzxw6yq"], ["fooba", "mzxw6ytb"], ["foobar", "mzxw6ytboi"]];
    for (const [a, e] of v) expect(R.b32Encode(Buffer.from(a))).toBe(e);
  });
});

describe("manifest.enc", () => {
  const entries = () => { const pa = detRand("st/ma")(30), pb = detRand("st/mb")(70); return { "a.md": { plain: pa, blob: encryptBlob(pa, keys, nameOf(keys, "a.md"), detRand("st/ea")) }, "dir/b.md": { plain: pb, blob: encryptBlob(pb, keys, nameOf(keys, "dir/b.md"), detRand("st/eb")) } }; };
  const files = entries(), mObj = buildManifest(keys, { sequence: 3, rootCID: ROOT, files }), mText = serializeManifest(mObj);
  const env = encryptManifestText(mText, keys, detRand("st/env")).bytes;
  it("round-trips and parses without prototypes", () => {
    const m = R.decryptManifest(env, keys.vck, keys.vaultId);
    expect(m.sequence).toBe(3); expect(Object.keys(m.files).sort()).toEqual(["a.md", "dir/b.md"]); expect(Object.getPrototypeOf(m.files)).toBe(null);
  });
  it("every bit flip fails, other vault fails, header and AAD regions are authenticated", () => {
    for (let i = 0; i < env.length * 8; i++) { const x = Buffer.from(env); x[i >> 3]! ^= 1 << (i & 7); expect(codeOf(() => R.decryptManifest(x, keys.vck, keys.vaultId)), `bit ${i}`).not.toBe("NO-ERROR"); }
    expect(codeOf(() => R.decryptManifest(env, other.vck, other.vaultId))).toBe("authentication");
    for (const pos of [0, 20, 21, 30, 37, 40]) expect(codeOf(() => R.decryptManifestEnvelope(env, keys.vck, keys.vaultId, (a) => { const x = Buffer.from(a); x[pos]! ^= 1; return x; })), `aad ${pos}`).toBe("authentication");
    expect(codeOf(() => R.decryptManifestEnvelope(env, keys.vck, keys.vaultId, (a) => a.subarray(0, a.length - 1)))).toBe("authentication");
  });
  const seal = (text: string) => R.decryptManifest(encryptManifestText(text, keys, detRand("st/v")).bytes, keys.vck, keys.vaultId);
  const withObj = (f: (o: any) => void): string => { const o = JSON.parse(mText); f(o); return JSON.stringify(sortDeep(o)); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  it("validates fields, sequence range, name consistency and unknown fields", () => {
    expect(seal(JSON.stringify(JSON.parse(mText), null, 4)).sequence).toBe(3); // whitespace variant of an authenticated manifest is accepted
    expect(seal(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(mText)).reverse()))).sequence).toBe(3);
    for (const bad of ["0", "-1", "1.5", "9007199254740992", "\"3\""]) expect(codeOf(() => seal(mText.replace('"sequence":3', `"sequence":${bad}`))), bad).not.toBe("NO-ERROR");
    expect(seal(mText.replace('"sequence":3', '"sequence":9007199254740991')).sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(codeOf(() => seal(withObj((o) => { o.files["a.md"].blob = o.files["dir/b.md"].blob; })))).toBe("malformed");
    expect(codeOf(() => seal(withObj((o) => { o.extra = 1; })))).toBe("malformed");
    expect(codeOf(() => seal(withObj((o) => { o.files["a.md"].extra = 1; })))).toBe("malformed");
    expect(codeOf(() => seal(withObj((o) => { o.vaultId = "00".repeat(16); })))).toBe("vault-mismatch");
    expect(codeOf(() => seal(withObj((o) => { o.version = 1; })))).toBe("unsupported-format");
    expect(codeOf(() => seal(mText.replace('"device":"ref-device"', '"device":"a","device":"b"')))).toBe("malformed");
    for (const p of ["a\ud800b", "../x", "/abs", "a//b", "a\\b", "./a", "", "C:x", ".IPFS-Sync/x", "a\u0001b"]) expect(codeOf(() => seal(withObj((o) => { o.files[p] = o.files["a.md"]; }))), p).toBe("malformed");
  });
  it("device rejects lone surrogates and control characters, accepts U+0080, U+00A0 and astral characters", () => {
    for (const d of ["a\ud800b", "a\u0000b", "a\u001fb", "a\u007fb", "a\nb", ""]) expect(codeOf(() => seal(withObj((o) => { o.device = d; }))), JSON.stringify(d)).toBe("malformed");
    for (const d of ["ascii", "\u{1F600}", "a\u0080b", "a\u00a0b"]) expect(seal(withObj((o) => { o.device = d; })).device).toBe(d);
  });
  it("entry cid must be CIDv0 or CIDv1 base32", () => {
    for (const cid of ["cid-of-4-50e2a8ea", "", "bAAAAAAAAAAAAA", "b1234567890123", "Qm123"]) expect(codeOf(() => seal(withObj((o) => { o.files["a.md"].cid = cid; }))), cid).toBe("malformed");
    expect(seal(withObj((o) => { o.files["a.md"].cid = "Qm" + "1".repeat(44); })).files["a.md"]!.cid).toMatch(/^Qm/);
  });
  it("treats a __proto__ path as data", () => {
    const e = { plain: Buffer.from("x"), blob: encryptBlob(Buffer.from("x"), keys, nameOf(keys, "__proto__"), detRand("st/pp")) };
    const m = seal(serializeManifest(buildManifest(keys, { sequence: 1, rootCID: ROOT, files: { ["__proto__"]: e } })));
    expect(Object.keys(m.files)).toEqual(["__proto__"]); expect(({} as { size?: number }).size).toBeUndefined();
  });
  it("enforces caps: 100,001 entries, 8 MiB of path bytes, 64 MiB file", () => {
    const entry = { sha256: "00".repeat(32), size: 0, blob: "x", fileId: "00".repeat(16), cid: "c" };
    const many = JSON.parse(mText); many.files = Object.fromEntries(Array.from({ length: 100_001 }, (_, i) => [`f${i}`, entry]));
    expect(codeOf(() => seal(JSON.stringify(many)))).toBe("oversize");
    const wide = JSON.parse(mText); wide.files = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${i}`.repeat(1024 * 1024), entry]));
    expect(codeOf(() => seal(JSON.stringify(wide)))).toBe("oversize");
    expect(codeOf(() => R.decryptManifest(Buffer.alloc(64 * 1024 * 1024 + 1), keys.vck, keys.vaultId))).toBe("oversize");
  });
});

describe("reader requirements", () => {
  const mk = (path: string, text: string, k: Keys = keys) => { const pl = Buffer.from(text); return { pl, blob: encryptBlob(pl, k, nameOf(k, path), detRand(`st/rr/${path}/${text}`)) }; };
  const a = mk("a.md", "alpha"), b = mk("b.md", "bravo"), oldA = mk("a.md", "alpha-old");
  const man = R.parseManifest(Buffer.from(serializeManifest(buildManifest(keys, { sequence: 5, rootCID: ROOT, files: { "a.md": { plain: a.pl, blob: a.blob }, "b.md": { plain: b.pl, blob: b.blob } } }))), keys.vck, keys.vaultId);
  const nm = (p: string) => R.nodeName(keys.vck, keys.vaultId, p);
  it("accepts the right blob and rejects swapped, replayed and misnamed blobs", () => {
    expect(R.readVaultFile(man, "a.md", a.blob, nm("a.md"), keys).equals(a.pl)).toBe(true);
    expect(codeOf(() => R.readVaultFile(man, "a.md", b.blob, nm("a.md"), keys))).toBe("reader-requirement"); // fileId differs
    expect(codeOf(() => R.readVaultFile(man, "b.md", a.blob, nm("b.md"), keys))).toBe("reader-requirement");
    expect(codeOf(() => R.readVaultFile(man, "a.md", oldA.blob, nm("a.md"), keys))).toBe("reader-requirement"); // authentic but old
    expect(R.decryptBlob(oldA.blob, { ...keys, nodeName: nameOf(keys, "a.md") }).length).toBeGreaterThan(0); // the blob itself is authentic
    expect(codeOf(() => R.readVaultFile(man, "a.md", a.blob, nm("b.md"), keys))).toBe("reader-requirement"); // fetched under another name
    expect(codeOf(() => R.readVaultFile(man, "zzz.md", a.blob, nm("a.md"), keys))).toBe("reader-requirement");
  });
  it("rejects a size or hash mismatch even for an authentic blob", () => {
    const lying = { ...man, files: { ...man.files, "a.md": { ...man.files["a.md"]!, size: 999 } } };
    expect(codeOf(() => R.readVaultFile(lying, "a.md", a.blob, nm("a.md"), keys))).toBe("reader-requirement");
  });
  it("history file must be named after its inner rootCID", () => {
    const bytes = encryptManifestText(serializeManifest(buildManifest(keys, { sequence: 1, rootCID: ROOT, files: {} })), keys, detRand("st/h")).bytes;
    expect(R.readHistoryFile(`${ROOT}.enc`, bytes, keys).rootCID).toBe(ROOT);
    expect(codeOf(() => R.readHistoryFile(`${ROOT.slice(0, -2)}aa.enc`, bytes, keys))).toBe("reader-requirement");
  });
});

describe("vectors file", () => {
  const disk = JSON.parse(readFileSync(new URL("../support/reference-vectors.json", import.meta.url), "utf8")) as ReturnType<typeof buildVectors> & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  it("equals a fresh deterministic regeneration (never hand-edited)", () => {
    expect(disk).toEqual(JSON.parse(JSON.stringify(buildVectors(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))));
  });
  it("decrypts with the reference decryptor: slot (default cost), blobs, manifest, reader requirement", () => {
    const vck = Buffer.from(disk.inputs.vck, "hex"), vaultId = Buffer.from(disk.inputs.vaultId, "hex");
    expect(R.unlockKeyslots(Buffer.from(disk.slotDefaultParams.keyslotsJson), disk.inputs.passphrase).vck.equals(vck)).toBe(true);
    expect(R.unlockKeyslots(Buffer.from(disk.slotFloorParams.keyslotsJson), disk.inputs.passphrase.toLowerCase()).vck.equals(vck)).toBe(true);
    for (const b of disk.blobs) { const p = R.decryptBlob(Buffer.from(b.blobHex, "hex"), { vck, vaultId, nodeName: Buffer.from(b.nodeNameRaw, "hex") }); expect(R.sha256hex(p)).toBe(b.plaintextSha256); expect(b.nodeName).toBe(R.nodeName(vck, vaultId, b.path)); }
    const m = R.decryptManifest(Buffer.from(disk.manifest.manifestEncHex, "hex"), vck, vaultId);
    expect(R.readHistoryFile(disk.manifest.historyFileName, Buffer.from(disk.manifest.manifestEncHex, "hex"), { vck, vaultId }).sequence).toBe(2);
    expect(R.readVaultFile(m, "a.md", Buffer.from(disk.manifest.entryBlobHex, "hex"), R.nodeName(vck, vaultId, "a.md"), { vck, vaultId }).toString("hex")).toBe(disk.manifest.entryPlaintextHex);
    expect(codeOf(() => R.b32Decode(disk.nodeNames.nonCanonicalLastChar))).toBe("non-canonical");
    expect(blobFileId(Buffer.from(disk.blobs[0].blobHex, "hex"))).toBe(disk.blobs[0].fileId);
    for (const s of disk.passphraseCases.rejected) expect(codeOf(() => R.canonicalPassphrase(s)), s).toBe("passphrase-format");
  });
});
