import type { App } from "obsidian";
import { largePullView, type LargePullRequest } from "./large-pull-dialog-model";
import { askConfirm } from "./pull-confirm-dialog";

/**
 * The large-pull confirmation, asked before more than the configured ceiling is fetched. `true` fetches; every
 * other way out is a no, and then nothing is fetched.
 */
export function confirmLargePull(app: App, request: LargePullRequest): Promise<boolean> {
  return askConfirm(app, largePullView(request));
}
