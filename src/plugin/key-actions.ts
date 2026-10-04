import type { SyncConfig } from "../core/config";
import { ConfigError, assertMfsMutationPath, validateMfsRoot } from "../core/config";
import type { Bytes } from "../core/host-bridge";
import {
  canonicalizePassphraseText,
  formatPassphrase,
  generatePassphrase,
  wipe,
  type CanonicalPassphrase,
  type CostPolicy,
  type GeneratedPassphrase,
  type KdfParams,
  type KdfProgress,
  type RewrapSecret,
} from "../crypto";
import type { KuboClient, Transport } from "../kubo";
import {
  commitAcceptance,
  costFloorOf,
  executeRewrap,
  pendingMaintenance,
  planRewrapCost,
  prepareAcceptance,
  prepareRewrap,
  type KeyOperations,
  type PreparedAcceptance,
  type PreparedRewrap,
} from "../sync/key-management";
import { reached } from "../sync/maintenance-journal";
import { executePrune, preparePrune, type PreparedPrune } from "../sync/prune-history";
import { nothingToPrune, pruneStatements } from "../sync/prune-history-text";
import type { LockContext, LockFile } from "../sync/publish-lock";
import type { AcceptCheckResult, AcceptCommitResult, AcceptReview } from "./accept-slots-dialog-model";
import type { ChangePassphraseResult } from "./change-passphrase-dialog-model";
import { createAdapterLockFile, createPluginLockContext } from "./adapter-lock-file";
import type { IncreaseCostResult } from "./increase-cost-dialog-model";
import { acquireKeyActionLock, isBusy, type KeyActionLock } from "./key-action-lock";
import { busyFailure, failureOf } from "./key-action-failure";
import type { KeyDialogOpeners } from "./key-dialogs";
import { relateCost, type KeyDialogOutcome } from "./key-dialog-shared";
import { openKeyPorts, readKeySlotsCopy, type HeldLock, type KeyPorts, type KeyPortsContext } from "./key-ports";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import type { PrunePreviewResult, PruneRemoveResult } from "./prune-history-dialog-model";
import { passphraseFormatCheck, type DialogHandle } from "./session-dialogs";
import type { SessionKeys } from "./session-keys";
import type { SettingsStore } from "./settings-store";
import { settingsToConfig } from "./settings-to-config";
import type { SyncLock } from "./sync-lock";

/**
 * The plugin side of the key-management actions (mvp-07b task 2.2): it opens the change-passphrase, increase-cost and accept-slots dialogs
 * (task 2.1) and answers each one from the engine in `src/sync/key-management.ts`. It decides nothing about keys: the order of derivations, the
 * journal, the test unlock and every refusal are the engine's, the same code the command line runs.
 *
 * What this file adds around the engine:
 *   - the locks: an action holds the in-process lock and `publish.lock` (with the token check) while it works, so publish, pull and the timer wait.
 *     Accept holds them from a successful check until Accept ends or the dialog closes, because the prepared acceptance is a view of the node taken
 *     under the lock;
 *   - the passphrase text becomes a canonical passphrase for one call and is wiped in `finally`; the dialog already emptied its field;
 *   - the real outcome goes back to the dialog (`key-action-failure.ts`): `retryable` only for a refusal that wrote nothing and that trying again can fix.
 *
 * Prune history (task 2.5) is the fourth action and takes the same locks, but in two steps like Accept: the preview (`preparePrune`: one derivation, all
 * reads, nothing written) keeps both locks when the plan removes something, because the prepared prune is a view of the node taken under the lock;
 * the removal (`executePrune`, behind the explicit press in the dialog) is single use and gives the locks back whatever its answer. The timer and the
 * catch-up pull cannot reach it: it is started only from the settings row.
 *
 * Costs above the default (the slot being unlocked or accepted costs more than 64 MiB, t=3) need the cost-confirm dialog of task 2.4. Its two parts
 * are `costConfirmation` in the dependencies: `policy` for unlocking the current slot and `confirm` for incoming slots. Without it the engine
 * refuses such a slot, exactly as the command line does without a terminal, and the refusal is shown in the dialog.
 */

/** The engine functions the actions call, as a record so a test can watch which of them each dialog reaches. */
export interface KeyEngine {
  readonly prepareRewrap: typeof prepareRewrap;
  readonly planRewrapCost: typeof planRewrapCost;
  readonly executeRewrap: typeof executeRewrap;
  readonly prepareAcceptance: typeof prepareAcceptance;
  readonly commitAcceptance: typeof commitAcceptance;
  readonly costFloorOf: typeof costFloorOf;
  readonly pendingMaintenance: typeof pendingMaintenance;
  readonly preparePrune: typeof preparePrune;
  readonly executePrune: typeof executePrune;
}

