/**
 * Named refusals of the publish state machine (sequence rules, journal resume, repair, lock). Every message is
 * fixed text built from sequence numbers and process facts: no paths, no key material, no passphrase. None of
 * them tells the user to delete local state; where recovery exists they name the explicit action.
 */

import { ABANDON_HOW } from "./abandon-hint";

export type PublishRefusalCode =
  | "sequence-behind"
  | "sequence-ahead"
  | "sequence-fork"
  | "node-manifest-missing"
  | "node-manifest-unreadable"
  | "journal-mismatch"
  | "journal-conflict"
  | "journal-manifest-mismatch"
  | "history-conflict"
  | "repair-refused"
  | "repair-declined"
  | "lock-held"
  | "lock-unreadable"
  | "lock-lost"
  | "lock-unsupported"
  | "publication-key-changed"
  | "passphrase-required"
  | "no-vault"
  | "plaintext-root"
  | "unexpected-root-entry"
  | "large-reupload"
  | "remote-object-too-large"
  | "remote-object-invalid"
  | "root-cid-unsupported"
  | "file-changed"
  | "file-unreadable"
  | "history-full"
  | "history-junk";

export class PublishRefusedError extends Error {
  readonly code: PublishRefusalCode;

  constructor(code: PublishRefusalCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PublishRefusedError";
    this.code = code;
  }
}

const ABANDON = `abandon this vault (${ABANDON_HOW}) and publish to a new MFS root`;

export function sequenceBehind(node: number, local: number): PublishRefusedError {
  return new PublishRefusedError(
    "sequence-behind",
    `the node's manifest has sequence ${node}, older than this device's record (sequence ${local}); an older copy of the vault may have been put back on the node. ` +
      `If this device's record is the truth, run publish with --repair (it publishes at sequence ${local + 1}); otherwise ${ABANDON}.`,
  );
}

export function sequenceAhead(node: number, local: number | undefined): PublishRefusedError {
  const seen = local === undefined ? "this device has no record of a publish to this root" : `this device's record has sequence ${local}`;
  return new PublishRefusedError(
    "sequence-ahead",
    `the node's manifest has sequence ${node} and ${seen}; another device may have published, or a local record was restored from a backup. ` +
      `Run publish with --repair to continue from the node's sequence (changes made by any other publisher will be discarded), or ${ABANDON}.`,
  );
}

export function sequenceFork(sequence: number): PublishRefusedError {
  return new PublishRefusedError(
    "sequence-fork",
    `the node holds a different manifest at sequence ${sequence} than this device published; another publisher wrote to this root. The repair action does not apply; ${ABANDON}.`,
  );
}

export function nodeManifestMissing(): PublishRefusedError {
  return new PublishRefusedError(
    "node-manifest-missing",
    `this device published to this root, but the node has no manifest.enc there now; the node lost or removed it. Nothing was written. ` +
      `If the node's key-slot file is still this device's copy, run publish with --repair to write a new manifest.enc from this device's record; otherwise ${ABANDON}.`,
  );
}

export function nodeManifestUnreadable(): PublishRefusedError {
  return new PublishRefusedError(
    "node-manifest-unreadable",
    `the node's manifest.enc is present but does not authenticate with this vault's key (it may have been cut short by an interrupted write, or replaced). Nothing was written. ` +
      `If this device published to this root and the node's key-slot file is still this device's copy, run publish with --repair to write a new manifest.enc; otherwise ${ABANDON}.`,
  );
}

export function journalMismatch(what: "vault" | "key slots" | "root" | "publication key"): PublishRefusedError {
  return new PublishRefusedError(
    "journal-mismatch",
    `the record of the interrupted publish belongs to another ${what}; nothing was written. ` +
      `${what === "publication key" ? "Publish with the key name the interrupted publish used (--key), or " : ""}` +
      `${what === "publication key" ? "use" : "Use"} the abandon action for this vault (${ABANDON_HOW}), or restore the matching record.`,
  );
}

