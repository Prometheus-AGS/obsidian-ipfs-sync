import { assertMfsMutationPath, validateMfsRoot } from "../core/config";
import { ABANDON_CONFIRMATION, abandonVault, describeAbandonFloor, type AbandonFloor } from "../sync/vault-keys";
import type { AbandonDialogRequest, AbandonOutcome } from "./abandon-vault-dialog";
import { createPluginDeviceStore } from "./device-store-plugin";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import type { SessionKeys } from "./session-keys";
import { describeDialogError } from "./session-dialogs";
import type { SettingsStore } from "./settings-store";
import { settingsToLocalConfig } from "./settings-to-config";
import { busyNotice, type SyncLock } from "./sync-lock";

/**
 * The plugin side of "Abandon this vault": it opens the confirmation dialog (`abandon-vault-dialog.ts`) and, once the
 * word is typed, moves this device's key-slot copy, sync state and journal for the configured MFS root into
 * `.ipfs-sync/abandoned-*` with `abandonVault`. The node is never contacted (no client exists here). The sync lock is
 * held while files move, so a publish or pull cannot be writing them; the key session is locked afterwards and asked
 * to look again, so the Encryption section shows "Not set up" and the next setup can create a vault in a new root.
 */

export interface AbandonDialogHandle {
  close(): void;
}

export interface AbandonFlowDeps {
  readonly store: SettingsStore;
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  readonly lock: SyncLock;
  readonly session: Pick<SessionKeys, "lock" | "refresh">;
  readonly now: () => Date;
  /** Opens the confirmation dialog. Production passes a factory over `AbandonVaultDialog`. */
  readonly openDialog: (request: AbandonDialogRequest, onFinish: (outcome: AbandonOutcome) => void) => AbandonDialogHandle;
}

export interface AbandonFlow {
  /** Open the dialog. Resolves with its outcome, or with `busy` (no dialog) when a sync operation is running. */
  open(): Promise<AbandonOutcome | "busy">;
  /** Close an open dialog without abandoning (plugin unload). */
  dispose(): void;
}

export const NOTHING_TO_ABANDON = "this device holds no key-slot copy, state or journal for this MFS root, so nothing was moved. Check the MFS root in the settings.";

/** Number of files a call moved, and the backup note the dialog passes back. */
function backupNote(backupDir: string, count: number, floor: AbandonFloor): string {
  return `${count} file${count === 1 ? "" : "s"} moved to ${backupDir} in the vault folder. Nothing on the node was changed. ${describeAbandonFloor(floor)}. To start a new vault, choose an empty MFS root in the settings, then run Publish.`;
}

/** One open dialog: its handle is set after `openDialog` returns, and a dialog that finished before that is never recorded as open. */
interface OpenDialog {
  handle: AbandonDialogHandle | undefined;
  finished: boolean;
}

export function createAbandonFlow(deps: AbandonFlowDeps): AbandonFlow {
  let open: OpenDialog | undefined;

  /** The action behind the dialog's button. Never throws: a failure is returned as text for the dialog. */
  async function abandon(): Promise<Awaited<ReturnType<AbandonDialogRequest["abandon"]>>> {
    const release = deps.lock.tryAcquire("abandon");
    if (release === undefined) return { ok: false, reason: busyNotice(deps.lock.holder()) };
    try {
      const mfsRoot = assertMfsMutationPath(validateMfsRoot(settingsToLocalConfig(deps.store.get()).mfsRoot));
      const { fs } = createObsidianHostBridge({ adapter: deps.adapter, now: () => deps.now().getTime() });
      const { backupDir, moved, floor } = await abandonVault({
        fs,
        mfsRoot,
        confirmation: ABANDON_CONFIRMATION,
        nowMs: deps.now().getTime(),
        deviceStore: createPluginDeviceStore(deps.store),
      });
      if (moved.length === 0) return { ok: false, reason: NOTHING_TO_ABANDON };
      deps.session.lock();
      const reread = await deps.session.refresh().then(
        () => "",
        () => " The vault status could not be re-read; reload the plugin.",
      );
      return { ok: true, backupNote: backupNote(backupDir, moved.length, floor) + reread };
    } catch (error) {
      return { ok: false, reason: describeDialogError(error) };
    } finally {
      release();
    }
  }

  return {
    open: () => {
      if (deps.lock.holder() !== undefined) return Promise.resolve("busy");
      // At most one dialog is open: the lock is taken only when Confirm is pressed, so a second request closes the first.
      open?.handle?.close();
      return new Promise<AbandonOutcome | "busy">((resolve) => {
        const mine: OpenDialog = { handle: undefined, finished: false };
        mine.handle = deps.openDialog({ abandon }, (outcome) => {
          mine.finished = true;
          // Only this dialog's own record is dropped: a late finish of an earlier dialog must not forget the one open now.
          if (open === mine) open = undefined;
          resolve(outcome);
        });
        if (!mine.finished) open = mine;
      });
    },
    dispose: () => {
      open?.handle?.close();
      open = undefined;
    },
  };
}
