import type { FirstPullDetails } from "../sync/encrypted-pull";
import { FIRST_PULL_COPY as COPY, PUBLISH_REQUIREMENTS } from "./pull-dialog-copy";
import type { ConfirmFact, ConfirmView } from "./pull-confirm-model";
import { formatLocalTime } from "./settings-activity";

/**
 * What the first-pull confirmation shows, as data. The values (sequence, date, device) are authenticated and chosen by
 * whoever holds the vault key; `device` and the path summary come from the node and are escaped for control characters
 * by the pull. The dialog sets every value as text, so markup in a device name is shown, not built.
 *
 * The statements are the pull's own (`details.statements`), shown as given; this file adds the publishing
 * requirements and the acknowledgement that gates Confirm.
 */

export function publishedText(publishedAt: string): string {
  const local = formatLocalTime(publishedAt);
  return local === publishedAt ? publishedAt : `${publishedAt} (${local} local time)`;
}

function skippedFact(details: FirstPullDetails): ConfirmFact | undefined {
  if (details.pathsRefused === 0) return undefined;
  const names = details.pathsSummary === undefined ? "" : `: ${details.pathsSummary}`;
  return { label: COPY.skippedName, value: `${details.pathsRefused}${names}` };
}

export function firstPullView(details: FirstPullDetails): ConfirmView {
  const skipped = skippedFact(details);
  return {
    id: "ipfs-sync-first-pull",
    title: COPY.title,
    intro: COPY.intro,
    facts: [
      { label: COPY.sequenceName, value: String(details.sequence) },
      { label: COPY.publishedName, value: publishedText(details.publishedAt) },
      { label: COPY.deviceName, value: details.device },
      { label: COPY.filesName, value: String(details.fileCount) },
      ...(skipped === undefined ? [] : [skipped]),
      ...(details.replacedLocalFiles > 0 ? [{ label: COPY.replacedName, value: `${details.replacedLocalFiles} ${COPY.replacedNote}` }] : []),
    ],
    lists: [
      { heading: COPY.statementsHeading, items: details.statements },
      { heading: COPY.requirementsHeading, items: PUBLISH_REQUIREMENTS, ordered: true, after: COPY.requirementsNote },
    ],
    acknowledgement: { label: COPY.acknowledge, needText: COPY.needAcknowledge },
    confirmLabel: COPY.confirm,
    cancelLabel: COPY.cancel,
    confirmStyle: "cta",
  };
}