export const REAL_KEY_ENGINE: KeyEngine = {
  prepareRewrap,
  planRewrapCost,
  executeRewrap,
  prepareAcceptance,
  commitAcceptance,
  costFloorOf,
  pendingMaintenance,
  preparePrune,
  executePrune,
};

/** The two halves of the cost-confirm dialog (task 2.4), both asked inside an action that already holds the locks. */
export interface CostConfirmation {
  /** Approves unlocking a current slot that costs more than the default. */
  readonly policy: CostPolicy;
  /** Approves incoming slots above the default cost, asked once for all tried slots. */
  readonly confirm: (costs: readonly KdfParams[]) => Promise<boolean>;
}

export interface KeyActionsDeps {
  readonly store: SettingsStore;
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  /** Shared with the publish and pull runners. */
  readonly lock: SyncLock;
  readonly transport: Transport;
  readonly now: () => Date;
  readonly dialogs: KeyDialogOpeners;
  /** Called after a change reached this device's key-slot copy: the plugin drops the held keys (they were opened from the old file) and looks again. */
  readonly afterChange: () => void;
  /** Task 2.4: the cost-confirm dialog (`obsidianCostConfirmation`). Absent in a test that does not ask; the engine then refuses a slot above the default. */
  readonly costConfirmation?: CostConfirmation;
  readonly lockFile?: LockFile;
  readonly lockContext?: LockContext;
  /** Tests swap the node client, the cryptography, the engine, the ports and the passphrase generator. */
  readonly createClient?: (config: SyncConfig) => KuboClient;
  readonly operations?: KeyOperations;
  readonly engine?: KeyEngine;
  readonly openPorts?: (held: HeldLock, options: { readonly lenient: boolean }) => Promise<KeyPorts>;
  readonly generate?: () => GeneratedPassphrase;
}

/** How an attempt to open an action ended when no dialog finished it. */
export type KeyActionStart = KeyDialogOutcome | "busy" | "already-open" | "no-vault";

export interface KeyActions {
  /** The cost of the key slot this device holds; `undefined` when there is none or the settings do not address a root. Reads one local file. */
  slotCost(): Promise<KdfParams | undefined>;
  changePassphrase(): Promise<KeyActionStart>;
  increaseCost(): Promise<KeyActionStart>;
  acceptSlots(): Promise<KeyActionStart>;
  /** Task 2.5: open the prune-history dialog. */
  pruneHistory(): Promise<KeyActionStart>;
  /** Close an open dialog and give back a lock an accept review holds (plugin unload). */
  dispose(): void;
}

interface CostChoice {
  readonly params: KdfParams;
  readonly allowDowngrade: boolean;
}

interface RewrapRequest {
  readonly kind: "change-passphrase" | "increase-cost";
  readonly passphraseText: string;
  readonly next: RewrapSecret;
  /** `increase-cost` only. */
  readonly choice: CostChoice | undefined;
  readonly onProgress: KdfProgress;
}

const STALE_REVIEW_TEXT = "The check is no longer current. Close this dialog and start again from the settings. Nothing was changed.";
const NO_PRUNE_PREVIEW_TEXT = "There is no current preview to remove. Close this dialog and start again from the settings. Nothing was removed.";

/** The operation a pending maintenance journal belongs to, for the sentence that names the ways out. A journal that cannot be read counts as pending. */
type PendingOperation = "key-slot rewrap" | "history prune" | "key-management operation";

/** A rewrap that did not reach `published` may have written into the shared tree; taking that back out needs the publication key. */
function needsWithdrawal(prepared: PreparedAcceptance): boolean {
  const { maintenance } = prepared;
  return maintenance.kind === "ok" && maintenance.journal.type === "rewrap" && !reached(maintenance.journal, "published");
}

const hasChanges = (prepared: PreparedAcceptance): boolean => Object.values(prepared.work).some(Boolean);

