import type { SyncEventBus } from "../core/events";
import type { HostBridge } from "../core/host-bridge";
import type { CanonicalPassphrase, CostPolicy, KdfParams, KdfProgress } from "../crypto";
import type { KuboClient } from "../kubo";
import type { SkippedFile } from "./diff";
import type { DeviceStore } from "./device-store";
import type { DroppedEntry } from "./publish-plan";
import type { MassRemovalCounts } from "./publish-refusals";
import type { ConfirmRepair } from "./repair";
import type { UnlockedVault } from "./vault-keys";

/** The kubo operations a publish uses. Note what is absent: no key or pin removal. */
export type PublishClient = Pick<
  KuboClient,
  "filesWrite" | "filesStat" | "filesRm" | "filesLs" | "ipfsLs" | "gatewayStream" | "keyList" | "keyGen" | "pinAdd" | "namePublish" | "nameResolve"
>;

export interface PublishDeps {
  readonly client: PublishClient;
  readonly host: HostBridge;
  readonly bus: SyncEventBus;
  /**
   * The installation's device id (32 hex characters), from the device-local store. The manifest `device` is then
   * `<label>-<first 12 hex>`. Called only when a manifest is built, so a refused run never touches the store. A host
   * that passes none publishes the bare label.
   */
  readonly deviceId?: () => Promise<string>;
  /**
   * The device-local store that holds the sequence floor. A publish raises the floor of its vault just before it writes
   * the state, and `--repair` reads it to refuse the ahead case. A host that passes none keeps no floor.
   */
  readonly deviceStore?: DeviceStore;
  /**
   * An asynchronous look at the publish lock, awaited immediately before the run's first request that can change the node:
   * before an interrupted publish is resumed, before the publication key is created or the first blob is written, and
   * before junk in `manifests/` is removed. It throws (the host's `lock-held`) when the lock is no longer this run's. The
   * synchronous `assertHeld` only knows the last heartbeat; this is the direct look. A host that passes none behaves as before.
   */
  readonly beforeFirstWrite?: () => Promise<void>;
}

export interface PublishOptions {
  readonly mfsRoot: string;
  readonly keyName: string;
  /** IDs of keys this installation owns (config file plus `--owned-key` for this run). */
  readonly ownedKeys: readonly string[];
  /** Called with the ID of a key this run generated; it must persist it or throw. */
  readonly recordOwnedKey: (keyId: string) => Promise<void>;
  readonly extraExclusions?: readonly string[];
  readonly concurrency?: number;
  /**
   * The vault passphrase, already canonicalised by the host. Publishing is always encrypted: without it the run
   * stops after the marker check and before any request.
   */
  readonly passphrase?: CanonicalPassphrase;
  /**
   * An already unlocked vault (the plugin session's provider). It is asked once per run; when it yields a vault whose
   * key slots match the ones being opened, no Argon2id derivation runs, so a timer tick never re-derives. The
   * passphrase is then optional. Without a session vault the passphrase path is used.
   */
  readonly unlocked?: () => UnlockedVault | undefined;
  /** Throws when the publish lock is no longer held. Called before every request that changes the node. */
  readonly assertHeld?: () => void;
  /** `--repair`: continue past a behind or ahead refusal, or an unreadable local record, under the repair conditions. */
  readonly repair?: boolean;
  /** Asks about the ahead case; without it that case is refused. */
  readonly confirmRepair?: ConfirmRepair;
  /** `--recover-slots`: unlock key slots this device knows nothing about, after showing their cost. */
  readonly recoverSlots?: boolean;
  readonly confirmRecover?: (costs: readonly KdfParams[]) => Promise<boolean>;
  /** Key slots above the default cost are refused unless this allows them (interactive hosts only). */
  readonly costPolicy?: CostPolicy;
  /** `--allow-full-reupload`: let a diagnosis that finds more than 256 MiB lost on the node upload it again. */
  readonly allowFullReupload?: boolean;
  /** Asks about that re-upload when the flag is absent; without it the re-upload is refused. */
  readonly confirmFullReupload?: (bytes: number) => Promise<boolean>;
  readonly onUnlockProgress?: KdfProgress;
  /** `--allow-mass-removal`: let a publish that removes every remaining entry, or more than half of them, run unasked. */
  readonly allowMassRemoval?: boolean;
  /**
   * Asks about such a publish when the flag is absent. Without it the publish is refused: an unattended timer publish passes none,
   * so it never opens a dialog and never removes most of a vault.
   */
  readonly confirmMassRemoval?: (counts: MassRemovalCounts) => Promise<boolean>;
}

export interface PublishResult {
  /** False when nothing changed: no manifest was created and no IPNS record was published. */
  readonly published: boolean;
  /** Blobs written, including blobs the node had lost and that were uploaded again. */
  readonly written: number;
  readonly removed: number;
  /** Files left out because the host refused to read them (over its read cap). Empty on hosts without a cap. */
  readonly skipped: readonly SkippedFile[];
  /**
   * Paths this device could not restore, kept in the manifest as the node has them and not published from here (sorted).
   * A local file at such a path is not compared and not uploaded.
   */
  readonly carried: readonly string[];
  /** Carried entries that left the manifest: this device's exclusion list matches them, or their path has an unsafe shape. */
  readonly dropped: readonly DroppedEntry[];
  /** Paths removed from the manifest because the exclusion list now matches them (sorted); not counted by the mass-removal guard. Absent on a run that sent nothing. */
  readonly exclusionRemoved?: readonly string[];
  readonly keyId: string;
  readonly keyCreated: boolean;
  /** CID of `<mfsRoot>` (the IPNS value). Present when published. */
  readonly rootCid?: string;
  /** CID of `<mfsRoot>/current` (the manifest's rootCID). Present when published. */
  readonly currentCid?: string;
  /** Sequence of the manifest that was published. Present when published. */
  readonly sequence?: number;
  /** Things worth saying that are not failures (for example that `manifests/` is nearly full). */
  readonly warnings: readonly string[];
  /** Entries in `current/` that are not this tool's blobs; reported and left in place. */
  readonly anomalies: number;
}
