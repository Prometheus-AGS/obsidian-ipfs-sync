import type { App } from "obsidian";
import { forkView, type ForkRequest } from "./fork-dialog-model";
import { askConfirm } from "./pull-confirm-dialog";

/**
 * The Resolve fork confirmation. It states that the node's version takes each file where the two differ, that this
 * device's text is kept as conflict copies and that nothing is merged automatically. `false` for every way out
 * other than Confirm; the action does nothing then.
 */
export function confirmResolveFork(app: App, request: ForkRequest): Promise<boolean> {
  return askConfirm(app, forkView(request));
}
