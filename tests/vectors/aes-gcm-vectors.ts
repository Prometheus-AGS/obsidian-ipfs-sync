import { expectLength, hex, repeat } from "./bytes";

/**
 * AES-256-GCM known answers, all with a 96-bit IV and a 128-bit tag.
 *
 * McGrew and Viega, "The Galois/Counter Mode of Operation (GCM)", NIST submission, 2004, appendix B, test cases
 * 13 to 16 (the 256-bit-key cases with 96-bit IVs; cases 17 and 18 use other IV lengths and are excluded).
 *
 * NIST CAVP `gcmEncryptExtIV256.rsp` (Keylen 256, IVlen 96, Taglen 128): two vectors, recalled as Count 0 of the
 * PTlen 0 / AADlen 0 group and as a PTlen 128 vector. The values are exact; the "Count" labels are from memory and
 * were not checked against the NIST file (no network access in this task).
 *
 * Every vector was confirmed at authoring time against Node's `crypto.createCipheriv("aes-256-gcm", ...)`.
 * Recalled candidates that disagreed with Node were DROPPED, not corrected: a Key 78dc4e0a... / IV d79cf22d...
 * vector with 16-byte AAD (the recalled tag ended 06e0e; Node computes ...06e76) is therefore absent.
 * Lengths are asserted when the module loads.
 */
export interface GcmVector {
  readonly name: string;
  readonly source: string;
  readonly key: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly aad: Uint8Array<ArrayBuffer>;
  readonly plaintext: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly tag: Uint8Array<ArrayBuffer>;
}

const TC15_KEY = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";
const TC15_IV = "cafebabefacedbaddecaf888";
const TC15_PLAIN =
  "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72" +
  "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255";
const TC15_CIPHER =
  "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa" +
  "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad";

export const GCM_VECTORS: readonly GcmVector[] = [
  {
    name: "McGrew-Viega test case 13",
    source: "GCM spec (McGrew, Viega) appendix B, test case 13",
    key: expectLength("tc13 key", repeat(0, 32), 32),
    iv: expectLength("tc13 iv", repeat(0, 12), 12),
    aad: new Uint8Array(0),
    plaintext: new Uint8Array(0),
    ciphertext: new Uint8Array(0),
    tag: expectLength("tc13 tag", hex("530f8afbc74536b9a963b4f1c4cb738b"), 16),
  },
  {
    name: "McGrew-Viega test case 14",
    source: "GCM spec (McGrew, Viega) appendix B, test case 14",
    key: expectLength("tc14 key", repeat(0, 32), 32),
    iv: expectLength("tc14 iv", repeat(0, 12), 12),
    aad: new Uint8Array(0),
    plaintext: expectLength("tc14 plaintext", repeat(0, 16), 16),
    ciphertext: expectLength("tc14 ciphertext", hex("cea7403d4d606b6e074ec5d3baf39d18"), 16),
    tag: expectLength("tc14 tag", hex("d0d1c8a799996bf0265b98b5d48ab919"), 16),
  },
  {
    name: "McGrew-Viega test case 15",
    source: "GCM spec (McGrew, Viega) appendix B, test case 15",
    key: expectLength("tc15 key", hex(TC15_KEY), 32),
    iv: expectLength("tc15 iv", hex(TC15_IV), 12),
    aad: new Uint8Array(0),
    plaintext: expectLength("tc15 plaintext", hex(TC15_PLAIN), 64),
    ciphertext: expectLength("tc15 ciphertext", hex(TC15_CIPHER), 64),
    tag: expectLength("tc15 tag", hex("b094dac5d93471bdec1a502270e3cc6c"), 16),
  },
  {
    name: "McGrew-Viega test case 16",
    source: "GCM spec (McGrew, Viega) appendix B, test case 16",
    key: expectLength("tc16 key", hex(TC15_KEY), 32),
    iv: expectLength("tc16 iv", hex(TC15_IV), 12),
    aad: expectLength("tc16 aad", hex("feedfacedeadbeeffeedfacedeadbeefabaddad2"), 20),
    plaintext: expectLength("tc16 plaintext", hex(TC15_PLAIN.slice(0, 120)), 60),
    ciphertext: expectLength("tc16 ciphertext", hex(TC15_CIPHER.slice(0, 120)), 60),
    tag: expectLength("tc16 tag", hex("76fc6ece0f4e1768cddf8853bb2d551b"), 16),
  },
  {
    name: "NIST gcmEncryptExtIV256, PTlen 0 / AADlen 0 group",
    source: "NIST CAVP gcmEncryptExtIV256.rsp (Keylen 256, IVlen 96, PTlen 0, AADlen 0, Taglen 128), first vector (label unverified)",
    key: expectLength("nist0 key", hex("b52c505a37d78eda5dd34f20c22540ea1b58963cf8e5bf8ffa85f9f2492505b4"), 32),
    iv: expectLength("nist0 iv", hex("516c33929df5a3284ff463d7"), 12),
    aad: new Uint8Array(0),
    plaintext: new Uint8Array(0),
    ciphertext: new Uint8Array(0),
    tag: expectLength("nist0 tag", hex("bdc1ac884d332457a1d2664f168c76f0"), 16),
  },
  {
    name: "NIST gcmEncryptExtIV256, PTlen 128 / AADlen 0 group",
    source: "NIST CAVP gcmEncryptExtIV256.rsp (Keylen 256, IVlen 96, PTlen 128, AADlen 0, Taglen 128) (label unverified)",
    key: expectLength("nist128 key", hex("31bdadd96698c204aa9ce1448ea94ae1fb4a9a0b3c9d773b51bb1822666b8f22"), 32),
    iv: expectLength("nist128 iv", hex("0d18e06c7c725ac9e362e1ce"), 12),
    aad: new Uint8Array(0),
    plaintext: expectLength("nist128 plaintext", hex("2db5168e932556f8089a0622981d017d"), 16),
    ciphertext: expectLength("nist128 ciphertext", hex("fa4362189661d163fcd6a56d8bf0405a"), 16),
    tag: expectLength("nist128 tag", hex("d636ac1bbedd5cc3ee727dc2ab4a9489"), 16),
  },
];

/**
 * Tag-failure vector. NOT a NIST FAIL vector (the `gcmDecrypt256.rsp` FAIL cases were not transcribed, because
 * they could not be recalled with certainty): it is McGrew-Viega case 16 with the last tag byte changed, which
 * any correct GCM implementation must reject. Labelled as derived.
 */
export const GCM_TAG_FAILURE = {
  name: "derived tag-failure vector (McGrew-Viega case 16, last tag byte 1b -> 1a)",
  source: "derived from McGrew-Viega test case 16; not a NIST FAIL vector",
  base: "McGrew-Viega test case 16",
  badTag: expectLength("tag failure tag", hex("76fc6ece0f4e1768cddf8853bb2d551a"), 16),
} as const;
