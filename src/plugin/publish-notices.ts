import { ConfigError, FIXTURE_MARKER } from "../core/config";
import type { PublishResult } from "../sync/publish";
import { OwnedKeyNotRecordedError } from "../sync/publish-errors";

/**
 * The text the user sees. Every message is built from names, counts and CIDs; error messages of the
 * shared layers never carry credentials, so nothing here can leak a secret.
 */

const PREFIX = "IPFS Sync:";
const SHORT_CID = 16;

export const FIXTURE_ONLY_NOTICE =
  `${PREFIX} publishing is off for this vault. Encryption is not available yet, so only synthetic fixture vaults ` +
  `(marked with a ${FIXTURE_MARKER} file at the vault root) can be published. Nothing was sent to the node.`;

function shortCid(cid: string): string {
  return cid.length > SHORT_CID ? `${cid.slice(0, SHORT_CID)}...` : cid;
}

const SKIPPED_SHOWN = 3;

/** Files the read cap kept out of the publish: a count, the first reasons (each names its file), and where to raise the cap. */
function skippedText(result: PublishResult): string {
  if (result.skipped.length === 0) return "";
  const shown = result.skipped.slice(0, SKIPPED_SHOWN).map((file) => file.reason).join("; ");
  const more = result.skipped.length > SKIPPED_SHOWN ? ` and ${result.skipped.length - SKIPPED_SHOWN} more` : "";
  return ` ${result.skipped.length} skipped (raise the read cap in the plugin settings): ${shown}${more}.`;
}

export function publishedNotice(result: PublishResult): string {
  const counts = `${result.written} written, ${result.removed} removed`;
  const root = result.rootCid === undefined ? "" : ` (root ${shortCid(result.rootCid)})`;
  const key = result.keyCreated ? ` Created publication key ${result.keyId}.` : "";
  return `${PREFIX} published: ${counts}${root}.${key}${skippedText(result)}`;
}

export function unchangedNotice(result: PublishResult): string {
  return `${PREFIX} nothing changed: ${result.written} written, ${result.removed} removed. The published name was not touched.${skippedText(result)}`;
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

/** A failure that is not a named refusal. Names the reason and makes no claim of partial success. */
export function failedNotice(error: unknown): string {
  const reason = error instanceof Error ? error.message : "unknown error";
  return `${PREFIX} publish failed: ${reason}`;
}
