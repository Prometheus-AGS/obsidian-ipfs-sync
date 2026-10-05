/**
 * Every visible word of the encryption dialogs and the Encryption section of the settings tab. Direct
 * statements, no marketing language. Kept apart from the rendering so copy changes touch no layout code.
 *
 * The passphrase alphabet is never described as free of look-alike characters: S and 5, Z and 2, G and 6,
 * I and L remain. The copy says so and tells the reader to copy the passphrase rather than retype it.
 */

export const UNLOCKING_TEXT = "Unlocking. Keep the app in the foreground until this finishes.";
export const CREATING_TEXT = "Creating the vault and unlocking it. Keep the app in the foreground until this finishes.";

export const SETUP_COPY = {
  title: "Create an encrypted vault",
  intro: "This vault is encrypted with a passphrase generated here. You cannot choose your own. Save it before you continue.",
  passphraseName: "Your passphrase",
  groupsLabel: "Generated passphrase, 5 groups of 5 characters",
  caseNote: "Letters are not case-sensitive. Hyphens and spaces are ignored when you enter it.",
  lookalikeNote: "Some characters look alike (S and 5, Z and 2, G and 6, I and L). Copy the passphrase exactly instead of retyping it from memory.",
  managerNote: "Save it in a password manager now. It is shown once, here.",
  consequenceTitle: "No recovery",
  consequence:
    "If you lose this passphrase, the data in this vault is lost permanently. There is no recovery mechanism, and no one can reset it for you.",
  reentryName: "Enter the passphrase again",
  reentryDesc: "Type or paste it to confirm that you saved it.",
  revealLabel: "Show what I type",
  acknowledgeLabel: "I understand that if I lose this passphrase, my data is permanently lost and cannot be recovered.",
  cancel: "Cancel",
  create: "Create vault",
  requirementsIntro: "To enable Create vault:",
  needReentry: "enter the passphrase again exactly as shown",
  needAcknowledgement: "tick the box about losing the passphrase",
  mismatch: "The passphrase does not match the one shown above.",
  incomplete: "Not complete yet. The passphrase has 25 characters.",
  createFailed: "The vault was not created",
} as const;

export const UNLOCK_COPY = {
  title: "Unlock the vault",
  intro: "Enter the passphrase for this vault. It is asked once per session and is kept in memory only.",
  fieldName: "Passphrase",
  fieldDesc: "Letters are not case-sensitive. Hyphens and spaces are ignored.",
  revealLabel: "Show what I type",
  cancel: "Cancel",
  unlock: "Unlock",
  unlockFailed: "The vault was not unlocked",
  empty: "Enter the passphrase.",
  wrongLength: "That is not 25 characters. A passphrase has 25 letters and digits, shown in 5 groups of 5.",
  wrongCharacters: "That contains characters a passphrase does not use. It uses the letters A to Z and the digits 2 to 7.",
  checkFailed: "Probable typo: the last two characters do not match the rest. Nothing was sent to the node.",
} as const;

export const ABANDON_PHRASE = "abandon";

export const ABANDON_COPY = {
  title: "Abandon this vault?",
  intro: "Use this only if the node has lost the key slots file for this vault.",
  consequences: [
    "This device keeps a backup of its local key-slot copy, sync state, publish journal and key-management journal (moved, not deleted).",
    "Nothing on the node is changed or deleted.",
    "A pending key-slot rewrap or history prune is dropped from this device. Its write to the node is not withdrawn: a rewritten key-slot file may stay in the shared tree. On the command line, ipfs-sync keys discard withdraws that key-slot file only for a rewrap that has not yet published; for a prune, or a rewrap that has published, it forgets the record and takes nothing back (removed history files stay removed; a published key-slot file stays). Run it before you abandon if you want that withdrawal, because abandon drops the record that would let it; the plugin has no discard action.",
    "You can then create a new vault in an empty MFS root.",
  ],
  confirmName: `Type "${ABANDON_PHRASE}" to confirm`,
  confirmDesc: "The button stays disabled until the word matches.",
  cancel: "Cancel",
  confirm: "Abandon vault",
  failed: "The vault was not abandoned",
} as const;

export const ENCRYPTION_SECTION = "Encryption";

export const ENCRYPTION_COPY = {
  stateName: "Vault encryption",
  notSetUp: "Not set up.",
  notSetUpDesc: "Run Publish to open the setup dialog. Nothing is published until a vault exists.",
  locked: "Locked.",
  lockedDesc: "The passphrase is not in memory. The next publish asks for it. Automatic publishing is skipped while the vault is locked.",
  unlocked: "Unlocked.",
  unlockedDesc: "The key is held in memory until you lock the vault or the plugin unloads.",
  lockName: "Lock the vault",
  lockDesc: "Discards the key from memory. The next publish asks for the passphrase again.",
  lockUnavailable: "Nothing to lock: the vault is not unlocked.",
  lockButton: "Lock now",
  abandonName: "Abandon this vault",
  abandonDesc:
    "Use this only if the node lost the key slots file for this vault. This device keeps a backup of its local key-slot copy, sync state, publish journal and key-management journal, and nothing on the node is changed. You confirm by typing a word first.",
  abandonButton: "Abandon...",
  setUpButton: "Set up...",
  unlockButton: "Unlock...",
  recordName: "Pull record",
  noRecord: "This device has no pull record for this vault yet.",
  recordUnreadable: "The pull record could not be read. The state file for this vault may be damaged.",
  unfinishedKept: "your next publish keeps them as the node has them, and publishes nothing from this device for them.",
  slotCostName: "Key-derivation cost",
  slotCostUnknown: "This device does not know the cost of its key slot yet.",
  slotCostRecordUnreadable: "The cost of this device's key slot could not be read.",
} as const;

