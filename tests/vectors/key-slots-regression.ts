/**
 * REGRESSION vector, not an independent known answer: the exact `keyslots.json` bytes the module produced
 * with injected randomness and real Argon2id at the floor parameters (19,456 KiB, t = 2, p = 1).
 * Injected draws, in order (draw n returns bytes 0x10*(n+1), +1, +2, ...): vaultId = 10..1f, VCK = 20..3f,
 * slotId = 30..3f, salt = 40..4f, wrap nonce = 50..5b. Passphrase HEZVIDN7IBGLQIXB5L7VARDHC.
 * The test also recomputes the commitment and the wrapped key with node:crypto (Argon2id, HKDF, AES-GCM), so the
 * pin is checked by an independent primitive implementation on every run.
 */
export const REGRESSION_KEYSLOTS = `{
  "slots": [
    {
      "commit": "qrsYdZ5YN/ITK9nUBBp3o1HS7oNjy4XN+RzqaD0AFmw=",
      "id": "303132333435363738393a3b3c3d3e3f",
      "kdf": {
        "alg": "argon2id",
        "dkLen": 32,
        "m": 19456,
        "p": 1,
        "salt": "QEFCQ0RFRkdISUpLTE1OTw==",
        "t": 2,
        "v": 19
      },
      "type": "passphrase",
      "wrap": {
        "alg": "aes-256-gcm",
        "ct": "Q3NJGsP2VPTGMfWSa0lygdBxePDbkIXXftMA1Kx2u4HOOgAs89oa9B2Ibxbfi+X4",
        "nonce": "UFFSU1RVVldYWVpb"
      }
    }
  ],
  "vaultId": "101112131415161718191a1b1c1d1e1f",
  "version": 1
}
`;
