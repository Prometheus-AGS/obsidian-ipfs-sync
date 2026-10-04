import type { PullStop } from "../sync/encrypted-pull";
import { escapeForDisplay } from "../sync/path-policy";
import { PLAINTEXT_UNSUPPORTED_MESSAGE } from "../sync/pull-errors";

/**
 * The text the user sees for a pull. Built from names, counts and CIDs; nothing here reads file content or
 * credentials. Paths appear in notices (the user needs them) and are never stored.
 */

const PREFIX = "IPFS Sync:";
const SHOWN = 3;

/** The root lists a `manifest.json` and holds no key slots: a plaintext publication, which no code path of this version reads. */
export const PLAINTEXT_UNSUPPORTED_NOTICE = `${PREFIX} pull refused: ${PLAINTEXT_UNSUPPORTED_MESSAGE}`;

export function unsafeDestinationNotice(reason: string): string {
  return `${PREFIX} pull refused: ${reason}. Nothing was sent to the node and no file changed.`;
}

export function noTargetNotice(detail: string): string {
  return `${PREFIX} pull stopped before fetching anything: ${detail}`;
}

export function invalidSettingsPullNotice(reason: string): string {
  return `${PREFIX} pull refused: ${reason}. Check the plugin settings.`;
}

export function pullFailedNotice(error: unknown): string {
  // The message can carry text the node supplied (an HTTP error body): control sequences must not reach a Notice.
  const reason = error instanceof Error ? escapeForDisplay(error.message) : "unknown error";
  return `${PREFIX} pull failed: ${reason}`;
}

export const STARTING_PULL_TEXT = `${PREFIX} pull: starting...`;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, SHOWN).join(", ");
  return items.length > SHOWN ? `${shown} and ${items.length - SHOWN} more` : shown;
}

const pad = (value: number): string => String(value).padStart(2, "0");

// ---- the decrypting pull ---------------------------------------------------------------------------------------

/** A path with the reason it was not written. The path is a vault path (it can come from the node); the reason is fixed text from the pull. */
export interface PullFileNote {
  readonly path: string;
  readonly reason?: string;
}

/**
 * What the notice and the status bar need from a finished decrypting pull or restore: counts and vault paths, nothing
 * else. The runner (task 5.3) builds it from the pull's outcome; no secret and no file content can reach it.
 */
export interface PullReport {
  /** `restore` is a deliberate return to an older version (the Restore action); `fork-resolution` is Resolve fork. */
  readonly mode: "pull" | "restore" | "fork-resolution";
  readonly sequence: number;
  readonly fetched: number;
  readonly unchanged: number;
  /** Paths of the dated conflict copies made. */
  readonly conflictCopies: readonly string[];
  /** Files not written because they failed an integrity check. */
  readonly integrityFailed: readonly PullFileNote[];
  /** Files not fetched (declined size, gateway, write failure, not reached). */
  readonly unfetched: readonly PullFileNote[];
  /** Paths skipped because they are in the configuration folder or on this device's exclusion list. */
  readonly skippedExpected: readonly string[];
  /** Paths skipped because their shape or name is unsafe on this device. */
  readonly skippedUnsafe: readonly string[];
  readonly remoteDeleted: number;
}

