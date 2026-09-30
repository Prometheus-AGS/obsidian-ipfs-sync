/** Words for the "Clear stale lock" section, command and confirmation. */

export const STALE_LOCK_SECTION = "Publish lock";

export const STALE_LOCK_COPY = {
  name: "Clear stale lock",
  desc:
    "A publish that was interrupted (the app was closed or crashed) can leave its lock file behind. The lock expires by itself 15 minutes after its last heartbeat; " +
    "until then a new publish is refused. This button clears a lock whose last heartbeat is older than 15 minutes, and is disabled otherwise. It never touches a lock a publish is still refreshing.",
  button: "Clear stale lock",
  none: "There is no publish lock.",
  held: "A publish lock is present and still fresh, so it cannot be cleared. A publish may be running: wait for it, or for 15 minutes without a heartbeat.",
  stale: "A stale publish lock is present:",
  unreadable: "A lock file is present but cannot be read, so its age is unknown. Use `ipfs-sync publish --break-lock` on a computer if no publish is running.",
  checking: "Checking the lock file.",
  title: "Clear the stale publish lock?",
  intro: "Use this only if no publish is running on any device that uses this vault folder.",
  consequences: [
    "Only the lock file is removed. No note and nothing on the node is changed.",
    "The lock is cleared only if its last heartbeat is still older than 15 minutes when you confirm.",
    "If a publish is in fact still running elsewhere, two publishes could overlap.",
  ],
  cancel: "Cancel",
  confirm: "Clear lock",
  failed: "The lock was not cleared",
  cleared: "IPFS Sync: the stale publish lock was cleared.",
  noneNotice: "IPFS Sync: there is no publish lock to clear.",
  freshNotice: "IPFS Sync: the publish lock is still fresh (a publish may be running), so it was not cleared.",
  unreadableNotice: "IPFS Sync: the lock file cannot be read, so it was not cleared. Use `ipfs-sync publish --break-lock` on a computer.",
  busyNotice: "IPFS Sync: a sync operation is running in this plugin, so the lock was not cleared.",
} as const;
