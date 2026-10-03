import type { PullStageResult } from "../sync/encrypted-pull-stage";
import type { PullReport } from "./pull-notices";
import { unfinishedCount } from "./pull-notices";
import type { PullSummary } from "./settings-model";

/**
 * The decrypting pull's result as what the notices, the status bar and the stored summary need: counts and vault paths,
 * nothing else. No secret and no file content is in a `PullStageResult` to begin with; this keeps it that way.
 */

function modeOf(verdict: PullStageResult["verdict"]): PullReport["mode"] {
  if (verdict === "restore") return "restore";
  return verdict === "fork-resolution" ? "fork-resolution" : "pull";
}

export function reportOf(result: PullStageResult): PullReport {
  const { settlement } = result;
  return {
    mode: modeOf(result.verdict),
    sequence: result.sequence,
    fetched: settlement.fetched.length,
    unchanged: settlement.unchanged.length,
    conflictCopies: settlement.conflicts.map((conflict) => conflict.conflictPath),
    integrityFailed: settlement.integrityFailed,
    unfetched: settlement.unfetched,
    skippedExpected: settlement.skipped.filter((skip) => skip.severity === "expected").map((skip) => skip.path),
    skippedUnsafe: settlement.skipped.filter((skip) => skip.severity === "unsafe").map((skip) => skip.path),
    remoteDeleted: settlement.remoteDeleted.length,
  };
}

const SET_ASIDE_TEXT = "an unfinished publish of this device was set aside because the node already holds a newer version";

/** The notes a pull adds to its notice: the exclusion-list difference, the fork's ancestor note, a publish set aside. */
export function warningsOf(result: PullStageResult): readonly string[] {
  const warnings: string[] = [];
  if (result.exclusionWarning !== undefined) warnings.push(result.exclusionWarning);
  if (result.forkResolution?.note !== undefined) warnings.push(result.forkResolution.note);
  if (result.journalSetAside !== undefined) warnings.push(`${SET_ASIDE_TEXT} (sequence ${result.journalSetAside.sequence}).`);
  return warnings;
}

/** The stored summary: counts, the two root CIDs and a time. No path and no secret. */
export function summaryOfReport(report: PullReport, roots: { readonly rootCid: string; readonly manifestCid: string }, at: Date): PullSummary {
  return {
    at: at.toISOString(),
    rootCid: roots.rootCid,
    manifestCid: roots.manifestCid,
    fetched: report.fetched,
    unchanged: report.unchanged,
    conflicts: report.conflictCopies.length,
    failed: unfinishedCount(report),
    remoteDeleted: report.remoteDeleted,
  };
}