/** Files the vault does not hold at the node's version: failed integrity or not fetched. */
export function unfinishedCount(report: PullReport): number {
  return report.integrityFailed.length + report.unfetched.length;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** At most three names, quoted, control characters escaped, and a count of the rest. */
function namesOf(paths: readonly string[]): string {
  return listed(paths.map((path) => `"${escapeForDisplay(path)}"`));
}

function notesOf(notes: readonly PullFileNote[]): string {
  return listed(notes.map((note) => `"${escapeForDisplay(note.path)}"${note.reason === undefined ? "" : ` (${escapeForDisplay(note.reason)})`}`));
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function headline(report: PullReport): string {
  const unfinished = unfinishedCount(report) > 0;
  const counts = `${report.fetched} fetched, ${report.unchanged} unchanged, ${plural(report.conflictCopies.length, "conflict copy", "conflict copies")}`;
  if (report.mode === "restore") return `${PREFIX} Restore ${unfinished ? "incomplete" : "finished"} (sequence ${report.sequence}): ${counts}`;
  if (report.mode === "fork-resolution") return `${PREFIX} Fork resolution ${unfinished ? "incomplete" : "finished"} (sequence ${report.sequence}): ${counts}`;
  return `${PREFIX} Pull ${unfinished ? "incomplete" : "complete"} (sequence ${report.sequence}): ${counts}`;
}

/**
 * The final notice of a decrypting pull. The headline says `incomplete` whenever a file failed or was not fetched, so
 * it cannot be read as a success; the unfinished-files line says that those files are kept as the node has them.
 * Paths are escaped, at most three are named per line, and nothing here offers to copy anything.
 */
export function encryptedPullNotice(report: PullReport, warnings: readonly string[] = []): string {
  const lines = [headline(report)];
  if (report.conflictCopies.length > 0) lines.push(`Conflict copies: ${namesOf(report.conflictCopies)}`);
  if (report.integrityFailed.length > 0) {
    lines.push(
      `${plural(report.integrityFailed.length, "file was", "files were")} not written because ${report.integrityFailed.length === 1 ? "it" : "they"} failed the integrity check. ` +
        `The vault is not up to date: ${notesOf(report.integrityFailed)}`,
    );
  }
  if (report.unfetched.length > 0) lines.push(`${plural(report.unfetched.length, "file was", "files were")} not fetched: ${notesOf(report.unfetched)}`);
  const unfinished = unfinishedCount(report);
  if (unfinished > 0) {
    lines.push(
      `${plural(unfinished, "file is", "files are")} unfinished on this device. Your next publish keeps ${unfinished === 1 ? "it" : "them"} as the node has ${unfinished === 1 ? "it" : "them"}, ` +
        "and does not publish anything from this device for them. Pull again to retry.",
    );
  }
  if (report.skippedExpected.length > 0) {
    lines.push(`${plural(report.skippedExpected.length, "path", "paths")} skipped by this device's exclusion list: ${namesOf(report.skippedExpected)}`);
  }
  if (report.skippedUnsafe.length > 0) {
    lines.push(`${plural(report.skippedUnsafe.length, "path", "paths")} skipped as unsafe on this device: ${namesOf(report.skippedUnsafe)}`);
  }
  if (report.remoteDeleted > 0) lines.push(`${plural(report.remoteDeleted, "remote deletion", "remote deletions")} kept: local files are never deleted by a pull`);
  if (report.mode === "restore") {
    lines.push("Files created after this version were not removed. The recorded highest sequence is unchanged, and your next publish makes this a new version.");
  }
  for (const warning of warnings) lines.push(`Note: ${escapeForDisplay(warning)}`);
  return lines.join("\n");
}

/** The status bar after a decrypting pull: the same counts, compactly, and the local time. */
export function encryptedPullStatusText(report: PullReport, at: Date): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const unfinished = unfinishedCount(report);
  const tail = unfinished > 0 ? `, ${unfinished} unfinished` : "";
  return `${PREFIX} pull ${time}: ${report.fetched} fetched, ${report.conflictCopies.length} conflicts${tail}`;
}

/** Whether the run changed or endangered anything: catch-up stays silent when it did not. */
export function isEventfulReport(report: PullReport): boolean {
  return report.fetched > 0 || report.conflictCopies.length > 0 || unfinishedCount(report) > 0;
}

export interface StopNotice {
  readonly text: string;
  /** Set when the notice is followed by a button that starts the named action. Only a fork offers one. */
  readonly action: "resolve-fork" | undefined;
}

const COMMAND_LINE_HINT = " Command-line options are available in the ipfs-sync command line tool.";

const FORK_TEXT =
  `${PREFIX} pull stopped: another device published the same sequence with different content (a fork). ` +
  "That usually means two devices published at about the same time; it is not by itself a sign of an attack. " +
  "Nothing was written to your vault. Use Resolve fork to bring this device in line.";

const OLDER_TEXT =
  `${PREFIX} pull stopped: the node serves an older version than the newest this device has recorded. ` +
  "The node may be serving an old state, or may be hostile. Nothing was written to your vault.";

const FIRST_PULL_DECLINED_TEXT =
  `${PREFIX} pull cancelled. Nothing was written: no file, no record of this vault and no copy of the key slots.`;

/**
 * The notice for a pull that stopped at a check before it wrote anything (`PullStop`). The pull's messages are fixed
 * text and may name command-line options; those get a hint that the plugin has none. A plain pull never offers a
 * rollback: an older version is refused with no option, and only the Restore action goes back.
 */
export function stoppedPullNotice(stop: Pick<PullStop, "reason" | "message">): StopNotice {
  switch (stop.reason) {
    case "fork":
      return { text: FORK_TEXT, action: "resolve-fork" };
    case "older":
      return { text: OLDER_TEXT, action: undefined };
    case "first-pull-declined":
      return { text: FIRST_PULL_DECLINED_TEXT, action: undefined };
    default: {
      const hint = stop.message.includes("--") ? COMMAND_LINE_HINT : "";
      // A stop message can embed node-supplied text; it is shown escaped.
      return { text: `${PREFIX} pull stopped: ${sentence(escapeForDisplay(stop.message))}${hint} Nothing was written to your vault.`, action: undefined };
    }
  }
}

// ---- running the decrypting pull (task 5.3) -----------------------------------------------------------------------

export const UNLOCKING_PULL_TEXT = `${PREFIX} pull: unlocking. Keep the app in the foreground until this finishes.`;

/** What a running decrypting pull is doing, from the node request it is making. The count is files written so far. */
export type EncryptedPhase = "resolving" | "listing" | "key-slots" | "manifest" | "fetching";

export function encryptedPhaseText(phase: EncryptedPhase, written: number): string {
  switch (phase) {
    case "resolving":
      return `${PREFIX} pull: resolving name...`;
    case "listing":
      return `${PREFIX} pull: reading the vault root...`;
    case "key-slots":
      return `${PREFIX} pull: reading key slots...`;
    case "manifest":
      return `${PREFIX} pull: checking the manifest...`;
    case "fetching":
      return `${PREFIX} pull: fetching, ${written} written...`;
  }
}

/** A catch-up or other unattended pull never asks for the passphrase. */
export const LOCKED_PULL_NOTICE = `${PREFIX} pull needs the vault passphrase and this run could not ask for it. Nothing was written. Run Pull vault to enter it.`;

export const PULL_PASSPHRASE_CANCELLED_NOTICE = `${PREFIX} pull cancelled. Nothing was written.`;

export const RESTORE_CANCELLED_NOTICE = `${PREFIX} restore cancelled. Nothing was fetched and nothing was written.`;

export const FORK_CANCELLED_NOTICE = `${PREFIX} Resolve fork cancelled. Nothing was fetched and nothing was written.`;

export const RESTORE_NO_ENTRIES_NOTICE = `${PREFIX} restore: the node holds no version history for this vault. Nothing was written.`;

export const RESTORE_NEEDS_NAME_NOTICE =
  `${PREFIX} restore and Resolve fork work from an IPNS name. The pull name is set to an explicit root (/ipfs/...): clear it or enter a key ID first. Nothing was sent to the node.`;

/** The listed name and the authenticated manifest disagree: the history file was planted or swapped. Raised before the confirmation. */
export function restoreMismatchNotice(listedSequence: number, foundSequence: number): string {
  return (
    `${PREFIX} restore refused: the history entry listed as sequence ${listedSequence} holds sequence ${foundSequence}. ` +
    "The history entry does not match its name, so it was not used. Nothing was fetched and nothing was written."
  );
}

export const RESTORE_UNREADABLE_NOTICE =
  `${PREFIX} restore refused: the chosen history entry could not be read or does not authenticate under this vault's key. Nothing was fetched and nothing was written.`;
