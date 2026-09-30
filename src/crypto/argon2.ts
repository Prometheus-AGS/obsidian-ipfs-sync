import { argon2idAsync } from "@noble/hashes/argon2.js";
import type { Bytes } from "./bytes";
import { CryptoError, KdfCostRefusedError, KdfParamsError } from "./errors";

/*
 * Argon2id key derivation (RFC 9106) from `@noble/hashes` 2.4.0. This wrapper is the only public path to it:
 * it enforces the floors and ceilings of the key-slot format before anything is allocated, runs the async
 * chunked variant so the host event loop keeps turning, and passes an explicit memory limit.
 * The RFC 9106 test vector uses parameters below the floors and is reachable only through the test-only
 * `testing/argon2id-raw` entry, never through this module.
 */
export const KDF_ALGORITHM = "argon2id";
/** Argon2 version 0x13 (decimal 19). */
export const KDF_VERSION = 19;
export const KDF_OUTPUT_BYTES = 32;
export const KDF_SALT_BYTES = 16;
export const KDF_PARALLELISM = 1;

export const KDF_MEMORY_FLOOR_KIB = 19_456;
export const KDF_MEMORY_DEFAULT_KIB = 65_536;
export const KDF_MEMORY_CEILING_KIB = 131_072;
export const KDF_ITERATIONS_FLOOR = 2;
export const KDF_ITERATIONS_DEFAULT = 3;
export const KDF_ITERATIONS_CEILING = 4;

/** Explicit memory limit handed to Argon2id, in bytes: equal to the memory ceiling. */
export const KDF_MAXMEM_BYTES = KDF_MEMORY_CEILING_KIB * 1024;

/** Longest stretch of computation between two yields to the event loop, in milliseconds. */
export const KDF_ASYNC_TICK_MS = 10;

/** Argon2id cost parameters as stored in a key slot: memory in KiB, iterations, parallelism. */
export interface KdfParams {
  readonly m: number;
  readonly t: number;
  readonly p: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = Object.freeze({
  m: KDF_MEMORY_DEFAULT_KIB,
  t: KDF_ITERATIONS_DEFAULT,
  p: KDF_PARALLELISM,
});

/** Completion fraction from 0 to 1, for the "unlocking" indicator. */
export type KdfProgress = (fraction: number) => void;

/** A key-derivation function: the shape `deriveKek` has, and the shape a test or a host may substitute (for example to count runs). */
export type KdfFunction = (password: Bytes, salt: Bytes, params: KdfParams, onProgress?: KdfProgress) => Promise<Bytes>;

/**
 * Refuse parameters outside the floors and ceilings, naming the offending parameter. Runs before any
 * derivation, so a hostile key-slot file cannot make the device allocate memory or spend time.
 */
export function assertKdfParams(params: KdfParams): void {
  const { m, t, p } = params;
  if (!Number.isInteger(m) || m < KDF_MEMORY_FLOOR_KIB) {
    throw new KdfParamsError("memory", `Argon2id memory ${String(m)} KiB is below the floor of ${KDF_MEMORY_FLOOR_KIB} KiB`);
  }
  if (m > KDF_MEMORY_CEILING_KIB) {
    throw new KdfParamsError("memory", `Argon2id memory ${String(m)} KiB is above the ceiling of ${KDF_MEMORY_CEILING_KIB} KiB`);
  }
  if (!Number.isInteger(t) || t < KDF_ITERATIONS_FLOOR) {
    throw new KdfParamsError("iterations", `Argon2id iterations ${String(t)} is below the floor of ${KDF_ITERATIONS_FLOOR}`);
  }
  if (t > KDF_ITERATIONS_CEILING) {
    throw new KdfParamsError("iterations", `Argon2id iterations ${String(t)} is above the ceiling of ${KDF_ITERATIONS_CEILING}`);
  }
  if (p !== KDF_PARALLELISM) {
    throw new KdfParamsError("parallelism", `Argon2id parallelism ${String(p)} is not the required ${KDF_PARALLELISM}`);
  }
}

/**
 * Unlock cost policy. Without a policy, or without `approveCost`, a slot above `maxCost` (default: the default
 * parameters) is refused with `kdf-cost-refused`. A host that can ask the user passes `approveCost`, which is
 * called once for each tried slot above `maxCost`, before any derivation starts; only `true` allows it.
 */
export interface CostPolicy {
  readonly maxCost?: KdfParams;
  readonly approveCost?: (params: KdfParams) => Promise<boolean>;
}

export async function enforceCostPolicy(tried: readonly KdfParams[], policy: CostPolicy | undefined): Promise<void> {
  const max = policy?.maxCost ?? DEFAULT_KDF_PARAMS;
  const above = tried.filter((params) => params.m > max.m || params.t > max.t);
  for (const params of above) {
    let approved = false;
    try {
      approved = policy?.approveCost === undefined ? false : (await policy.approveCost({ ...params })) === true;
    } catch {
      approved = false; // a callback that throws or rejects is a refusal, never an approval
    }
    if (!approved) {
      throw new KdfCostRefusedError(above, `key slot costs ${describeKdfCost(params)}, above the allowed ${describeKdfCost(max)}; not approved`);
    }
  }
}

/** True when the parameters are above the defaults, so an interactive host must ask before deriving. */
export function exceedsDefaultCost(params: KdfParams): boolean {
  return params.m > KDF_MEMORY_DEFAULT_KIB || params.t > KDF_ITERATIONS_DEFAULT;
}

/** Human-readable cost, for confirmation and refusal messages: "64 MiB, 3 iterations". */
export function describeKdfCost(params: KdfParams): string {
  return `${params.m / 1024} MiB, ${params.t} iterations`;
}

/**
 * Derive the 32-byte key-encryption key from canonical passphrase bytes. The parameters are validated first;
 * a salt that is not 16 bytes is refused. The caller owns `password` and the returned key and should overwrite
 * both when done (best effort: the library and the runtime may keep copies of intermediate blocks).
 */
export const deriveKek: KdfFunction = async (password, salt, params, onProgress) => {
  assertKdfParams(params);
  if (salt.length !== KDF_SALT_BYTES) throw new KdfParamsError("salt", `Argon2id salt must be ${KDF_SALT_BYTES} bytes`);
  let output: Uint8Array;
  let progressFailure = false;
  const guardedProgress = onProgress === undefined ? undefined : (fraction: number): void => {
    try {
      onProgress(fraction);
    } catch (error) {
      progressFailure = true;
      throw error;
    }
  };
  try {
    output = await argon2idAsync(password, salt, {
      t: params.t,
      m: params.m,
      p: params.p,
      dkLen: KDF_OUTPUT_BYTES,
      version: KDF_VERSION,
      maxmem: KDF_MAXMEM_BYTES,
      asyncTick: KDF_ASYNC_TICK_MS,
      onProgress: guardedProgress,
    });
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    if (progressFailure) throw new CryptoError("platform-failure", "the progress callback failed during key derivation");
    if (!(error instanceof RangeError)) throw new CryptoError("platform-failure", "key derivation failed");
    // A RangeError from allocating the memory block: this device cannot afford the slot.
    throw new CryptoError("kdf-unaffordable", `this device cannot afford this key slot (${describeKdfCost(params)})`);
  }
  const kek = new Uint8Array(output);
  output.fill(0);
  return kek;
};
