import type { EnvMap, SyncConfig } from "../src/core/config";
import type { CanonicalPassphrase } from "../src/crypto";
import type { KuboClient } from "../src/kubo";
import type { FreeBytes } from "../src/sync/encrypted-pull-fetch";
import type { PullFlags } from "./args";
import type { CliIo } from "./io";

/** What every pull route (the decrypting reader, the plaintext reader, the version listing) is given. Configuration is already validated. */
export interface PullContext {
  readonly config: SyncConfig;
  readonly client: KuboClient;
  readonly io: CliIo;
  readonly vaultPath: string;
  readonly flags: PullFlags;
  readonly env: EnvMap;
  readonly now: () => Date;
  /** Yields the canonical vault passphrase, or undefined when no source has one. Asked for only after the invocation and the destination are accepted. */
  readonly passphrase: () => Promise<CanonicalPassphrase | undefined>;
  /** Free bytes on the volume of the vault. Absent: Node `statfs` of the vault directory. */
  readonly freeBytes?: FreeBytes | undefined;
}
