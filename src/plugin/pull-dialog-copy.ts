/**
 * Every visible word of the pull dialogs: first pull, restore (list and confirmation), fork resolution and large pull.
 * Direct statements, no marketing language. Kept apart from the rendering so copy changes touch no layout code.
 *
 * Nothing here is node-supplied. Sequence, date, device and path names reach the dialogs as values and are set as text.
 */

export const CANCEL = "Cancel";

/** The three things a second device needs before it can publish (design decision 15). Pulling itself needs none of them. */
export const PUBLISH_REQUIREMENTS = [
  "Use the same MFS root and the same publication key name as the device that created this vault.",
  "Adopt the owned publication key in the plugin settings (Owned keys), so this device may publish under that name.",
  "Pull before you publish, so that the first publish builds on what the node already holds.",
] as const;

export const FIRST_PULL_COPY = {
  title: "Pull this vault for the first time?",
  intro:
    "This device has no record of this vault. Check what the node is serving before any file is written. " +
    "Cancel writes nothing: no file, no record of this vault and no copy of the key slots.",
  sequenceName: "Sequence",
  publishedName: "Published",
  deviceName: "Device",
  filesName: "Files",
  /** The directory the pull writes into, shown when the pull names one. */
  destinationName: "Destination",
  skippedName: "Paths that will be skipped",
  replacedName: "Local files that will be replaced",
  /** The count is a preview made before the stage, and the stage plans again, so it is a lower bound. */
  replacedLowerBound: "at least",
  replacedNote: "(a dated copy of each is kept)",
  statementsHeading: "What this means",
  requirementsHeading: "To publish from this device later you also need to:",
  requirementsNote: "Pulling needs none of these. It only reads from the node.",
  acknowledge: "I understand that the sequence, date and device above come from whoever holds the vault key, and that nothing here can confirm them.",
  needAcknowledge: "To enable Pull this vault: tick the box about the values above.",
  cancel: CANCEL,
  confirm: "Pull this vault",
} as const;

export const RESTORE_LIST_COPY = {
  title: "Restore an older version",
  intro:
    "Choose a version to restore. The list shows the newest entries by file name, which the node can choose freely. " +
    "The sequence and date are checked again from the entry itself before you confirm anything.",
  groupLabel: "Versions on the node",
  empty: "The node has no earlier versions to list.",
  unchecked: "details not read, entry is large",
  legacy: "older file name, order unknown",
  continue: "Continue",
  cancel: CANCEL,
  needChoice: "To enable Continue: choose a version.",
} as const;

export const RESTORE_COPY = {
  title: "Restore an older version?",
  intro: "This vault will take the files of an older version. Check that this is the version you mean.",
  sequenceName: "Sequence",
  publishedName: "Published",
  deviceName: "Device",
  recordedName: "Highest sequence recorded on this device",
  authenticatedNote: "Sequence, date and device come from the entry itself after it was checked with the vault key, not from its file name.",
  whatHeading: "What happens",
  what: [
    "Files from this older version are written to the vault. A file that differs is replaced.",
    "A file you edited locally is kept first as a dated conflict copy.",
    "Files created after this version are not removed.",
    "The highest sequence recorded on this device is not lowered.",
    "Your next publish makes the result a new version, one sequence above the node's.",
  ],
  mismatch: (listed: number, found: number): string =>
    `This history entry does not match its name: it was listed as sequence ${listed} but it holds sequence ${found}. Nothing was changed.`,
  cancel: CANCEL,
  confirm: "Restore this version",
} as const;

export const FORK_COPY = {
  title: "Resolve the fork?",
  intro:
    "Two devices published the same sequence with different content. That usually means they published at about the same time. " +
    "It is not by itself a sign of an attack.",
  sequenceName: "Sequence",
  whatHeading: "What happens",
  what: [
    "Where this device and the node differ, the node's version takes the file.",
    "This device's text is kept as a dated conflict copy next to it.",
    "Nothing is merged automatically. Look through the conflict copies afterwards.",
    "Your next publish is one sequence above the node's and includes the files that exist only on this device.",
  ],
  cancel: CANCEL,
  confirm: "Resolve fork",
} as const;

export const LARGE_PULL_COPY = {
  title: "Pull a large vault?",
  intro: "This pull is larger than the size you set for asking first. It may take a long time and use a lot of data.",
  sizeName: "To fetch",
  limitName: "Your limit",
  whatHeading: "If you cancel",
  what: [
    "Nothing is fetched.",
    "This device stays out of date until you pull again. Your next publish keeps those files as the node has them.",
    "You can change the limit under Pull in the plugin settings.",
  ],
  cancel: CANCEL,
  confirm: (size: string): string => `Fetch ${size}`,
} as const;
