import type { MassRemovalCounts } from "../sync/publish-refusals";
import { MASS_REMOVAL_COPY as COPY } from "./encryption-copy";

/**
 * The rules of the mass-removal confirmation as plain data. The engine stopped a manual publish that would remove every remaining entry or more
 * than half of them; this dialog asks whether that is meant. It reports counts only (no path reaches it). Cancel is the default focus, a yes comes
 * only from an explicit confirm, and the answer is taken once. An unattended timer publish never opens it: it shows `massRemovalTimerNotice`.
 */

export interface MassRemovalView {
  readonly title: string;
  readonly summary: string;
  /** The statement that an emptied or unmounted vault looks the same. */
  readonly lookAlike: string;
  readonly nothingWritten: string;
  /** Present when the exclusion list also removes entries; those are not counted. */
  readonly exclusionNote: string | undefined;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** The control that takes the initial focus, so an accidental Enter cancels. */
  readonly initialFocus: "cancel";
  /** `warning`: the label, not the colour, says what the button does. */
  readonly confirmStyle: "warning";
}

export interface MassRemovalState {
  readonly canConfirm: boolean;
  /** An answer has been taken (a yes or a no). */
  readonly decided: boolean;
}

export interface MassRemovalModel {
  view(): MassRemovalView;
  state(): MassRemovalState;
  /** Take the yes. True at most once, and never after a cancel. */
  confirm(): boolean;
  /** Take the no. */
  cancel(): void;
}

const entries = (count: number): string => (count === 1 ? "1 entry" : `${count} entries`);

function summaryOf({ removing, remaining }: MassRemovalCounts): string {
  const what = removing < remaining ? `${removing} of ${remaining} entries` : remaining === 1 ? "the only entry" : `all ${remaining} entries`;
  return `This publish would remove ${what} from the published vault.`;
}

function exclusionNoteOf(count: number): string | undefined {
  if (count === 0) return undefined;
  const more = count === 1 ? "1 more entry is removed" : `${count} more entries are removed`;
  return `${more} because the exclusion list now matches them. They are not counted above.`;
}

export function createMassRemovalModel(counts: MassRemovalCounts): MassRemovalModel {
  let decided = false;
  const view: MassRemovalView = {
    title: counts.removing >= counts.remaining ? COPY.titleAll : COPY.title,
    summary: summaryOf(counts),
    lookAlike: COPY.lookAlike,
    nothingWritten: COPY.nothingWritten,
    exclusionNote: exclusionNoteOf(counts.exclusionDriven),
    confirmLabel: `Remove ${entries(counts.removing)} and publish`,
    cancelLabel: COPY.cancel,
    initialFocus: "cancel",
    confirmStyle: "warning",
  };
  return {
    view: () => view,
    state: () => ({ canConfirm: !decided, decided }),
    confirm: () => {
      if (decided) return false;
      decided = true;
      return true;
    },
    cancel: () => {
      decided = true;
    },
  };
}

/** The notice for a timer publish that the engine stopped for mass removal. No dialog opens for it. */
export function massRemovalTimerNotice(counts: MassRemovalCounts): string {
  return (
    `The automatic publish stopped: it would remove ${counts.removing} of ${counts.remaining} entries from the published vault. Nothing was written. ` +
    "An emptied or unmounted vault folder looks the same, so check the vault folder first. Publish by hand to confirm the removal."
  );
}
