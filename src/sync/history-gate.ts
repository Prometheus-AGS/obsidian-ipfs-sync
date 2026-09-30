import { assessHistoryCount, clearJunk, junkNames, listHistory } from "./history-check";
import type { PublishSession } from "./publish-session";
import type { PublishClient, PublishOptions } from "./publish-types";

/**
 * The pre-flight of `manifests/` for one publish: junk is refused (or, with `--repair` and a yes, removed and the folder
 * listed again), then the count is checked. Returns the warnings to show. Nothing has been uploaded when this refuses.
 */
export async function assertHistoryReady(client: PublishClient, options: PublishOptions, session: PublishSession): Promise<readonly string[]> {
  let history = await session.inspector.history();
  if (junkNames(history).length > 0) {
    await clearJunk(history, { client, mfsRoot: session.target.mfsRoot, repair: options.repair === true, confirm: options.confirmRepair, beforeWrite: session.beforeWrite });
    history = await listHistory(client, session.target.mfsRoot);
  }
  const warning = assessHistoryCount(history);
  return warning === undefined ? [] : [warning];
}
