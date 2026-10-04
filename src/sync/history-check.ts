import { assertMfsMutationPath } from "../core/config";
import { KuboResponseTooLargeError, type MfsEntry } from "../kubo";
import { compareHistoryNames, isHistoryName, parseHistoryName } from "./history-names";
import { listIfPresent, type NodeReadClient } from "./node-reader";
import type { TransferClient } from "./encrypted-transfer";
import { historyFull, historyJunk, repairDeclined, repairRefused } from "./publish-refusals";
import type { ConfirmRepair } from "./repair";

/**
 * The pre-flight look at `manifests/` (review-3 W-03). Every publish adds one history file there and nothing ever removes
 * one, and the read-back lists the folder through a client that refuses more than 2,000 entries. Left to the read-back,
 * the refusal would come after the journal, `manifest.enc` and the history file were written, and repeat forever. So the
 * folder is listed before anything is written: a warning at 1,500 entries, a refusal at 1,999 that names
 * `ipfs-sync prune-history`, and a refusal for any name that is not a history file (`<16-digit sequence>-<cid>.enc` or the legacy `<cid>.enc`, a file). Junk can be
 * removed by this tool only through `--repair` and only after the user confirms.
 */

export const HISTORY_WARN_AT = 1_500;
export const HISTORY_REFUSE_AT = 1_999;
const NAMES_SHOWN = 3;

export interface HistoryView {
  /** The listing, empty when `manifests/` is absent or too large to list. */
  readonly entries: readonly MfsEntry[];
  /** The listing was refused by the client cap (more than 2,000 entries or 1 MiB). */
  readonly overflow: boolean;
}

export async function listHistory(client: NodeReadClient, mfsRoot: string): Promise<HistoryView> {
  try {
    return { entries: (await listIfPresent(client, `${mfsRoot}/manifests`)) ?? [], overflow: false };
  } catch (error) {
    if (error instanceof KuboResponseTooLargeError) return { entries: [], overflow: true };
    throw error;
  }
}

/** Names in `manifests/` that are not history files. */
export function junkNames(view: HistoryView): readonly string[] {
  return view.entries.filter((entry) => entry.type !== "file" || !isHistoryName(entry.name)).map((entry) => entry.name).sort();
}

/** The history entries, oldest first: legacy names before every prefixed name, then by sequence. Entries that are not history files are left out. */
export function sortHistory(view: HistoryView): readonly MfsEntry[] {
  const parsed = view.entries.flatMap((entry) => {
    const name = entry.type === "file" ? parseHistoryName(entry.name) : undefined;
    return name === undefined ? [] : [{ entry, name }];
  });
  return parsed.sort((a, b) => compareHistoryNames(a.name, b.name)).map((item) => item.entry);
}

/** Refuse a folder that is too full to publish into; return a warning text for one that is getting there. */
export function assessHistoryCount(view: HistoryView): string | undefined {
  if (view.overflow || view.entries.length >= HISTORY_REFUSE_AT) throw historyFull(view.overflow ? undefined : view.entries.length);
  if (view.entries.length >= HISTORY_WARN_AT) {
    return `manifests/ on the node holds ${view.entries.length} history files; publishing stops at ${HISTORY_REFUSE_AT}. Remove old ones with \`ipfs-sync prune-history <vault> --keep <n>\` or with Prune history in the Encryption section of the plugin settings, or plan a new MFS root.`;
  }
  return undefined;
}

function shown(names: readonly string[]): string {
  const listed = names.slice(0, NAMES_SHOWN).map((name) => JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}...` : name));
  return `${listed.join(", ")}${names.length > NAMES_SHOWN ? ` and ${names.length - NAMES_SHOWN} more` : ""}`;
}

export interface JunkRemoval {
  readonly client: Pick<TransferClient, "filesRm">;
  readonly mfsRoot: string;
  readonly repair: boolean;
  readonly confirm: ConfirmRepair | undefined;
  readonly beforeWrite: () => void;
}

/**
 * Junk in `manifests/` stops a publish. With `--repair` and a yes from the user the tool removes each junk name, one path
 * segment under `<mfsRoot>/manifests/`, non-recursively, and never anything else; without both it refuses and says what to do.
 */
export async function clearJunk(view: HistoryView, ctx: JunkRemoval): Promise<void> {
  const junk = junkNames(view);
  if (junk.length === 0) return;
  if (!ctx.repair) throw historyJunk(shown(junk), false);
  if (ctx.confirm === undefined) throw repairRefused("removing entries from manifests/ needs a confirmation and this run cannot ask for one");
  const warning = `manifests/ on the node holds entries that are not history files (${shown(junk)}). They will be removed from the node, one by one, and nothing else.`;
  if (!(await ctx.confirm(warning))) throw repairDeclined();
  for (const name of junk) {
    if (name === "" || name.includes("/") || name === "." || name === "..") throw historyJunk(shown([name]), true);
    ctx.beforeWrite();
    await ctx.client.filesRm(assertMfsMutationPath(`${ctx.mfsRoot}/manifests/${name}`));
  }
}
