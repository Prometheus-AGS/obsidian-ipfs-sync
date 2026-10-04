import type { ConfigError } from "../core/config";
import { escapeForDisplay } from "../sync/path-policy";
import type { PublishResult } from "../sync/publish";
import { OwnedKeyNotRecordedError } from "../sync/publish-errors";
import { PublishRefusedError, type MassRemovalCounts } from "../sync/publish-refusals";
import { massRemovalTimerNotice } from "./mass-removal-dialog-model";

/**
 * The text the user sees. Every message is built from names, counts and CIDs; error messages of the
 * shared layers never carry credentials, so nothing here can leak a secret.
 */

const PREFIX = "IPFS Sync:";
const SHORT_CID = 16;

export const PASSPHRASE_REQUIRED_NOTICE =
  `${PREFIX} the vault is locked, so nothing was sent to the node. Run Publish vault again to enter the passphrase.`;

/** The auto-publish timer found the session locked. It never opens a dialog; this is shown once per session. */
export const LOCKED_TIMER_NOTICE =
  `${PREFIX} automatic publishing is paused while the vault is locked. Run Publish vault (or Unlock in the plugin settings) to enter the passphrase once for this session. Nothing was sent to the node.`;

/** The auto-publish timer found no vault on this device. Creating one takes the setup dialog, which the timer never opens. */
export const NOT_SET_UP_TIMER_NOTICE =
  `${PREFIX} automatic publishing is paused because no encrypted vault is set up on this device. Run Publish vault to create one. Nothing was sent to the node.`;

export const UNLOCK_CANCELLED_NOTICE = `${PREFIX} publish cancelled: the vault was not unlocked. Nothing was sent to the node.`;

/** An authentic manifest whose content this build does not recognise (review-3b N3-01). It is somebody's real state and is never overwritten. */
export const INCOMPATIBLE_MANIFEST_NOTICE =
  `${PREFIX} the manifest on the node was written by a newer or incompatible version of this plugin, so nothing was published or changed. Update the plugin, then publish again.`;

const CLI_ONLY_HINT = " Repair and lock removal are available in the ipfs-sync command line tool.";

function shortCid(cid: string): string {
  return cid.length > SHORT_CID ? `${cid.slice(0, SHORT_CID)}...` : cid;
}

const SKIPPED_SHOWN = 3;

/** Files the read cap kept out of the publish: a count, the first reasons (each names its file), and where to raise the cap. */
function skippedText(result: PublishResult): string {
  if (result.skipped.length === 0) return "";
  const shown = result.skipped.slice(0, SKIPPED_SHOWN).map((file) => escapeForDisplay(file.reason)).join("; ");
  const more = result.skipped.length > SKIPPED_SHOWN ? ` and ${result.skipped.length - SKIPPED_SHOWN} more` : "";
  return ` ${result.skipped.length} skipped (raise the read cap in the plugin settings): ${shown}${more}.`;
}

/** At most three quoted names, control characters escaped (a carried path comes from the node), and a count of the rest. Names only; nothing is offered for copying. */
function namesText(paths: readonly string[]): string {
  const shown = paths.slice(0, SKIPPED_SHOWN).map((path) => `"${escapeForDisplay(path)}"`).join(", ");
  return paths.length > SKIPPED_SHOWN ? `${shown} and ${paths.length - SKIPPED_SHOWN} more` : shown;
}

/**
 * Paths this publish kept unchanged or left out of the manifest: those this device could not restore (kept as the node has
 * them, nothing published from here), and carried entries dropped because this device excludes them or their path is unsafe.
 */
function pathListsText(result: PublishResult): string {
  const parts: string[] = [];
  if (result.carried.length > 0) {
    parts.push(` ${result.carried.length} not published from this device (no current copy here; kept as the node has them): ${namesText(result.carried)}.`);
  }
  if (result.dropped.length > 0) {
    parts.push(` ${result.dropped.length} dropped from the manifest (excluded on this device, or an unsafe path): ${namesText(result.dropped.map((entry) => entry.path))}.`);
  }
  return parts.join("");
}

/** Things worth saying that are not failures, for example that the history folder is nearly full. Fixed text from the engine; escaped anyway. */
function warningsText(result: PublishResult): string {
  return result.warnings.map((warning) => ` Note: ${escapeForDisplay(warning)}`).join("");
}

export function publishedNotice(result: PublishResult): string {
  const counts = `${result.written} written, ${result.removed} removed`;
  const root = result.rootCid === undefined ? "" : ` (root ${shortCid(result.rootCid)})`;
  const key = result.keyCreated ? ` Created publication key ${result.keyId}.` : "";
  return `${PREFIX} published: ${counts}${root}.${key}${skippedText(result)}${pathListsText(result)}${warningsText(result)}`;
}

export function unchangedNotice(result: PublishResult): string {
  return `${PREFIX} nothing changed: ${result.written} written, ${result.removed} removed. The published name was not touched.${skippedText(result)}${pathListsText(result)}${warningsText(result)}`;
}

export function foreignKeyNotice(keyName: string): string {
  return (
    `${PREFIX} the key "${keyName}" already exists on the node and is not recorded as yours, so nothing was published. ` +
    "Open the plugin settings to adopt it by ID, or choose another key name."
  );
}

export function keyNotRecordedNotice(error: OwnedKeyNotRecordedError): string {
  return (
    `${PREFIX} created the key "${error.keyName}" (ID ${error.keyId}) but could not save its ID, so nothing was published. ` +
    "Add this ID under Owned keys in the plugin settings, then publish again."
  );
}

export function invalidSettingsNotice(error: ConfigError): string {
  return `${PREFIX} publish refused: ${error.message}. Check the plugin settings.`;
}

/**
 * A failure that is not a named refusal. Names the reason and makes no claim of partial success. The engine's refusals
 * name command-line flags (`--repair`, `--break-lock`); the plugin has none of those, so it says where they live.
 */
export function failedNotice(error: unknown): string {
  const reason = error instanceof Error ? error.message : "unknown error";
  const hint = error instanceof PublishRefusedError && reason.includes("--") ? CLI_ONLY_HINT : "";
  return `${PREFIX} publish failed: ${reason}${hint}`;
}

/** Another publish (this vault's command-line tool, or an earlier run) holds the lock file. The timer skips silently; a manual run shows this. */
export function lockHeldNotice(error: PublishRefusedError): string {
  return `${PREFIX} ${error.message} (--break-lock is an option of the ipfs-sync command line tool.) A lock with no heartbeat for 15 minutes is replaced automatically. Nothing was sent to the node.`;
}

/** The auto-publish timer was stopped by the mass-removal guard. It never opens a dialog; the words are the dialog model's. */
export function massRemovalTimerRefusal(counts: MassRemovalCounts): string {
  return `${PREFIX} ${massRemovalTimerNotice(counts)}`;
}

/** A manual publish that the guard stopped and the person did not confirm (cancelled the dialog, or none could open). Counts only; no path. */
export function massRemovalDeclinedNotice(counts: MassRemovalCounts): string {
  return `${PREFIX} publish stopped: it would remove ${counts.removing} of ${counts.remaining} entries from the published vault and the removal was not confirmed. Nothing was written.`;
}