export function journalConflict(journal: number, local: number): PublishRefusedError {
  return new PublishRefusedError(
    "journal-conflict",
    `the interrupted publish was for sequence ${journal}, but this device's record is already at sequence ${local}; nothing was written. Run publish with --repair, or ${ABANDON}.`,
  );
}

export function journalOutOfStep(journal: number, node: number): PublishRefusedError {
  return new PublishRefusedError(
    "journal-conflict",
    `the interrupted publish was for sequence ${journal}, but the node's manifest is at sequence ${node}, which does not lead up to it; nothing was written. Run publish with --repair, or ${ABANDON}.`,
  );
}

export function journalManifestMismatch(sequence: number, why: "different-manifest" | "content"): PublishRefusedError {
  const reason =
    why === "different-manifest"
      ? `the node holds a different manifest at sequence ${sequence} than the interrupted publish wrote`
      : `the manifest at sequence ${sequence} on the node does not match the record of the interrupted publish`;
  return new PublishRefusedError("journal-manifest-mismatch", `${reason}; nothing was written. Run publish with --repair, or ${ABANDON}.`);
}

export function historyConflict(): PublishRefusedError {
  return new PublishRefusedError(
    "history-conflict",
    "the node already holds a different history file for this snapshot than the manifest being published; nothing more was written. " +
      `A history file is never overwritten. Change any file in the vault and publish again, or ${ABANDON}.`,
  );
}

export function repairRefused(reason: string): PublishRefusedError {
  return new PublishRefusedError("repair-refused", `--repair is not allowed here: ${reason}. The remaining option is to ${ABANDON}.`);
}

export function repairDeclined(): PublishRefusedError {
  return new PublishRefusedError("repair-declined", "--repair was not confirmed; nothing was written.");
}

export function lockHeld(description: string): PublishRefusedError {
  return new PublishRefusedError(
    "lock-held",
    `another publish is running in this vault (${description}). Wait for it to finish; if it is gone, run publish with --break-lock.`,
  );
}

export function lockUnreadable(): PublishRefusedError {
  return new PublishRefusedError(
    "lock-unreadable",
    "the publish lock file in this vault cannot be read. If no publish is running, run publish with --break-lock.",
  );
}

export function lockUnsupported(code: string): PublishRefusedError {
  return new PublishRefusedError(
    "lock-unsupported",
    `the publish lock needs hard links, and this file system refused them (${code}), as FAT volumes and some network mounts do. Publish from a vault on a file system that supports hard links.`,
  );
}

export function publicationKeyChanged(name: string): PublishRefusedError {
  return new PublishRefusedError(
    "publication-key-changed",
    `the publication key "${name}" on the node is missing, or is not the key this publish verified; nothing was published under it. Check the key on the node and the key name in the configuration.`,
  );
}

export function lockLost(): PublishRefusedError {
  return new PublishRefusedError("lock-lost", "the publish lock was taken over, removed or could not be refreshed while this publish ran; stopping so two publishes do not overlap.");
}

/** The node's snapshot did not match what was written (read-back before pinning). Not a refusal of the request, a fact about the node. */
export class ReadBackError extends Error {
  constructor(what: string) {
    super(`read-back of the snapshot failed: ${what}`);
    this.name = "ReadBackError";
  }
}

/* ---------- refusals of the encrypted publish path ---------- */

export function passphraseRequired(): PublishRefusedError {
  return new PublishRefusedError(
    "passphrase-required",
    "publishing needs the vault passphrase and none was supplied; nothing was sent to the node. Every publish is encrypted, so there is no publish without one.",
  );
}

export function noVault(): PublishRefusedError {
  return new PublishRefusedError(
    "no-vault",
    "this MFS root holds no encrypted vault yet, and publish never creates one. Create it with `ipfs-sync init` (it generates the passphrase), then publish; nothing was written.",
  );
}

