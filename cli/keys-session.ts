import { ConfigError, type EnvMap, type SyncConfig } from "../src/core/config";
import type { HostBridge } from "../src/core/host-bridge";
import { describeKdfCost, type CanonicalPassphrase, type CostPolicy, type KdfParams } from "../src/crypto";
import { DEFAULT_IPNS_TTL, type KuboClient } from "../src/kubo";
import type { DeviceStore } from "../src/sync/device-store";
import { REAL_KEY_OPERATIONS, type AcceptDeps, type KeyManagementDeps, type KeyOperations } from "../src/sync/key-management";
import { acceptCostQuestion, acceptDowngradeQuestion, downgradeQuestion, type RewrapCostPlan } from "../src/sync/key-management-text";
import { lockHeld } from "../src/sync/publish-refusals";
import { createMaintenanceNode } from "../src/sync/maintenance-node";
import { openPublicationKey, type PublicationKey } from "../src/sync/publish-key";
import type { PublishLock } from "../src/sync/publish-lock";
import { createSnapshotVerifier } from "../src/sync/read-back";
import type { SlotDowngrade } from "../src/sync/slot-acceptance";
import type { KeysFlags } from "./args";
import { createLazyDeviceStore } from "./device-store-node";
import type { CliIo } from "./io";
import type { FileHost } from "./passphrase-file";
import type { PromptTerminal } from "./passphrase-prompt";

/**
 * What the `keys` subcommands share (mvp-07b task 1.4; task 1.5 adds its subcommands to the same table): the context a command is given, the session
 * that holds the lock, and the ports key management needs, built once from them. Nothing here decides anything about a rewrap.
 */

/** Subcommands that exist in this build, in the order the help lists them. */
export const KEYS_SUBCOMMANDS = ["change-passphrase", "increase-cost", "accept-slots", "discard"] as const;
export type KeysSubcommand = (typeof KEYS_SUBCOMMANDS)[number];

/** The pull flags `accept-slots` shares with `pull`: which root to read, and the expectations a pull checks before it derives. */
export interface AcceptFlags {
  readonly name: string | undefined;
  readonly rootCid: string | undefined;
  readonly allowRollback: boolean;
  readonly expectVaultId: string | undefined;
  readonly expectMinSequence: number | undefined;
}

export interface KeysContext {
  readonly config: SyncConfig;
  readonly client: KuboClient;
  readonly io: CliIo;
  readonly vaultPath: string;
  readonly subcommand: KeysSubcommand;
  readonly flags: KeysFlags;
  /** `accept-slots` only; the run refuses these flags for every other subcommand before it starts. */
  readonly accept: AcceptFlags;
  /** `--yes-discard`: the non-interactive yes of `keys discard`. */
  readonly yesDiscard: boolean;
  /** `--passphrase-file <path>`: where `change-passphrase` writes the passphrase it generates. */
  readonly passphraseFile: string | undefined;
  readonly env: EnvMap;
  readonly now: () => Date;
  /** The CURRENT vault passphrase from the sources `publish` uses (environment, 0600 file, prompt); undefined when none is available. */
  readonly passphrase: () => Promise<CanonicalPassphrase | undefined>;
  readonly terminal: PromptTerminal | undefined;
  readonly file: FileHost;
  /** The device-local store (the sequence floor). Production leaves it out (the per-user directory); tests pass one. */
  readonly deviceStore?: DeviceStore;
  /** The cryptography. Production leaves it out; tests pass fast stand-ins. */
  readonly operations?: KeyOperations;
}

/** One run: the vault directory, its host, the MFS root and the publish lock this run holds. */
export interface KeysSession {
  readonly ctx: KeysContext;
  readonly vault: string;
  readonly host: HostBridge;
  readonly mfsRoot: string;
  readonly lock: PublishLock;
  /** Re-reads the lock file's token (`lock-token-check.ts`). */
  readonly verifyHeld: () => Promise<boolean>;
}

/**
 * What the ports need from a run: `keys` and `prune-history` both build them (mvp-07b task 1.6). The lock is only asked to `assertHeld`, so a run that holds
 * none (a dry run) passes one that refuses every write.
 */
export interface PortsSession {
  readonly ctx: Pick<KeysContext, "config" | "client" | "env" | "now" | "deviceStore" | "operations">;
  readonly host: HostBridge;
  readonly mfsRoot: string;
  readonly lock: Pick<PublishLock, "assertHeld">;
  /** Re-reads the lock file's token (`lock-token-check.ts`). */
  readonly verifyHeld: () => Promise<boolean>;
}

export interface KeyPorts {
  readonly deps: KeyManagementDeps;
  readonly key: PublicationKey;
  /** The same ports as `accept` and `discard` use them (the floor store is never absent there). */
  readonly acceptDeps: AcceptDeps;
  /** Set when the publication key is on the node but not owned by this installation and the ports were opened with `lenient`. */
  readonly keyRefusal: ConfigError | undefined;
}