/** The key-management rows of the Encryption section: what each action does, in a sentence, before its button is pressed. */
export const KEY_ACTIONS_COPY = {
  changePassphrase: {
    name: "Change the passphrase",
    desc: "Generates a new passphrase and wraps the same vault key with it. The old passphrase and every old copy of the key-slot file keep working: this does not revoke anything. Other devices must accept the new key slots.",
    button: "Change passphrase...",
  },
  increaseCost: {
    name: "Increase the key-derivation cost",
    desc: "Wraps the same vault key in a new slot that is slower to guess. The old slot in earlier roots keeps its old, cheaper cost, and phones unlock more slowly. Other devices must accept the new key slots.",
    button: "Increase cost...",
  },
  acceptSlots: {
    name: "Accept changed key slots",
    desc: "Use this after another device changed the passphrase or the cost. You need the passphrase that device set. It replaces this device's key-slot copy only.",
    button: "Accept key slots...",
  },
  pruneHistory: {
    name: "Prune history",
    desc: "Removes the oldest history files from the node's working tree and keeps at least the newest 20. Earlier published roots stay pinned and fetchable. You see what would be removed, as counts, and confirm it before anything is removed.",
    button: "Prune history...",
  },
} as const;

/** Words shared by the three key dialogs (change passphrase, increase cost, accept key slots). */
export const KEY_DIALOG_COPY = {
  currentName: "Current passphrase",
  currentDesc: "The passphrase that opens this vault now. Letters are not case-sensitive. Hyphens and spaces are ignored.",
  revealLabel: "Show what I type",
  cancel: "Cancel",
  close: "Close",
  statementsHeading: "What this does and does not do",
  requirementsIntro: "To enable the button:",
  needCurrent: "enter the current passphrase",
  stoppedHeading: "Not finished",
  stopped:
    "This did not finish, and the node may already have changed. Keep your old passphrase and do not rely on a new one until a test unlock has passed. Close this dialog and check the Encryption section of the settings.",
  keepOpenWorking: "Working. Keep the app in the foreground until this finishes.",
  otherDevices:
    "Every other device keeps refusing to pull or publish until it accepts the changed key slots with the new passphrase (Accept changed key slots in the Encryption settings, or ipfs-sync keys accept-slots).",
} as const;

export const CHANGE_PASSPHRASE_COPY = {
  title: "Change the passphrase",
  intro: "A new passphrase is generated here and wraps the same vault key. The vault content is not re-encrypted. You cannot choose your own.",
  passphraseName: "Your new passphrase",
  groupsLabel: "New generated passphrase, 5 groups of 5 characters",
  noRecoveryTitle: "No recovery",
  noRecovery:
    "The new passphrase is the only one that opens this vault's current key-slot file. If you lose it, the vault as it stands cannot be opened on any device, and there is no recovery mechanism.",
  reentryName: "Enter the new passphrase again",
  reentryDesc: "Type or paste it to confirm that you saved it.",
  acknowledgeLabel:
    "I understand that the old passphrase and every old copy of the key-slot file still open this vault, and that I cannot recover the new passphrase if I lose it.",
  confirm: "Change passphrase",
  needReentry: "enter the new passphrase again exactly as shown",
  needAcknowledgement: "tick the box about the old passphrase and about losing the new one",
  failed: "The passphrase was not changed",
  working: "Changing the passphrase. Four key derivations run, one after the other. Keep the app in the foreground until this finishes.",
  doneTitle: "Passphrase changed",
  next: "This device now uses the new key slots. Every other device must accept them with the new passphrase before it can pull or publish. Keep the new passphrase until then.",
} as const;

export const TEST_UNLOCK_COPY = {
  heading: "Test unlock",
  verified:
    "Passed. The new passphrase opened the key-slot file now served by the node, and the manifest of that root authenticated under the key it gave.",
  notRun: "Not run. The key-slot file on the node was checked against the one this device wrote instead.",
} as const;

