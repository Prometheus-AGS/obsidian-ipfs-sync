import { escapeForDisplay } from "../sync/path-policy";
import { publishedText } from "./first-pull-dialog-model";
import type { ConfirmView } from "./pull-confirm-model";
import { RESTORE_COPY as COPY, RESTORE_LIST_COPY as LIST } from "./pull-dialog-copy";

/**
 * The Restore action's two screens as data: the list of versions to choose from and the confirmation. Names in the
 * list are not authenticated (the node chooses file names), so the list marks what was read and what was not, and
 * the confirmation shows only values the runner took from the entry's authenticated manifest.
 */

/** One row of the list, as the runner builds it from the history folder. */
export interface RestoreEntry {
  /** The history file name, or a label derived from it. Node-supplied: shown as text only. */
  readonly name: string;
  /** From the name (prefixed form) or the decrypted manifest. Undefined for a legacy name. */
  readonly sequence: number | undefined;
  /** Authenticated details, present only when the entry was decrypted (files up to 8 MiB). */
  readonly detail: { readonly publishedAt: string; readonly device: string } | undefined;
  /** True for a legacy `<cid>.enc` name: it has no order. */
  readonly legacy: boolean;
}

export function describeRestoreEntry(entry: RestoreEntry): string {
  const name = escapeForDisplay(entry.name);
  if (entry.legacy) return `${name} (${LIST.legacy})`;
  const sequence = entry.sequence === undefined ? name : `Sequence ${entry.sequence}`;
  if (entry.detail === undefined) return `${sequence} (${LIST.unchecked})`;
  return `${sequence}, ${publishedText(entry.detail.publishedAt)}, device ${escapeForDisplay(entry.detail.device)}`;
}

export interface RestoreListState {
  readonly chosen: number | undefined;
  readonly canContinue: boolean;
  readonly needText: string;
}

export interface RestoreListModel {
  readonly labels: readonly string[];
  state(): RestoreListState;
  choose(index: number): RestoreListState;
  /** The chosen row, or undefined when none is chosen. */
  take(): number | undefined;
}

export function createRestoreListModel(entries: readonly RestoreEntry[]): RestoreListModel {
  const labels = entries.map(describeRestoreEntry);
  let chosen: number | undefined;
  const state = (): RestoreListState => ({ chosen, canContinue: chosen !== undefined, needText: chosen === undefined && entries.length > 0 ? LIST.needChoice : "" });
  return {
    labels,
    state,
    choose: (index) => {
      chosen = Number.isInteger(index) && index >= 0 && index < entries.length ? index : undefined;
      return state();
    },
    take: () => chosen,
  };
}

/** What the runner passes to the confirmation, after it loaded and authenticated the chosen entry. */
export interface RestoreRequest {
  readonly authenticated: { readonly sequence: number; readonly publishedAt: string; readonly device: string };
  /** The highest sequence this device has recorded, when known. */
  readonly highestSequence: number | undefined;
  /** Set when the list label said another sequence than the entry holds. Confirm then stays disabled. */
  readonly labelMismatch: { readonly listedSequence: number } | undefined;
}

export function restoreView(request: RestoreRequest): ConfirmView {
  const { authenticated, highestSequence, labelMismatch } = request;
  return {
    id: "ipfs-sync-restore",
    title: COPY.title,
    intro: COPY.intro,
    facts: [
      { label: COPY.sequenceName, value: String(authenticated.sequence) },
      { label: COPY.publishedName, value: publishedText(authenticated.publishedAt) },
      { label: COPY.deviceName, value: escapeForDisplay(authenticated.device) },
      ...(highestSequence === undefined ? [] : [{ label: COPY.recordedName, value: String(highestSequence) }]),
    ],
    factsNote: COPY.authenticatedNote,
    lists: [{ heading: COPY.whatHeading, items: COPY.what }],
    ...(labelMismatch === undefined ? {} : { blocker: COPY.mismatch(labelMismatch.listedSequence, authenticated.sequence) }),
    confirmLabel: COPY.confirm,
    cancelLabel: COPY.cancel,
    confirmStyle: "warning",
  };
}
