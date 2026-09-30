// Independent reference decryptor for the mvp-06 wire formats.
// Written ONLY from openspec/changes/mvp-06-encrypted-vault-publish (specs, design, review-0.1/0.2 fixes).
// It imports nothing from the production crypto module and shares no code with it. Where the spec text is ambiguous the
// chosen reading is marked "READING:" and listed in the task report, never silently decided.
import * as nodeCrypto from "node:crypto";

export type RefCode =
  | "crypto-unavailable" | "wrong-passphrase-or-damaged-slot" | "kdf-params" | "unsupported-format"
  | "authentication" | "malformed" | "oversize" | "vault-mismatch" | "non-canonical"
  | "passphrase-format" | "no-usable-slot" | "reader-requirement";
export class RefError extends Error {
  readonly code: RefCode;
  constructor(code: RefCode, detail: string) { super(`${code}: ${detail}`); this.code = code; }
}
const bad = (code: RefCode, detail: string): never => { throw new RefError(code, detail); };

// ---- constants (spec + design section 2) ----
export const LABEL = {
  slot: "ipfs-sync/slot/v1", wrap: "ipfs-sync/slot/wrap/v1", commit: "ipfs-sync/slot/commit/v1",
  name: "ipfs-sync/name/v1", manifest: "ipfs-sync/manifest/v1", file: "ipfs-sync/file/v1", blob: "ipfs-sync/blob/v1",
} as const;
export const LIMITS = {
  keyslotsBytes: 16 * 1024, slots: 8, slotsTried: 2, manifestBytes: 64 * 1024 * 1024, entries: 100_000,
  pathBytes: 8 * 1024 * 1024, mFloor: 19_456, mCeil: 131_072, tFloor: 2, tCeil: 4, expMin: 16, expMax: 24,
} as const;
const BLOB_MAGIC = "ISBL", MANIFEST_MAGIC = "ISMF", B32 = "abcdefghijklmnopqrstuvwxyz234567";

// ---- primitives ----
const u8 = (s: string): Buffer => Buffer.from(s, "utf8");
const cat = (...p: Uint8Array[]): Buffer => Buffer.concat(p);
export const u32 = (n: number | bigint): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(Number(n)); return b; };
export const u64 = (n: number | bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
export const sha256hex = (d: Uint8Array): string => nodeCrypto.createHash("sha256").update(d).digest("hex");
export const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array | string, len = 32): Buffer =>
  Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, info, len));
function gcmOpen(key: Uint8Array, nonce: Uint8Array, ctTag: Uint8Array, aad: Uint8Array): Buffer {
  if (nonce.length !== 12 || ctTag.length < 16) bad("malformed", "gcm nonce/tag size");
  const d = nodeCrypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(ctTag.subarray(ctTag.length - 16));
  try { return cat(d.update(ctTag.subarray(0, ctTag.length - 16)), d.final()); }
  catch { return bad("authentication", "aead tag mismatch"); }
}

// ---- codecs ----
export function b32Encode(b: Uint8Array): string {
  let bits = 0, acc = 0, out = "";
  for (const x of b) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; } acc &= (1 << bits) - 1; }
  return bits ? out + B32[(acc << (5 - bits)) & 31] : out;
}
export function b32Decode(s: string, bytes = 32): Buffer {
  if (s.length !== Math.ceil((bytes * 8) / 5) || !/^[a-z2-7]+$/.test(s)) bad("non-canonical", "base32 shape");
  let bits = 0, acc = 0; const out: number[] = [];
  for (const ch of s) { acc = (acc << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; } acc &= (1 << bits) - 1; }
  if (acc !== 0) bad("non-canonical", "base32 unused bits not zero");
  return Buffer.from(out);
}
const hexN = (s: unknown, n: number, what: string): Buffer => {
  if (typeof s !== "string" || s.length !== n * 2 || !/^[0-9a-f]+$/.test(s)) return bad("malformed", `${what} must be ${n * 2} lowercase hex`);
  return Buffer.from(s, "hex");
};
const b64N = (s: unknown, n: number, what: string): Buffer => {
  if (typeof s !== "string") return bad("malformed", `${what} not a string`);
  const b = Buffer.from(s, "base64");
  if (b.toString("base64") !== s) bad("non-canonical", `${what} base64 not canonical`);
  if (b.length !== n) bad("malformed", `${what} must be ${n} bytes`);
  return b;
};

