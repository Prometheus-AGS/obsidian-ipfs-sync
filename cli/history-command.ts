import { stat } from "node:fs/promises";
import type { EnvMap } from "../src/core/config";
import type { HistoryRecord } from "../src/core/store/types";
import { EXIT_CHECK_FAILED, EXIT_OK, type CliIo } from "./io";
import { historyStoreDirectory } from "./store/location";
import { openHistoryStore } from "./store/pglite-store";

/**
 * `ipfs-sync history [--limit <n>]` (mvp-08 task 4.1). Prints this device's own
 * operation log (publishes, pulls, conflict copies), newest first, one line per
 * record. It is read-only and fully local: no config file is read, no kubo
 * client is created, no request can be sent, no passphrase is asked. The
 * distinction from `prune-history` is load-bearing and the help text states it:
 * prune-history removes history files from the NODE's working tree and
 * publishes the result (it mutates the node); history only reads the
 * device-local database under `history/` in the per-user state directory.
 *
 * No database yet (a fresh device, a state directory that cannot be resolved)
 * is not an error: the empty line is printed and the exit code is 0. A
 * database that exists but refuses to open — above all an unknown schema
 * version, which the store contract refuses fail-closed — IS an error: it is
 * reported and the exit code is 1. The read-only claim is kept by not opening
 * PGlite at all when the directory is absent, so a listing run creates nothing
 * on a fresh device.
 */

export const HISTORY_EMPTY_LINE = "no sync operations recorded on this device";
export const HISTORY_DEFAULT_LIMIT = 20;

export interface HistoryContext {
  readonly io: CliIo;
  readonly env: EnvMap;
  /** `--limit <n>`; undefined is the default (20), 0 means all records. */
  readonly limit: number | undefined;
}

/** One line per record: ISO timestamp, kind (padded), root CID, then the kind's counts and duration (the conflict pair for a conflict). */
function lineOf(record: HistoryRecord): string {
  const head = `${new Date(record.occurredAtMs).toISOString()}  ${record.kind.padEnd("conflict".length)}  ${record.rootCid}  `;
  if (record.kind === "publish") return `${head}written ${record.written}, removed ${record.removed}, ${record.durationMs} ms`;
  if (record.kind === "pull") {
    return (
      `${head}fetched ${record.fetched}, unchanged ${record.unchanged}, conflicted ${record.conflicted}, failed ${record.failed}, ` +
      `removed remotely ${record.remoteDeleted}, kept locally ${record.locallyModified}, ${record.durationMs} ms`
    );
  }
  return `${head}local sha256 ${record.localSha256}, remote sha256 ${record.remoteSha256}`;
}

export async function runHistory(ctx: HistoryContext): Promise<number> {
  let directory: string;
  try {
    directory = historyStoreDirectory(ctx.env);
  } catch {
    // No per-user state directory means no database and no history; it is not an error.
    ctx.io.out(HISTORY_EMPTY_LINE);
    return EXIT_OK;
  }
  const present = await stat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!present) {
    ctx.io.out(HISTORY_EMPTY_LINE);
    return EXIT_OK;
  }
  try {
    const store = await openHistoryStore({ directory });
    try {
      const records = await store.list(ctx.limit ?? HISTORY_DEFAULT_LIMIT);
      if (records.length === 0) {
        ctx.io.out(HISTORY_EMPTY_LINE);
        return EXIT_OK;
      }
      for (const record of records) ctx.io.out(lineOf(record));
      return EXIT_OK;
    } finally {
      await store.close();
    }
  } catch (error) {
    // The database exists, so "no history" cannot be claimed: an unknown schema version or an unreadable database is a real failure.
    ctx.io.err(`ipfs-sync: history failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_CHECK_FAILED;
  }
}