export const INCREASE_COST_COPY = {
  title: "Increase the key-derivation cost",
  intro: "The same vault key is wrapped in a new slot that costs more to guess, under the same passphrase. The vault content is not re-encrypted.",
  choiceName: "New cost",
  choiceDesc: "Only these costs are offered. Nothing above the allowed maximum can be chosen.",
  currentLabel: "Keep the current cost",
  currentName: "Current cost",
  lowerNote: "lower than the current cost",
  higherNote: "higher than the current cost",
  needChoice: "choose a cost that differs from the current one",
  needDowngrade: "tick the box about the lower cost",
  needAcknowledgement: "tick the box about the old passphrase and the old slot",
  downgradeLabel: "I accept a lower cost, which makes the new slot cheaper to guess.",
  acknowledgeLabel: "I understand that the old passphrase and every old copy of the key-slot file, including the old cheaper slot in earlier roots, still open this vault.",
  aboveDefault:
    "A cost above the default is unlocked only on a device that can ask you to approve it. A phone may be too slow or too small for it, and a command-line run without a terminal refuses it.",
  confirm: "Increase cost",
  confirmLower: "Change cost",
  failed: "The cost was not changed",
  working: "Changing the cost. Four key derivations run, one after the other, and the last ones are slower at the new cost. Keep the app in the foreground until this finishes.",
  doneTitle: "Cost changed",
  next: "This device now uses the new key slots. Every other device must accept them with the same passphrase before it can pull or publish.",
} as const;

export const ACCEPT_SLOTS_COPY = {
  title: "Accept changed key slots",
  intro:
    "Another device changed the passphrase or the cost, so this device's key-slot copy no longer matches the node. Enter the passphrase of the changed key slots: the one the other device set, not your old one.",
  checkButton: "Check key slots",
  acceptButton: "Accept key slots",
  checkFailed: "The key slots were not accepted",
  checking: "Checking the key slots on the node. Keep the app in the foreground until this finishes.",
  accepting: "Replacing this device's key-slot copy.",
  reviewHeading: "What will change",
  sameCostName: "Cost of both key slots",
  currentCostName: "Cost of this device's copy",
  incomingCostName: "Cost of the incoming key slots",
  downgradeLabel: "Replace my copy with the cheaper key slots.",
  needDowngrade: "tick the box about the cheaper key slots",
  nothingToAccept: "This device already holds these key slots. Nothing needs to change.",
  doneTitle: "Key slots accepted",
  done: "This device's key-slot copy and its recorded hash were replaced. Nothing was pulled: run a pull next.",
  unchanged: "Nothing needed to change on this device.",
  dropsPending:
    "A key-management operation left unfinished on this device (a rewrap or a prune) is dropped by this action, and a key-slot file this device wrote into the shared tree on the node is taken back out. To finish it instead, run the same change again.",
} as const;

/**
 * The prune-history dialog (mvp-07b task 2.5). The statements about what a prune removes, keeps and checks are the engine's own words
 * (`src/sync/prune-history-text.ts`, shared with the command line); only the form and the outcomes are worded here. "20" is the engine's
 * `HISTORY_KEEP_FLOOR`; the model test pins the two together.
 */
export const PRUNE_HISTORY_COPY = {
  title: "Prune history",
  intro:
    "Removes the oldest history files from the node's working tree so that the number you choose stay. First you see what would be removed, as counts. Nothing is removed until you press the remove button.",
  keepName: "History files to keep",
  keepDesc: "The newest files stay. At least the newest 20 always stay, so a smaller number is raised to 20.",
  keepInvalid: "Enter a whole number of 1 or more.",
  needKeep: "enter how many history files to keep",
  previewButton: "Show what would be removed",
  working: "Opening the vault with one key derivation, then reading the history on the node. Nothing is written. Keep the app in the foreground until this finishes.",
  removing: "Removing the history files and publishing the result. Keep the app in the foreground until this finishes.",
  reviewHeading: "What would be removed",
  failed: "History was not pruned",
  stoppedAtPreview: "Nothing was removed and nothing was written. Close this dialog; the reason is above.",
  stoppedAtRemove:
    "This did not finish, and the node may already have changed: some history files may be removed, and a prune may be pending on this device, which pauses publish and pull. Run ipfs-sync prune-history from a terminal to finish it, or check the Encryption section of the settings.",
  doneTitle: "History pruned",
  unchanged: "Nothing needed to be removed. Nothing was changed.",
} as const;

/** The cost-confirm dialog (mvp-07b task 2.4): a key slot above the default cost is unlocked only after an explicit yes. */
export const COST_CONFIRM_COPY = {
  title: "Unlock a key slot that costs more than the default?",
  effects:
    "Unlocking uses that much memory and time on this device before anything else happens. A phone or a device with little free memory can be slow, or the app can be stopped while it works.",
  nothingWritten: "Nothing has been written. Cancel stops the action and the vault stays locked.",
  blockedNothing: "There is no cost to confirm, so this cannot be approved. Close this dialog; nothing was changed.",
  blockedInvalid: "The cost could not be read as a number, so this cannot be approved. Close this dialog; nothing was changed.",
  confirm: "Unlock at this cost",
  cancel: "Cancel",
} as const;

export const MASS_REMOVAL_COPY = {
  title: "Remove most of the vault?",
  titleAll: "Remove every entry?",
  lookAlike:
    "An emptied or unmounted vault folder looks exactly like this. Check that the vault folder is mounted and holds your files before you continue.",
  nothingWritten: "Nothing has been written to the node yet. Cancel keeps the published vault as it is.",
  cancel: "Cancel",
} as const;