// ---- canonical passphrase (key-slots spec) ----
const SYMS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Two check symbols: first 10 bits of SHA-256(UTF-8(label) || ASCII(23 symbols)), 5 bits each, big-endian, alphabet A-Z2-7. */
export function passphraseCheck(body23: string): string {
  const h = nodeCrypto.createHash("sha256").update(u8("ipfs-sync/passphrase/check/v1")).update(Buffer.from(body23, "ascii")).digest();
  return SYMS[h[0]! >> 3]! + SYMS[((h[0]! & 7) << 2) | (h[1]! >> 6)]!;
}
export function canonicalPassphrase(input: string): string {
  // ASCII-only fold by code-unit arithmetic: toUpperCase() would map U+017F to S and U+0131 to I.
  const t = Array.from(input.replaceAll("-", "").replaceAll(" ", ""), (c) => (c >= "a" && c <= "z" ? String.fromCharCode(c.charCodeAt(0) - 32) : c)).join("");
  if (!/^[A-Z2-7]{25}$/.test(t)) bad("passphrase-format", "need exactly 25 symbols of A-Z 2-7");
  if (passphraseCheck(t.slice(0, 23)) !== t.slice(23)) bad("passphrase-format", "check symbols do not match");
  return t;
}
export const displayPassphrase = (canon: string): string => canon.match(/.{5}/g)!.join("-");
export function generatePassphrase(rand: (n: number) => Uint8Array): string {
  const body = Array.from(rand(23), (b) => SYMS[b & 31]!).join("");
  return displayPassphrase(body + passphraseCheck(body));
}