/** What stands in for a key this installation does not own: no ID, so the name is never read for it and nothing is ever published under it. */
const NO_KEY: PublicationKey = {
  absent: true,
  id: () => "",
  created: () => false,
  ensure: async () => {
    throw new Error("a key this installation does not own is never created");
  },
};

async function openKey(session: PortsSession, lenient: boolean): Promise<{ readonly key: PublicationKey; readonly refusal: ConfigError | undefined }> {
  const { ctx } = session;
  try {
    return { key: await openPublicationKey(ctx.client, ctx.config.publicationKey, ctx.config.ownedKeys, async () => undefined), refusal: undefined };
  } catch (error) {
    // `accept-slots` on a second device reads two files of a root and needs no key of its own; only a withdrawal needs the name, and says so.
    if (lenient && error instanceof ConfigError && error.code === "foreign-key") return { key: NO_KEY, refusal: error };
    throw error;
  }
}

/**
 * The ports of key management over the real node, host and lock. The publication key is looked up and never created (`ensure` is not called): a key
 * that is absent or foreign makes the operation refuse, unless the run is `lenient` (accept-slots), which then records the refusal in `keyRefusal`.
 */
export async function openKeyPorts(session: PortsSession, options: { readonly lenient?: boolean } = {}): Promise<KeyPorts> {
  const { ctx, host, mfsRoot, lock } = session;
  const { key, refusal } = await openKey(session, options.lenient === true);
  const node = createMaintenanceNode({
    client: ctx.client,
    mfsRoot,
    key: ctx.config.publicationKey,
    ttl: DEFAULT_IPNS_TTL,
    keyId: () => key.id(),
    keyCreated: () => key.created(),
    beforeWrite: () => lock.assertHeld(),
  });
  const deps: KeyManagementDeps = {
    node,
    fs: host.fs,
    kv: host.kv,
    // The lazy store locates the per-user directory only when the floor is first read.
    deviceStore: ctx.deviceStore ?? createLazyDeviceStore(ctx.env),
    ops: ctx.operations ?? REAL_KEY_OPERATIONS,
    now: () => ctx.now().toISOString(),
    snapshotVerifier: (keySlots) => createSnapshotVerifier({ client: ctx.client, keySlots, written: new Map() }),
    assertHeld: () => lock.assertHeld(),
    // The 07a standard: the token is re-read right before the first change, not only after the lock was taken.
    beforeFirstWrite: async () => {
      if (!(await session.verifyHeld())) throw lockHeld("the lock file no longer carries this run's token");
    },
  };
  const acceptDeps: AcceptDeps = {
    node,
    fs: host.fs,
    kv: host.kv,
    deviceStore: deps.deviceStore as DeviceStore,
    assertHeld: deps.assertHeld,
    ...(deps.beforeFirstWrite === undefined ? {} : { beforeFirstWrite: deps.beforeFirstWrite }),
  };
  return { deps, key, acceptDeps, keyRefusal: refusal };
}

/** The question `increase-cost` and `change-passphrase` ask once the statements have been printed. */
export const REVOCATION_QUESTION = "Go ahead? Nothing is revoked: the old passphrase and every old copy of the key-slot file still open this vault.";

/** Yes with `--accept-no-revocation`; otherwise the answer to the question. A run that cannot ask answers no. */
export async function confirmRevocation(io: CliIo, flags: KeysFlags): Promise<boolean> {
  if (flags.acceptNoRevocation) return true;
  return (await io.confirm?.(REVOCATION_QUESTION)) === true;
}

/**
 * A new cost below the current one needs its own yes, with both costs shown. `--allow-downgrade` is that yes without a terminal. Nothing to ask when
 * the cost does not fall.
 */
export async function confirmDowngrade(io: CliIo, plan: RewrapCostPlan, allow: boolean): Promise<boolean> {
  if (!plan.downgrade) return true;
  if (allow) return true;
  return (await io.confirm?.(downgradeQuestion(plan))) === true;
}

/**
 * A cheaper incoming slot needs its own yes, with both costs shown. `--allow-downgrade` is that yes without a terminal. Nothing to ask when the slot is
 * not cheaper than this device's copy.
 */
export async function confirmAcceptDowngrade(io: CliIo, downgrade: SlotDowngrade | undefined, allow: boolean): Promise<boolean> {
  if (downgrade === undefined) return true;
  if (allow) return true;
  return (await io.confirm?.(acceptDowngradeQuestion(downgrade))) === true;
}

/** The cost question of an incoming slot above the default, asked once for all tried slots; absent without a terminal, which refuses such a file. */
export function askingCostConfirm(io: CliIo): ((costs: readonly KdfParams[]) => Promise<boolean>) | undefined {
  const { confirm } = io;
  return confirm === undefined ? undefined : (costs) => confirm(acceptCostQuestion(costs));
}

/** Answers for a current slot above the default cost: asked on a terminal, refused without one (as `publish` does). */
export function askingCostPolicy(io: CliIo): CostPolicy | undefined {
  const { confirm } = io;
  if (confirm === undefined) return undefined;
  return { approveCost: (params) => confirm(`A key slot on the node costs ${describeKdfCost(params)} to unlock, above the default. Continue?`) };
}
