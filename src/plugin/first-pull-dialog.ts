import type { App } from "obsidian";
import type { FirstPullDetails } from "../sync/encrypted-pull";
import { firstPullView } from "./first-pull-dialog-model";
import { askConfirm } from "./pull-confirm-dialog";

/**
 * The first-pull confirmation. Confirm stays disabled until the acknowledgement is ticked. `true` means the user
 * confirmed; every other way out is `false`, and the pull then writes nothing (no file, no state, no floor entry,
 * no key slot copy). Passed to the pull as its `confirmFirstPull` port.
 */
export function confirmFirstPull(app: App, details: FirstPullDetails): Promise<boolean> {
  return askConfirm(app, firstPullView(details));
}
