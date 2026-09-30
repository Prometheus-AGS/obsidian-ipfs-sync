import { FIXTURE_MARKER } from "../core/config";
import type { PullPhase, PullResult } from "../sync/pull";

/**
 * The text the user sees for a pull. Built from names, counts and CIDs; nothing here reads file content or
 * credentials. Paths appear in notices (the user needs them) and are never stored.
 */

const PREFIX = "IPFS Sync:";
const SHOWN = 3;

export const FIXTURE_ONLY_PULL_NOTICE =
  `${PREFIX} pull is off for this vault. Pull of a real vault is not available in this build: it refuses encrypted roots, and decrypting pull arrives in a later release. ` +
  `Only fixture vaults (a ${FIXTURE_MARKER} file at the vault root holding the text "fixture" or "pulled-fixture") or vaults with no files outside .obsidian/ and .ipfs-sync/ can be pulled into. ` +
  "Nothing was sent to the node and no file changed.";

export const ENCRYPTED_PULL_NOTICE =
  `${PREFIX} this vault on the node is encrypted, and pulling encrypted vaults is not supported yet (it arrives with the next change). ` +
  "Nothing was written to your vault. This device now remembers that the vault is encrypted, so plaintext reads of it are refused.";

export const PLAINTEXT_V1_OFF_NOTICE =
  `${PREFIX} pull refused: the node serves a plaintext (version 1) manifest, which anyone who can write to the node can forge, ` +
  "and reading it is switched off. Nothing was written to your vault.";

export const PLAINTEXT_DOWNGRADE_NOTICE =
  `${PREFIX} pull refused: an encrypted vault was seen here before and the node now serves a plaintext manifest. That may be a downgrade ` +
  "attack. Nothing was written to your vault.";

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
  const reason = error instanceof Error ? error.message : "unknown error";
  return `${PREFIX} pull failed: ${reason}`;
}

/** What a running pull is doing, for the in-place notice and the status bar. */
export function phaseText(phase: PullPhase, fetched: number): string {
  switch (phase.kind) {
    case "resolving":
      return `${PREFIX} pull: resolving name...`;
    case "reading-manifest":
      return `${PREFIX} pull: reading manifest...`;
    case "comparing":
      return `${PREFIX} pull: comparing ${phase.files} files...`;
    case "fetching":
      return `${PREFIX} pull: fetching ${fetched} of ${phase.total}...`;
  }
}

export const STARTING_PULL_TEXT = `${PREFIX} pull: starting...`;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, SHOWN).join(", ");
  return items.length > SHOWN ? `${shown} and ${items.length - SHOWN} more` : shown;
}

/** Whether the run changed or endangered anything: catch-up stays silent when it did not. */
export function isEventful(result: PullResult): boolean {
  return result.fetched > 0 || result.conflicted > 0 || result.failed > 0;
}

/**
 * The final notice. It says `complete` only when no file failed; otherwise it says `incomplete` and names the
 * first failed paths with their reasons, so it cannot be read as a success.
 */
export function pullResultNotice(result: PullResult, warnings: readonly string[]): string {
  const state = result.failed === 0 ? "complete" : "incomplete";
  const lines = [
    `${PREFIX} Pull ${state}: ${result.fetched} fetched, ${result.unchanged} unchanged, ${result.conflicted} conflicts, ${result.failed} failed, ${result.remoteDeleted} remote deletions kept`,
  ];
  if (result.conflicts.length > 0) lines.push(`Conflict copies: ${listed(result.conflicts.map((c) => c.conflictPath))}`);
  if (result.failures.length > 0) lines.push(`Failed: ${listed(result.failures.map((f) => `${f.path} (${f.reason})`))}`);
  for (const warning of warnings) lines.push(`Note: ${warning}`);
  return lines.join("\n");
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** The status bar after a pull: the same counts, compactly, and the local time. */
export function pullStatusText(result: PullResult, at: Date): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const failed = result.failed > 0 ? `, ${result.failed} failed` : "";
  return `${PREFIX} pull ${time}: ${result.fetched} fetched, ${result.conflicted} conflicts${failed}`;
}
