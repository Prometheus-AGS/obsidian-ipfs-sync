import type { ConfirmView } from "./pull-confirm-model";
import { LARGE_PULL_COPY as COPY } from "./pull-dialog-copy";

/** What the large-pull confirmation shows, as data. A no means nothing is fetched. */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** What the runner passes: the bytes it would fetch, the file count and the user's ceiling in megabytes. */
export interface LargePullRequest {
  readonly totalBytes: number;
  readonly fileCount: number;
  readonly ceilingMb: number;
}

/** `512 MB`, `1.5 GB`: binary units, the same unit as the read-cap and ceiling settings. Rounded up so the figure is never an understatement. */
export function formatSize(bytes: number): string {
  if (bytes >= GB) return `${trim(Math.ceil((bytes / GB) * 10) / 10)} GB`;
  return `${Math.max(1, Math.ceil(bytes / MB))} MB`;
}

const trim = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

export function largePullView(request: LargePullRequest): ConfirmView {
  const size = formatSize(request.totalBytes);
  const files = request.fileCount === 1 ? "1 file" : `${request.fileCount} files`;
  return {
    id: "ipfs-sync-large-pull",
    title: COPY.title,
    intro: COPY.intro,
    facts: [
      { label: COPY.sizeName, value: `${size} in ${files}` },
      { label: COPY.limitName, value: `${request.ceilingMb} MB` },
    ],
    lists: [{ heading: COPY.whatHeading, items: COPY.what }],
    confirmLabel: COPY.confirm(size),
    cancelLabel: COPY.cancel,
    confirmStyle: "cta",
  };
}
