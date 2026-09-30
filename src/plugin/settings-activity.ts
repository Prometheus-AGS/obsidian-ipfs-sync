import type { PullTargetPreview } from "./pull-target";
import type { PublishSummary, PullSummary } from "./settings-model";

/**
 * Text for the settings tab's "name that will be pulled" line and "Last activity" view. Pure: the tab renders
 * these strings and holds no wording of its own. Nothing here is a path or a secret: the stored summaries carry
 * counts, root CIDs and a time only.
 */

export interface ActivityView {
  /** False when no such run has been recorded on this device. */
  readonly exists: boolean;
  readonly text: string;
}

const SHORT_CID = 16;
const pad = (value: number): string => String(value).padStart(2, "0");

/** ` Root <cid>` with a closing full stop only when the CID is shown whole (a shortened one ends in an ellipsis). */
function rootSentence(cid: string): string {
  return cid.length > SHORT_CID ? ` Root ${cid.slice(0, SHORT_CID)}…` : ` Root ${cid}.`;
}

/** `YYYY-MM-DD HH:MM` in the person's local time, or the stored text when it is not a date. */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function describePullTarget(preview: PullTargetPreview): string {
  switch (preview.kind) {
    case "entered":
      return `The name that will be pulled: ${preview.name} (from the pull name setting).`;
    case "owned-key":
      return `The name that will be pulled: ${preview.name} (the ID of your publication key).`;
    case "owned-key-from-node":
      return (
        `The name that will be pulled: the ID of the key "${preview.keyName}", looked up on the node when you pull ` +
        `(${preview.recorded} owned key IDs are recorded here).`
      );
    case "none":
      return "No name is available to pull from. Enter a pull name, or publish once so your publication key exists.";
  }
}

export function describePull(summary: PullSummary | undefined): ActivityView {
  if (summary === undefined) return { exists: false, text: "No pull has run on this device yet." };
  const counts = `${summary.fetched} fetched, ${summary.unchanged} unchanged, ${summary.conflicts} conflicts, ${summary.failed} failed, ${summary.remoteDeleted} remote deletions kept`;
  return { exists: true, text: `${formatLocalTime(summary.at)}: ${counts}.${rootSentence(summary.rootCid)}` };
}

export function describePublish(summary: PublishSummary | undefined): ActivityView {
  if (summary === undefined) return { exists: false, text: "No publish has run on this device yet." };
  const skipped = summary.skipped > 0 ? `, ${summary.skipped} skipped (over the read cap)` : "";
  const root = summary.rootCid === undefined ? " Nothing was published: no change." : rootSentence(summary.rootCid);
  return { exists: true, text: `${formatLocalTime(summary.at)}: ${summary.written} written, ${summary.removed} removed${skipped}.${root}` };
}