// ---- strict JSON: duplicate keys rejected, null-prototype objects, integers as bigint ----
export type Json = null | boolean | string | bigint | number | Json[] | { [k: string]: Json };
export function parseStrictJson(text: string, maxDepth = 32): Json {
  let i = 0;
  const fail = (m: string): never => bad("malformed", `json ${m} at ${i}`);
  const ws = (): void => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const str = (): string => {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) fail("unterminated string");
    const lit = text.slice(i, j + 1); i = j + 1;
    try { return JSON.parse(lit) as string; } catch { return fail("bad string"); }
  };
  const value = (d: number): Json => {
    ws(); const c = text[i];
    if ((c === "{" || c === "[") && d + 1 > maxDepth) fail("nesting deeper than 32");
    if (c === "{") {
      i++; const o = Object.create(null) as { [k: string]: Json }; ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("key expected");
        const k = str(); ws(); if (text[i] !== ":") fail(": expected"); i++;
        if (Object.hasOwn(o, k)) fail(`duplicate key ${k}`);
        o[k] = value(d + 1); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return o; }
        fail("object");
      }
    }
    if (c === "[") {
      i++; const a: Json[] = []; ws();
      if (text[i] === "]") { i++; return a; }
      for (;;) { a.push(value(d + 1)); ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "]") { i++; return a; } fail("array"); }
    }
    if (c === '"') return str();
    for (const [lit, v] of [["true", true], ["false", false], ["null", null]] as const) if (text.startsWith(lit, i)) { i += lit.length; return v; }
    const m = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y; m.lastIndex = i;
    const r = m.exec(text); if (!r) return fail("value");
    if (r[0] === "-0") fail("negative zero");
    i = m.lastIndex; return r[1] || r[2] ? Number(r[0]) : BigInt(r[0]); // floats/exponents stay numbers; every schema check demands bigint
  };
  const v = value(0); ws(); if (i !== text.length) fail("trailing data");
  return v;
}
const asObj = (v: Json, what: string): { [k: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : bad("malformed", `${what} must be an object`);
const exactKeys = (o: object, keys: string[], what: string): void => {
  const k = Object.keys(o).sort().join(","); if (k !== [...keys].sort().join(",")) bad("malformed", `${what} fields must be exactly ${keys.join(",")}`);
};
// READING: "sorted keys" = UTF-16 code-unit order; indentation and layout = JSON.stringify(v, null, 2).
export function canonJson(v: Json, ind = ""): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return bad("non-canonical", "non-integer number in keyslots");
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const inner = ind + "  ";
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + canonJson(x, inner)).join(",\n")}\n${ind}]` : "[]";
  const ks = Object.keys(v).sort();
  return ks.length ? `{\n${ks.map((k) => `${inner}${JSON.stringify(k)}: ${canonJson(v[k]!, inner)}`).join(",\n")}\n${ind}}` : "{}";
}

// ---- keyslots.json ----
export interface PassphraseSlot { type: "passphrase"; id: Buffer; m: number; t: number; p: number; salt: Buffer; nonce: Buffer; ct: Buffer; commit: Buffer }
export interface KeySlots { vaultId: Buffer; slots: Array<PassphraseSlot | { type: "unknown" }> }
const intIn = (v: Json | undefined, what: string): bigint => typeof v === "bigint" ? v : bad("malformed", `${what} must be an integer`);

export function parseKeyslots(bytes: Uint8Array): KeySlots {
  if (bytes.length > LIMITS.keyslotsBytes) bad("oversize", "keyslots.json above 16 KiB");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return bad("malformed", "keyslots.json not utf-8"); }
  const doc = asObj(parseStrictJson(text), "keyslots");
  if (doc.version !== undefined && doc.version !== 1n) bad("unsupported-format", "keyslots version");
  if (text !== canonJson(doc) + "\n") bad("non-canonical", "keyslots.json is not in the canonical serialisation");
  exactKeys(doc, ["version", "vaultId", "slots"], "keyslots");
  if (doc.version !== 1n) bad("unsupported-format", "keyslots version");
  const vaultId = hexN(doc.vaultId, 16, "vaultId");
  if (!Array.isArray(doc.slots)) bad("malformed", "slots must be an array");
  const list = doc.slots as Json[];
  if (list.length > LIMITS.slots) bad("oversize", "more than 8 slots");
  const slots = list.map((sv, n): PassphraseSlot | { type: "unknown" } => {
    const s = asObj(sv, `slot ${n}`);
    if (typeof s.type !== "string") return bad("malformed", "slot type");
    if (s.type !== "passphrase") return { type: "unknown" }; // READING: unknown types are skipped, see report (key-slots spec contradiction)
    exactKeys(s, ["id", "type", "kdf", "wrap", "commit"], "passphrase slot");
    const kdf = asObj(s.kdf!, "kdf"), wrap = asObj(s.wrap!, "wrap");
    exactKeys(kdf, ["alg", "v", "m", "t", "p", "dkLen", "salt"], "kdf"); exactKeys(wrap, ["alg", "nonce", "ct"], "wrap");
    if (kdf.alg !== "argon2id" || intIn(kdf.v, "v") !== 19n || intIn(kdf.dkLen, "dkLen") !== 32n || wrap.alg !== "aes-256-gcm")
      bad("unsupported-format", "fixed kdf/wrap fields (alg, v=19, dkLen=32)");
    const m = intIn(kdf.m, "m"), t = intIn(kdf.t, "t"), p = intIn(kdf.p, "p");
    if (m < BigInt(LIMITS.mFloor)) bad("kdf-params", `memory ${m} below floor ${LIMITS.mFloor}`);
    if (m > BigInt(LIMITS.mCeil)) bad("kdf-params", `memory ${m} above ceiling ${LIMITS.mCeil}`);
    if (t < BigInt(LIMITS.tFloor)) bad("kdf-params", `iterations ${t} below floor ${LIMITS.tFloor}`);
    if (t > BigInt(LIMITS.tCeil)) bad("kdf-params", `iterations ${t} above ceiling ${LIMITS.tCeil}`);
    if (p !== 1n) bad("kdf-params", `parallelism ${p} must be 1`);
    let salt: Buffer;
    try { salt = b64N(kdf.salt, 16, "salt"); } catch (e) { return bad("kdf-params", `salt: ${(e as Error).message}`); }
    return { type: "passphrase", id: hexN(s.id, 16, "slot id"), m: Number(m), t: Number(t), p: 1, salt,
      nonce: b64N(wrap.nonce, 12, "wrap nonce"), ct: b64N(wrap.ct, 48, "wrapped VCK"), commit: b64N(s.commit, 32, "commit") };
  });
  return { vaultId, slots };
}
export const commitInfo = (s: PassphraseSlot): Buffer => cat(u8(LABEL.commit), s.id, u32(19), u32(s.m), u32(s.t), u32(s.p), u32(32), s.salt);
export const slotAad = (vaultId: Uint8Array, s: PassphraseSlot): Buffer =>
  cat(u8(LABEL.slot), vaultId, s.id, u32(19), u32(s.m), u32(s.t), u32(s.p), u32(32), s.salt, u8("argon2id"), Buffer.from([0]), u8("aes-256-gcm"));

export type KekFn = (pass: Buffer, salt: Buffer, m: number, t: number, p: number, dkLen: number) => Uint8Array;
export const nodeKek: KekFn = (pass, salt, m, t, p, dkLen) => {
  if (typeof nodeCrypto.argon2Sync !== "function") return bad("crypto-unavailable", "no crypto.argon2Sync; inject a KEK callback");
  return nodeCrypto.argon2Sync("argon2id", { message: pass, nonce: salt, parallelism: p, tagLength: dkLen, memory: m, passes: t });
};
export interface Unlocked { vck: Buffer; vaultId: Buffer; slotId: Buffer }
/** Order per slot: fixed fields/bounds (all tried slots, before any derivation) -> Argon2id -> commitment -> constant-time compare -> wrap key -> AES-GCM. */
export function unlockKeyslots(bytes: Uint8Array, passphrase: string, kek: KekFn = nodeKek): Unlocked {
  const pass = u8(canonicalPassphrase(passphrase));
  const doc = parseKeyslots(bytes);
  const tried = doc.slots.filter((s): s is PassphraseSlot => s.type === "passphrase").slice(0, LIMITS.slotsTried);
  if (!tried.length) bad("no-usable-slot", "no passphrase slot");
  for (const s of tried) {
    const k = Buffer.from(kek(pass, s.salt, s.m, s.t, s.p, 32));
    const commit = hkdf(k, doc.vaultId, commitInfo(s), 32);
    if (!nodeCrypto.timingSafeEqual(commit, s.commit)) continue;
    const wrapKey = hkdf(k, doc.vaultId, LABEL.wrap, 32);
    try { return { vck: gcmOpen(wrapKey, s.nonce, s.ct, slotAad(doc.vaultId, s)), vaultId: doc.vaultId, slotId: s.id }; } catch { continue; }
  }
  return bad("wrong-passphrase-or-damaged-slot", "commitment or wrap authentication failed");
}

// ---- key derivations and node names ----
export const nameKey = (vck: Uint8Array, vaultId: Uint8Array): Buffer => hkdf(vck, vaultId, LABEL.name);
export const manifestKey = (vck: Uint8Array, vaultId: Uint8Array): Buffer => hkdf(vck, vaultId, LABEL.manifest);
export const fileKey = (vck: Uint8Array, fileId: Uint8Array): Buffer => hkdf(vck, fileId, LABEL.file);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const nodeNameRaw = (vck: Uint8Array, vaultId: Uint8Array, path: string): Buffer => {
  if (path === "" || LONE_SURROGATE.test(path)) bad("malformed", "path is empty or has a lone surrogate (UTF-8 would map distinct paths to one HMAC input)");
  return nodeCrypto.createHmac("sha256", nameKey(vck, vaultId)).update(u8(path)).digest();
}; // READING: HMAC over UTF-8 bytes as given, no normalisation
export const nodeName = (vck: Uint8Array, vaultId: Uint8Array, path: string): string => b32Encode(nodeNameRaw(vck, vaultId, path));

// ---- blobs ----
export interface BlobAadParts { label: string | Uint8Array; vaultId: Uint8Array; header: Uint8Array; nodeName: Uint8Array; index: bigint; final: number }
export const blobAad = (a: BlobAadParts): Buffer =>
  cat(typeof a.label === "string" ? u8(a.label) : a.label, a.vaultId, a.header, a.nodeName, u64(a.index), Buffer.from([a.final]));
export interface BlobCtx { vck: Uint8Array; vaultId: Uint8Array; nodeName: Uint8Array }
export function blobHeader(blob: Uint8Array): { exp: number; fileId: Buffer; header: Buffer } {
  if (blob.length < 22) bad("malformed", "blob shorter than its header");
  const h = Buffer.from(blob.subarray(0, 22));
  if (h.toString("latin1", 0, 4) !== BLOB_MAGIC) bad("malformed", "blob magic");
  if (h[4] !== 1) bad("unsupported-format", "blob version");
  if (h[5]! < LIMITS.expMin || h[5]! > LIMITS.expMax) bad("unsupported-format", "blob segment exponent");
  return { exp: h[5]!, fileId: h.subarray(6, 22), header: h };
}
/** Whole-blob decrypt. Never returns plaintext unless every segment authenticated (final flag derived from blob length). */
export function decryptBlob(blob: Uint8Array, ctx: BlobCtx, mutate?: (a: BlobAadParts, i: number) => BlobAadParts): Buffer {
  const { exp, fileId, header } = blobHeader(blob);
  if (ctx.nodeName.length !== 32 || ctx.vaultId.length !== 16) bad("malformed", "context sizes");
  if (blob.length < 22 + 28) bad("malformed", "blob shorter than 22 + 28");
  const stride = 2 ** exp + 28, body = blob.length - 22, n = Math.ceil(body / stride), last = body - (n - 1) * stride;
  if (last < 28) bad("malformed", "final segment shorter than 28 bytes");
  if (n > 1 && last === 28) bad("malformed", "empty final segment after other segments (final holds 1..2^exp bytes)");
  const key = fileKey(ctx.vck, fileId), out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const seg = blob.subarray(22 + i * stride, 22 + Math.min((i + 1) * stride, body));
    const base: BlobAadParts = { label: LABEL.blob, vaultId: ctx.vaultId, header, nodeName: ctx.nodeName, index: BigInt(i), final: i === n - 1 ? 1 : 0 };
    out.push(gcmOpen(key, seg.subarray(0, 12), seg.subarray(12), blobAad(mutate ? mutate(base, i) : base)));
  }
  return cat(...out);
}

// ---- manifest.enc and manifest v2 ----
export interface ManifestEntry { sha256: string; size: number; blob: string; fileId: string; cid: string }
export interface Manifest { version: 2; vaultId: string; sequence: number; rootCID: string; publishedAt: string; device: string; excludesHash: string; files: { [path: string]: ManifestEntry } }
export const manifestAad = (vaultId: Uint8Array, header: Uint8Array, label: string = LABEL.manifest): Buffer => cat(u8(label), vaultId, header);
export function decryptManifestEnvelope(bytes: Uint8Array, vck: Uint8Array, vaultId: Uint8Array, mutateAad?: (a: Buffer) => Buffer): Buffer {
  if (bytes.length > LIMITS.manifestBytes) bad("oversize", "manifest.enc above 64 MiB");
  if (bytes.length < 17 + 16) bad("malformed", "manifest.enc too short");
  const h = Buffer.from(bytes.subarray(0, 17));
  if (h.toString("latin1", 0, 4) !== MANIFEST_MAGIC) bad("malformed", "manifest magic");
  if (h[4] !== 2) bad("unsupported-format", "manifest version");
  const aad = manifestAad(vaultId, h);
  return gcmOpen(manifestKey(vck, vaultId), h.subarray(5, 17), bytes.subarray(17), mutateAad ? mutateAad(aad) : aad);
}
// Written from the manifest-v2 spec requirement "every path ... SHALL be refused if": empty; leading '/' or drive letter + colon;
// a backslash; any of U+0000..U+001F or U+007F; an empty, '.' or '..' segment; first segment equal to '.ipfs-sync' compared
// case-insensitively (ASCII); a lone surrogate. Pull-only exclusions are out of scope here.
export function checkPath(p: string): void {
  const asciiLower = (x: string): string => x.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  const reasons: boolean[] = [
    p.length === 0, p[0] === "/", /^[A-Za-z]:/.test(p), p.includes("\\"), Array.from(p).some((c) => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f),
    p.split("/").some((seg) => seg === "" || seg === "." || seg === ".."), asciiLower(p.split("/")[0]!) === ".ipfs-sync", LONE_SURROGATE.test(p),
  ];
  if (reasons.some(Boolean)) bad("malformed", "unsafe manifest path");
}
function checkTimestamp(t: string): void {
  const r = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/.exec(t);
  if (!r) return bad("malformed", "publishedAt must be YYYY-MM-DDTHH:MM:SS[.fff]Z");
  const [y, mo, da, h, mi, se] = [1, 2, 3, 4, 5, 6].map((k) => Number(r[k]));
  const leap = (y! % 4 === 0 && y! % 100 !== 0) || y! % 400 === 0, days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo! < 1 || mo! > 12 || da! < 1 || da! > days[mo! - 1]! || h! > 23 || mi! > 59 || se! > 59) bad("malformed", "publishedAt out of range");
}
export function parseManifest(plain: Uint8Array, vck: Uint8Array, vaultId: Uint8Array): Manifest {
  const m = asObj(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(plain)), "manifest");
  exactKeys(m, ["version", "vaultId", "sequence", "rootCID", "publishedAt", "device", "excludesHash", "files"], "manifest");
  if (m.version !== 2n) bad("unsupported-format", "manifest version");
  if (m.vaultId !== Buffer.from(vaultId).toString("hex")) bad("vault-mismatch", "manifest vaultId");
  const seq = intIn(m.sequence, "sequence");
  if (seq < 1n || seq > BigInt(Number.MAX_SAFE_INTEGER)) bad("malformed", "sequence out of 1..2^53-1");
  const str = (k: string): string => (typeof m[k] === "string" ? (m[k] as string) : bad("malformed", `${k} must be a string`));
  if (str("rootCID").length > 128 || !/^b[a-z2-7]{10,}$/.test(str("rootCID"))) bad("malformed", "rootCID must be a CIDv1 base32 string of at most 128 characters");
  checkTimestamp(str("publishedAt"));
  const devLen = Array.from(str("device")).length;
  if (devLen < 1 || devLen > 64) bad("malformed", "device must be 1..64 code points");
  if (LONE_SURROGATE.test(str("device")) || /[\u0000-\u001f\u007f]/.test(str("device"))) bad("malformed", "device has a lone surrogate or control character");
  hexN(str("excludesHash"), 32, "excludesHash");
  const files = asObj(m.files!, "files"), paths = Object.keys(files);
  if (paths.length > LIMITS.entries) bad("oversize", "more than 100,000 entries");
  if (paths.reduce((n, p) => n + Buffer.byteLength(p, "utf8"), 0) > LIMITS.pathBytes) bad("oversize", "path bytes above 8 MiB");
  const out: { [p: string]: ManifestEntry } = Object.create(null);
  for (const p of paths) {
    checkPath(p);
    const e = asObj(files[p]!, "entry"); exactKeys(e, ["sha256", "size", "blob", "fileId", "cid"], "entry");
    const size = intIn(e.size, "size");
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) bad("malformed", "size range");
    hexN(e.sha256, 32, "sha256"); hexN(e.fileId, 16, "fileId");
    if (typeof e.cid !== "string" || e.cid.length > 128 || !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{10,})$/.test(e.cid)) bad("malformed", "entry cid must be CIDv0 or CIDv1 base32");
    if (e.blob !== nodeName(vck, vaultId, p)) bad("malformed", "entry blob differs from the name computed from its path");
    out[p] = { sha256: e.sha256 as string, size: Number(size), blob: e.blob as string, fileId: e.fileId as string, cid: e.cid as string };
  }
  return { version: 2, vaultId: m.vaultId as string, sequence: Number(seq), rootCID: m.rootCID as string, publishedAt: m.publishedAt as string,
    device: m.device as string, excludesHash: m.excludesHash as string, files: out };
}
export const decryptManifest = (bytes: Uint8Array, vck: Uint8Array, vaultId: Uint8Array): Manifest =>
  parseManifest(decryptManifestEnvelope(bytes, vck, vaultId), vck, vaultId);

// ---- reader requirements (encrypted-blobs spec) ----
export function readVaultFile(m: Manifest, path: string, blob: Uint8Array, fetchedAs: string, keys: { vck: Uint8Array; vaultId: Uint8Array }): Buffer {
  const e = m.files[path];
  if (!e) bad("reader-requirement", "path not in the authenticated manifest");
  const name = nodeName(keys.vck, keys.vaultId, path);
  if (e!.blob !== name || fetchedAs !== name) bad("reader-requirement", "blob name differs from the name recomputed from the path");
  if (blobHeader(blob).fileId.toString("hex") !== e!.fileId) bad("reader-requirement", "blob file identifier differs from the manifest entry");
  const plain = decryptBlob(blob, { ...keys, nodeName: b32Decode(name) });
  if (plain.length !== e!.size || sha256hex(plain) !== e!.sha256) bad("reader-requirement", "decrypted size or sha256 differs from the manifest entry");
  return plain;
}
export function readHistoryFile(fileName: string, bytes: Uint8Array, keys: { vck: Uint8Array; vaultId: Uint8Array }): Manifest {
  const m = decryptManifest(bytes, keys.vck, keys.vaultId);
  if (fileName !== `${m.rootCID}.enc`) bad("reader-requirement", "history file name differs from its inner rootCID");
  return m;
}
