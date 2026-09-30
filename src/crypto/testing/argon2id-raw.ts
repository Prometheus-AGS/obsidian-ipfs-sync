/**
 * TEST-ONLY. Raw Argon2id that bypasses the parameter floors and ceilings of `../argon2.ts`, so the RFC 9106
 * section 5.3 vector (memory 32 KiB, 3 passes, 4 lanes, with secret and associated data) can be checked.
 * This module MUST NOT be imported by the plugin, the CLI or any module reachable from them; a build assertion
 * (tools/hook-isolation.mjs) fails the build if a bundle contains the sentinel below or any input from this folder.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import type { Bytes } from "../bytes";

export const ARGON2ID_RAW_SENTINEL = "IPFS_SYNC_TEST_ONLY_SENTINEL_ARGON2ID_RAW_c4d81f3a52e7";

export interface RawArgon2idInput {
  readonly password: Bytes;
  readonly salt: Bytes;
  /** Memory in KiB. */
  readonly m: number;
  readonly t: number;
  readonly p: number;
  readonly dkLen: number;
  /** RFC 9106 "secret" (K). */
  readonly secret?: Bytes;
  /** RFC 9106 "associated data" (X). */
  readonly associatedData?: Bytes;
}

export async function argon2idRaw(input: RawArgon2idInput): Promise<Bytes> {
  if (input.m > 2_097_152) throw new Error(`${ARGON2ID_RAW_SENTINEL}: refusing more than 2 GiB even in tests`);
  const tag = await argon2idAsync(input.password, input.salt, {
    t: input.t,
    m: input.m,
    p: input.p,
    dkLen: input.dkLen,
    version: 0x13,
    key: input.secret,
    personalization: input.associatedData,
    maxmem: 2_147_483_648,
    asyncTick: 10,
  });
  return new Uint8Array(tag);
}
