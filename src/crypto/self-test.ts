import { AES_GCM_TAG_BYTES, aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from "./aes-gcm";
import { hmacSha256, importHmacKey } from "./hmac";
import { constantTimeEqual, type Bytes } from "./bytes";
import { fromHex } from "./codec";
import { CryptoError } from "./errors";
import { deriveAesGcmKey, deriveHmacKey, hkdfSha256, importHkdfKey } from "./hkdf";

/*
 * First-use known-answer check of the two platform primitives every derived key depends on. A platform that
 * returns a wrong HKDF output or a wrong AES-GCM result must stop the operation, not encrypt under it.
 * Sources: RFC 5869 Appendix A test case 1 (HKDF-SHA256); McGrew and Viega, "The Galois/Counter Mode of
 * Operation (GCM)", test case 16 (AES-256, 96-bit IV, 20-byte AAD); RFC 4231 test case 2 (HMAC-SHA256). The
 * `deriveKey` paths that produce every real key (AES-GCM and HMAC) are checked against the raw-import result of
 * the same RFC 5869 output. The full vector set lives in tests/vectors.
 */
const HMAC_KEY = "4a656665";
const HMAC_DATA = "7768617420646f2079612077616e7420666f72206e6f7468696e673f";
const HMAC_MAC = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

const HKDF_IKM = "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
const HKDF_SALT = "000102030405060708090a0b0c";
const HKDF_INFO = "f0f1f2f3f4f5f6f7f8f9";
const HKDF_OKM = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

const GCM_KEY = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";
const GCM_IV = "cafebabefacedbaddecaf888";
const GCM_AAD = "feedfacedeadbeeffeedfacedeadbeefabaddad2";
const GCM_PLAIN =
  "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39";
const GCM_SEALED =
  "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f66276fc6ece0f4e1768cddf8853bb2d551b";

/** The primitives under test; a test may pass a stub to prove the check fails closed. */
export interface SelfTestPrimitives {
  readonly hkdfSha256: typeof hkdfSha256;
  readonly importAesGcmKey: typeof importAesGcmKey;
  readonly aesGcmEncrypt: typeof aesGcmEncrypt;
  readonly aesGcmDecrypt: typeof aesGcmDecrypt;
  readonly importHkdfKey: typeof importHkdfKey;
  readonly deriveAesGcmKey: typeof deriveAesGcmKey;
  readonly deriveHmacKey: typeof deriveHmacKey;
  readonly importHmacKey: typeof importHmacKey;
  readonly hmacSha256: typeof hmacSha256;
}

export const PLATFORM_PRIMITIVES: SelfTestPrimitives = Object.freeze({
  hkdfSha256,
  importAesGcmKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
  importHkdfKey,
  deriveAesGcmKey,
  deriveHmacKey,
  importHmacKey,
  hmacSha256,
});

function failed(what: string): CryptoError {
  return new CryptoError("self-test-failed", `platform cryptography self-test failed (${what}); refusing to encrypt`);
}

async function checkHkdf(primitives: SelfTestPrimitives): Promise<void> {
  const okm = await primitives.hkdfSha256(fromHex(HKDF_IKM), fromHex(HKDF_SALT), fromHex(HKDF_INFO), 42);
  if (!constantTimeEqual(okm, fromHex(HKDF_OKM))) throw failed("HKDF-SHA256");
}

async function acceptsTampered(primitives: SelfTestPrimitives, key: CryptoKey, sealed: Bytes): Promise<boolean> {
  const tampered = new Uint8Array(sealed);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
  try {
    await primitives.aesGcmDecrypt(key, fromHex(GCM_IV), tampered, fromHex(GCM_AAD));
    return true;
  } catch {
    return false;
  }
}

async function checkAesGcm(primitives: SelfTestPrimitives): Promise<void> {
  const key = await primitives.importAesGcmKey(fromHex(GCM_KEY));
  const sealed = await primitives.aesGcmEncrypt(key, fromHex(GCM_IV), fromHex(GCM_PLAIN), fromHex(GCM_AAD));
  if (!constantTimeEqual(sealed, fromHex(GCM_SEALED)) || sealed.length !== GCM_PLAIN.length / 2 + AES_GCM_TAG_BYTES) {
    throw failed("AES-256-GCM encrypt");
  }
  const plain = await primitives.aesGcmDecrypt(key, fromHex(GCM_IV), sealed, fromHex(GCM_AAD));
  if (!constantTimeEqual(plain, fromHex(GCM_PLAIN))) throw failed("AES-256-GCM decrypt");
  if (await acceptsTampered(primitives, key, sealed)) throw failed("AES-256-GCM tag check");
}

async function checkHmac(primitives: SelfTestPrimitives): Promise<void> {
  const mac = await primitives.hmacSha256(await primitives.importHmacKey(fromHex(HMAC_KEY)), fromHex(HMAC_DATA));
  if (!constantTimeEqual(mac, fromHex(HMAC_MAC))) throw failed("HMAC-SHA256");
}

/** The keys used for real data come from `deriveKey`; it must agree with raw HKDF output imported directly. */
async function checkDerivedKeys(primitives: SelfTestPrimitives): Promise<void> {
  const ikm = fromHex(HKDF_IKM);
  const salt = fromHex(HKDF_SALT);
  const info = fromHex(HKDF_INFO);
  const base = await primitives.importHkdfKey(ikm);
  const rawKey = fromHex(HKDF_OKM).slice(0, 32);
  const nonce = new Uint8Array(12);
  const probe = fromHex(GCM_PLAIN);
  const viaRaw = await primitives.aesGcmEncrypt(await primitives.importAesGcmKey(rawKey), nonce, probe, new Uint8Array(0));
  const viaDerive = await primitives.aesGcmEncrypt(await primitives.deriveAesGcmKey(base, salt, info), nonce, probe, new Uint8Array(0));
  if (!constantTimeEqual(viaRaw, viaDerive)) throw failed("HKDF deriveKey (AES-GCM)");
  const macRaw = await primitives.hmacSha256(await primitives.importHmacKey(rawKey), probe);
  const macDerive = await primitives.hmacSha256(await primitives.deriveHmacKey(base, salt, info), probe);
  if (!constantTimeEqual(macRaw, macDerive)) throw failed("HKDF deriveKey (HMAC)");
}

export interface SelfTestRunner {
  /** Resolves once the known-answer check has passed; rejects with `self-test-failed` (never cached) otherwise. */
  readonly ensure: () => Promise<void>;
}

/**
 * A runner that performs the check the first time `ensure` is called and remembers only success, so a failing
 * platform fails closed on every call. `crypto-unavailable` from a missing WebCrypto propagates unchanged.
 */
export function createSelfTestRunner(primitives: SelfTestPrimitives = PLATFORM_PRIMITIVES): SelfTestRunner {
  let passed = false;
  let inFlight: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    try {
      await checkHkdf(primitives);
      await checkAesGcm(primitives);
      await checkHmac(primitives);
      await checkDerivedKeys(primitives);
      passed = true;
    } catch (error) {
      if (error instanceof CryptoError) throw error;
      throw failed("primitive raised an error");
    } finally {
      inFlight = undefined;
    }
  };
  return {
    ensure: async () => {
      if (passed) return;
      inFlight ??= run();
      await inFlight;
    },
  };
}

/** The per-process runner used by unlock: the check runs once per host process. */
export const ensureSelfTest: () => Promise<void> = createSelfTestRunner().ensure;