export function plaintextRoot(): PublishRefusedError {
  return new PublishRefusedError(
    "plaintext-root",
    "this MFS root holds a plaintext publication from an earlier release, and an encrypted vault must not be mixed into it. Publish to a new MFS root (--mfs-root); nothing was written. " +
      "The old plaintext stays public and pinned on the node.",
  );
}

/** Node-supplied names in a message are cut and JSON-escaped, so a hostile name cannot forge terminal output. */
function shown(names: readonly string[]): string {
  const limit = 3;
  const listed = names.slice(0, limit).map((name) => JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}...` : name));
  return `${listed.join(", ")}${names.length > limit ? ` and ${names.length - limit} more` : ""}`;
}

export function unexpectedRootEntries(names: readonly string[]): PublishRefusedError {
  return new PublishRefusedError(
    "unexpected-root-entry",
    `the MFS root holds entries that are not part of a vault (${shown(names)}); nothing was written. ` +
      "This tool never removes anything outside current/. Remove them from the node yourself if they are yours, or publish to a new MFS root.",
  );
}

export function largeReupload(bytes: number): PublishRefusedError {
  const mib = Math.ceil(bytes / (1024 * 1024));
  return new PublishRefusedError(
    "large-reupload",
    `the node no longer holds ${mib} MiB of this vault's files as recorded, and they would have to be uploaded again; that needs an explicit go-ahead (--allow-full-reupload, or a yes at the prompt). Nothing was written.`,
  );
}

export function remoteObjectTooLarge(what: string, limit: number): PublishRefusedError {
  return new PublishRefusedError(
    "remote-object-too-large",
    `${what} on the node is larger than the limit of ${limit} bytes and was not read; nothing was written.`,
  );
}

export function remoteObjectInvalid(what: string): PublishRefusedError {
  return new PublishRefusedError("remote-object-invalid", `${what} on the node is not what it should be (wrong kind or size); nothing was written.`);
}

export function rootCidNotV1(): PublishRefusedError {
  return new PublishRefusedError(
    "root-cid-unsupported",
    "the node reports the vault tree with a CIDv0; only CIDv1 base32 is supported for the manifest. Nothing was published.",
  );
}

export function fileChangedWhileReading(): PublishRefusedError {
  return new PublishRefusedError(
    "file-changed",
    "a file changed while it was being read for upload; nothing was published. Run publish again once the vault is quiet.",
  );
}


/** A vault file could not be read for upload. The host's own message can carry a path, so it stays as the cause and out of the text. */
export function fileUnreadable(blob: string, cause: unknown): PublishRefusedError {
  return new PublishRefusedError("file-unreadable", `a file could not be read for upload (blob ${blob}); nothing was published`, { cause });
}

export function historyFull(count: number | undefined): PublishRefusedError {
  const held = count === undefined ? "more than 2,000" : String(count);
  return new PublishRefusedError(
    "history-full",
    `manifests/ on the node already holds ${held} history files and this tool reads it back before every publish, so it stops at 1,999. Nothing was written. ` +
      "Archive old history with `ipfs-sync prune-history` (not available in this build), or publish to a new MFS root.",
  );
}

export function historyJunk(names: string, unsafe: boolean): PublishRefusedError {
  return new PublishRefusedError(
    "history-junk",
    unsafe
      ? `manifests/ holds an entry with a name this tool will not remove (${names}); remove it on the node yourself. Nothing was written.`
      : `manifests/ on the node holds entries that are not history files (${names}); nothing was written. ` +
          "Remove them on the node, or run publish with --repair to have this tool remove them after you confirm.",
  );
}

export function prefixFolderTooLarge(folder: string): PublishRefusedError {
  return new PublishRefusedError(
    "remote-object-too-large",
    `the folder current/${folder}/ on the node holds more than 2,000 entries, which this tool refuses to list. A vault spreads over 1,024 such folders, so something else put them there; remove the extra entries on the node. Nothing was written.`,
  );
}
