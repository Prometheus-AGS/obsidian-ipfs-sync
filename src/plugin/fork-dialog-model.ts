import type { ConfirmView } from "./pull-confirm-model";
import { FORK_COPY as COPY } from "./pull-dialog-copy";

/** What the Resolve fork confirmation shows, as data. The action does nothing without this yes. */

export interface ForkRequest {
  /** The sequence both sides published, when the pull reports it. */
  readonly sequence: number | undefined;
}

export function forkView(request: ForkRequest): ConfirmView {
  return {
    id: "ipfs-sync-fork",
    title: COPY.title,
    intro: COPY.intro,
    facts: request.sequence === undefined ? [] : [{ label: COPY.sequenceName, value: String(request.sequence) }],
    lists: [{ heading: COPY.whatHeading, items: COPY.what }],
    confirmLabel: COPY.confirm,
    cancelLabel: COPY.cancel,
    confirmStyle: "warning",
  };
}
