import type { App } from "obsidian";
import { AcceptSlotsDialog, type AcceptSlotsDialogRequest } from "./accept-slots-dialog";
import { ChangePassphraseDialog, type ChangePassphraseDialogRequest } from "./change-passphrase-dialog";
import { IncreaseCostDialog, type IncreaseCostDialogRequest } from "./increase-cost-dialog";
import type { KeyDialogOutcome } from "./key-dialog-shared";
import { PruneHistoryDialog, type PruneHistoryDialogRequest } from "./prune-history-dialog";
import type { DialogHandle } from "./session-dialogs";

/**
 * The four key-management dialogs (the fourth is the prune-history dialog of task 2.5) behind one seam, so the wiring (`key-actions.ts`) opens them without importing the classes and a test can
 * answer them from a script. Each opener returns the open dialog; `onFinish` is called once with how it ended.
 */
export interface KeyDialogOpeners {
  changePassphrase(request: ChangePassphraseDialogRequest, onFinish: (outcome: KeyDialogOutcome) => void): DialogHandle;
  increaseCost(request: IncreaseCostDialogRequest, onFinish: (outcome: KeyDialogOutcome) => void): DialogHandle;
  acceptSlots(request: AcceptSlotsDialogRequest, onFinish: (outcome: KeyDialogOutcome) => void): DialogHandle;
  pruneHistory(request: PruneHistoryDialogRequest, onFinish: (outcome: KeyDialogOutcome) => void): DialogHandle;
}

/** The real dialogs, opened over the app. */
export function obsidianKeyDialogs(app: App): KeyDialogOpeners {
  return {
    changePassphrase: (request, onFinish) => {
      const dialog = new ChangePassphraseDialog(app, request, onFinish);
      dialog.open();
      return dialog;
    },
    increaseCost: (request, onFinish) => {
      const dialog = new IncreaseCostDialog(app, request, onFinish);
      dialog.open();
      return dialog;
    },
    acceptSlots: (request, onFinish) => {
      const dialog = new AcceptSlotsDialog(app, request, onFinish);
      dialog.open();
      return dialog;
    },
    pruneHistory: (request, onFinish) => {
      const dialog = new PruneHistoryDialog(app, request, onFinish);
      dialog.open();
      return dialog;
    },
  };
}