export function createKeyActions(deps: KeyActionsDeps): KeyActions {
  const engine = deps.engine ?? REAL_KEY_ENGINE;
  const lockDeps = {
    lock: deps.lock,
    lockFile: deps.lockFile ?? createAdapterLockFile(deps.adapter),
    lockContext: deps.lockContext ?? createPluginLockContext(() => deps.now().getTime()),
  };
  const portsContext: KeyPortsContext = {
    store: deps.store,
    adapter: deps.adapter,
    transport: deps.transport,
    now: deps.now,
    ...(deps.createClient === undefined ? {} : { createClient: deps.createClient }),
    ...(deps.operations === undefined ? {} : { operations: deps.operations }),
  };
  const openPorts = deps.openPorts ?? ((held, options) => openKeyPorts(portsContext, held, options));
  const generate = deps.generate ?? generatePassphrase;
  let active: DialogHandle | undefined;
  /** The lock, ports and prepared acceptance an accept review holds between its check and its Accept. */
  let review: { readonly held: KeyActionLock; readonly ports: KeyPorts; readonly prepared: PreparedAcceptance } | undefined;

  /** The lock, ports and prepared prune a prune preview holds between its preview and its removal. */
  let pruneReview: { readonly held: KeyActionLock; readonly ports: KeyPorts; readonly prepared: PreparedPrune } | undefined;

  async function releaseReview(): Promise<void> {
    const kept = review;
    review = undefined;
    const pruning = pruneReview;
    pruneReview = undefined;
    try {
      await kept?.held.release();
    } finally {
      await pruning?.held.release();
    }
  }

  /** This device's key-slot copy, or `undefined` when there is none or the settings address no root. */
  async function localCopy(): Promise<Bytes | undefined> {
    try {
      const config = settingsToConfig(deps.store.get(), deps.now());
      const mfsRoot = assertMfsMutationPath(validateMfsRoot(config.mfsRoot));
      return await readKeySlotsCopy(createObsidianHostBridge({ adapter: deps.adapter }), mfsRoot);
    } catch (error) {
      // Settings that do not validate address no root, so there is no slot to show; the next publish or setup reports the settings problem.
      if (error instanceof ConfigError) return undefined;
      throw error;
    }
  }

  async function slotCost(): Promise<KdfParams | undefined> {
    const copy = await localCopy();
    return copy === undefined ? undefined : engine.costFloorOf(copy);
  }

  /** The cost the rewrap writes: `change-passphrase` keeps the current cost; `increase-cost` raises it, or lowers it only with the confirmed downgrade. */
  function chosenCost(prepared: PreparedRewrap, request: RewrapRequest): CostChoice {
    const { choice } = request;
    if (request.kind === "change-passphrase" || choice === undefined) {
      return { params: engine.planRewrapCost(prepared.vault.keySlots, { kind: "change-passphrase", cost: undefined }).next, allowDowngrade: false };
    }
    // The engine's plan refuses an `increase-cost` that is not higher. The lower choice the dialog offers goes straight to the rewrap, which holds
    // it to the floors and refuses it without `allowDowngrade`.
    if (relateCost(prepared.currentCost, choice.params) === "lower") return choice;
    return { params: engine.planRewrapCost(prepared.vault.keySlots, { kind: "increase-cost", cost: choice.params }).next, allowDowngrade: false };
  }

  async function journalPending(ports: KeyPorts | undefined): Promise<boolean> {
    if (ports === undefined) return false;
    try {
      return (await engine.pendingMaintenance(ports.deps, ports.mfsRoot)) !== undefined;
    } catch {
      // A journal that cannot be read counts as pending: the refusal names both ways out.
      return true;
    }
  }

  /** One rewrap under the locks. Never throws: the answer is the dialog's result. */
  async function runRewrap(request: RewrapRequest): Promise<ChangePassphraseResult | IncreaseCostResult> {
    let held: Awaited<ReturnType<typeof acquireKeyActionLock>>;
    try {
      held = await acquireKeyActionLock(lockDeps);
    } catch (error) {
      return failureOf(error);
    }
    if (isBusy(held)) return busyFailure(held.holder);
    let passphrase: CanonicalPassphrase | undefined;
    let ports: KeyPorts | undefined;
    try {
      passphrase = canonicalizePassphraseText(request.passphraseText);
      ports = await openPorts(held, { lenient: false });
      const policy = deps.costConfirmation?.policy;
      const prepared = await engine.prepareRewrap(ports.deps, {
        mfsRoot: ports.mfsRoot,
        keyName: ports.keyName,
        passphrase,
        key: ports.key,
        onProgress: request.onProgress,
        ...(policy === undefined ? {} : { costPolicy: policy }),
      });
      const cost = chosenCost(prepared, request);
      const outcome = await engine.executeRewrap(ports.deps, prepared, {
        passphrase,
        next: request.next,
        params: cost.params,
        onProgress: request.onProgress,
        ...(cost.allowDowngrade ? { allowDowngrade: true } : {}),
        ...(policy === undefined ? {} : { costPolicy: policy }),
      });
      deps.afterChange();
      return { ok: true, testUnlock: outcome.testUnlock };
    } catch (error) {
      return failureOf(error, { journalPending: await journalPending(ports) });
    } finally {
      wipe(passphrase);
      await held.release();
    }
  }

  /** Accept, step one: read both files of one root, unlock, authenticate, judge. The locks are kept on success. */
  async function checkSlots(text: string, onProgress: KdfProgress): Promise<AcceptCheckResult> {
    await releaseReview();
    let taken: Awaited<ReturnType<typeof acquireKeyActionLock>>;
    try {
      taken = await acquireKeyActionLock(lockDeps);
    } catch (error) {
      return failureOf(error);
    }
    if (isBusy(taken)) return busyFailure(taken.holder);
    let passphrase: CanonicalPassphrase | undefined;
    let kept = false;
    try {
      passphrase = canonicalizePassphraseText(text);
      const ports = await openPorts(taken, { lenient: true });
      const target = await ports.resolveAcceptTarget();
      const confirm = deps.costConfirmation?.confirm;
      const prepared = await engine.prepareAcceptance(ports.acceptDeps, {
        mfsRoot: ports.mfsRoot,
        passphrase,
        target,
        onProgress,
        ...(confirm === undefined ? {} : { confirmCost: confirm }),
      });
      if (needsWithdrawal(prepared) && ports.keyRefusal !== undefined) throw ports.keyRefusal;
      const copy = await ports.readCopy();
      const costs: AcceptReview = {
        current: copy === undefined ? undefined : engine.costFloorOf(copy),
        incoming: engine.costFloorOf(prepared.acceptance.keySlots),
        changes: hasChanges(prepared),
      };
      review = { held: taken, ports, prepared };
      kept = true;
      return { ok: true, review: costs };
    } catch (error) {
      return failureOf(error);
    } finally {
      wipe(passphrase);
      if (!kept) await taken.release();
    }
  }

  /** Accept, step two: store what step one judged, then give the locks back whatever the answer. */
  async function accept(confirmation: { readonly downgradeConfirmed: boolean }): Promise<AcceptCommitResult> {
    const current = review;
    if (current === undefined) return { ok: false, reason: STALE_REVIEW_TEXT, retryable: false };
    try {
      const outcome = await engine.commitAcceptance(current.ports.acceptDeps, current.prepared, { downgradeConfirmed: confirmation.downgradeConfirmed });
      if (outcome.kind === "accepted") deps.afterChange();
      return { ok: true, kind: outcome.kind };
    } catch (error) {
      return failureOf(error);
    } finally {
      await releaseReview();
    }
  }

  /** What a journal on this device belongs to, or `undefined` when none is pending. */
  async function pendingOperation(ports: KeyPorts | undefined): Promise<PendingOperation | undefined> {
    if (ports === undefined) return undefined;
    try {
      const pending = await engine.pendingMaintenance(ports.deps, ports.mfsRoot);
      if (pending === undefined) return undefined;
      return pending.type === "prune" ? "history prune" : "key-slot rewrap";
    } catch {
      return "key-management operation";
    }
  }

  /**
   * Prune, step one: open the vault with the typed passphrase, run every refusal of the engine and say what the plan would do, as counts and fixed
   * text. Nothing is written. The locks are kept when the plan removes something; a plan that removes nothing needs none.
   */
  async function previewPrune(input: { readonly keep: number; readonly passphrase: string }, onProgress: KdfProgress): Promise<PrunePreviewResult> {
    await releaseReview();
    let taken: Awaited<ReturnType<typeof acquireKeyActionLock>>;
    try {
      taken = await acquireKeyActionLock(lockDeps);
    } catch (error) {
      return failureOf(error);
    }
    if (isBusy(taken)) return busyFailure(taken.holder);
    let passphrase: CanonicalPassphrase | undefined;
    let ports: KeyPorts | undefined;
    let kept = false;
    try {
      passphrase = canonicalizePassphraseText(input.passphrase);
      ports = await openPorts(taken, { lenient: false });
      const policy = deps.costConfirmation?.policy;
      const prepared = await engine.preparePrune(ports.deps, {
        mfsRoot: ports.mfsRoot,
        keyName: ports.keyName,
        passphrase,
        key: ports.key,
        keep: input.keep,
        onProgress,
        ...(policy === undefined ? {} : { costPolicy: policy }),
      });
      const { plan } = prepared;
      const removing = plan.removals.length;
      // Counts and the engine's fixed sentences only: no history name is copied out of the prepared prune.
      const statements =
        removing === 0 ? [nothingToPrune(plan)] : pruneStatements({ plan, checked: prepared.checked, sequence: prepared.start.manifest.sequence });
      if (removing > 0) {
        pruneReview = { held: taken, ports, prepared };
        kept = true;
      }
      return { ok: true, review: { removing, keeping: plan.kept.length, total: plan.total, statements } };
    } catch (error) {
      const operation = await pendingOperation(ports);
      return failureOf(error, { operation: operation ?? "history prune", journalPending: operation !== undefined });
    } finally {
      wipe(passphrase);
      if (!kept) await taken.release();
    }
  }

  /**
   * Prune, step two, behind the explicit press: remove what the preview showed. Single use, and the locks go back whatever the answer. Nothing here is
   * retryable: the preview was a view of the node under a lock this call ends, so a second press has nothing to act on.
   */
  async function removePrune(): Promise<PruneRemoveResult> {
    const current = pruneReview;
    pruneReview = undefined;
    if (current === undefined) return { ok: false, reason: NO_PRUNE_PREVIEW_TEXT, retryable: false };
    try {
      const outcome = await engine.executePrune(current.ports.deps, current.prepared);
      return { ok: true, kind: outcome.kind, removed: outcome.removed, kept: outcome.kept };
    } catch (error) {
      const operation = await pendingOperation(current.ports);
      return { ...failureOf(error, { operation: operation ?? "history prune", journalPending: operation !== undefined }), retryable: false };
    } finally {
      await current.held.release();
    }
  }

  /** Open one dialog. At most one key dialog is open, and none opens while another sync operation holds the lock. */
  function openDialog(create: (onFinish: (outcome: KeyDialogOutcome) => void) => DialogHandle): Promise<KeyActionStart> {
    if (active !== undefined) return Promise.resolve("already-open");
    if (deps.lock.holder() !== undefined) return Promise.resolve("busy");
    return new Promise<KeyActionStart>((resolve) => {
      active = create((outcome) => {
        active = undefined;
        void releaseReview().finally(() => resolve(outcome));
      });
    });
  }

  async function changePassphrase(): Promise<KeyActionStart> {
    const copy = await localCopy();
    if (copy === undefined) return "no-vault";
    const cost = engine.costFloorOf(copy);
    const generated = generate();
    return openDialog((onFinish) =>
      deps.dialogs.changePassphrase(
        {
          passphrase: formatPassphrase(generated),
          cost,
          check: passphraseFormatCheck,
          run: (current, onProgress) =>
            runRewrap({ kind: "change-passphrase", passphraseText: current, next: { kind: "generated", passphrase: generated }, choice: undefined, onProgress }),
        },
        (outcome) => {
          wipe(generated);
          onFinish(outcome);
        },
      ),
    );
  }

  async function increaseCost(): Promise<KeyActionStart> {
    const copy = await localCopy();
    if (copy === undefined) return "no-vault";
    const current = engine.costFloorOf(copy);
    return openDialog((onFinish) =>
      deps.dialogs.increaseCost(
        {
          current,
          check: passphraseFormatCheck,
          run: (input, onProgress) =>
            runRewrap({
              kind: "increase-cost",
              passphraseText: input.passphrase,
              next: { kind: "reuse" },
              choice: { params: input.params, allowDowngrade: input.allowDowngrade },
              onProgress,
            }),
        },
        onFinish,
      ),
    );
  }

  async function acceptSlots(): Promise<KeyActionStart> {
    const copy = await localCopy();
    if (copy === undefined) return "no-vault";
    return openDialog((onFinish) => deps.dialogs.acceptSlots({ target: "name", check: passphraseFormatCheck, checkSlots, accept }, onFinish));
  }

  async function pruneHistory(): Promise<KeyActionStart> {
    const copy = await localCopy();
    if (copy === undefined) return "no-vault";
    const cost = engine.costFloorOf(copy);
    return openDialog((onFinish) =>
      deps.dialogs.pruneHistory({ cost, check: passphraseFormatCheck, preview: previewPrune, remove: removePrune }, onFinish),
    );
  }

  return {
    slotCost,
    changePassphrase,
    increaseCost,
    acceptSlots,
    pruneHistory,
    dispose: () => {
      active?.close();
      void releaseReview();
    },
  };
}
