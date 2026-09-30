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
    "This device keeps a backup of its local key slots copy and its sync state.",
    "Nothing on the node is changed or deleted.",
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
    "Use this only if the node lost the key slots file for this vault. This device keeps a backup of its local key slots copy and sync state, and nothing on the node is changed. You confirm by typing a word first.",
  abandonButton: "Abandon...",
  setUpButton: "Set up...",
  unlockButton: "Unlock...",
} as const;
