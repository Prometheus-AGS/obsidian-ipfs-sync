import { expectLength, hex, repeat } from "./bytes";

/**
 * RFC 9106, section 5.3 "Argon2id Test Vectors" (version 0x13, memory 32 KiB, 3 passes, 4 lanes, tag length 32,
 * password 32 x 0x01, salt 16 x 0x02, secret 8 x 0x03, associated data 12 x 0x04).
 * Source: https://www.rfc-editor.org/rfc/rfc9106#section-5.3 (IETF, September 2021).
 * The tag was transcribed from memory of the RFC text (no network access in this task) and confirmed at authoring
 * time against Node 24's `crypto.argon2Sync("argon2id", ...)`, an independent implementation (OpenSSL).
 * These parameters are below the floors of the public wrapper, so the vector is reachable only through the
 * test-only `argon2idRaw` entry.
 */
export const RFC9106_ARGON2ID = {
  source: "RFC 9106 section 5.3 (Argon2id)",
  password: expectLength("rfc9106 password", repeat(0x01, 32), 32),
  salt: expectLength("rfc9106 salt", repeat(0x02, 16), 16),
  secret: expectLength("rfc9106 secret", repeat(0x03, 8), 8),
  associatedData: expectLength("rfc9106 associated data", repeat(0x04, 12), 12),
  m: 32,
  t: 3,
  p: 4,
  dkLen: 32,
  tag: expectLength("rfc9106 tag", hex("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"), 32),
} as const;
