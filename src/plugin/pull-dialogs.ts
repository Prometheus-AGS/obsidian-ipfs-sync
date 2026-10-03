import type { App } from "obsidian";
import type { FirstPullDetails } from "../sync/encrypted-pull";
import { confirmFirstPull } from "./first-pull-dialog";
import { confirmResolveFork } from "./fork-dialog";
import type { ForkRequest } from "./fork-dialog-model";
import { confirmLargePull } from "./large-pull-dialog";
import type { LargePullRequest } from "./large-pull-dialog-model";
import { chooseRestoreEntry, confirmRestore } from "./restore-dialog";
import type { RestoreEntry, RestoreRequest } from "./restore-dialog-model";

/**
 * The confirmations of a pull, as the runner sees them. Each answers `true` only after the user confirmed; every other
 * way out is a no, and a no writes and fetches nothing. A run that is unattended gets none of them.
 */
export interface PullDialogs {
  confirmFirstPull(details: FirstPullDetails): Promise<boolean>;
  chooseRestoreEntry(entries: readonly RestoreEntry[]): Promise<number | undefined>;
  confirmRestore(request: RestoreRequest): Promise<boolean>;
  confirmResolveFork(request: ForkRequest): Promise<boolean>;
  confirmLargePull(request: LargePullRequest): Promise<boolean>;
}

/** The real dialogs (`first-pull-dialog.ts`, `restore-dialog.ts`, `fork-dialog.ts`, `large-pull-dialog.ts`), opened over the app. */
export function obsidianPullDialogs(app: App): PullDialogs {
  return {
    confirmFirstPull: (details) => confirmFirstPull(app, details),
    chooseRestoreEntry: (entries) => chooseRestoreEntry(app, entries),
    confirmRestore: (request) => confirmRestore(app, request),
    confirmResolveFork: (request) => confirmResolveFork(app, request),
    confirmLargePull: (request) => confirmLargePull(app, request),
  };
}
