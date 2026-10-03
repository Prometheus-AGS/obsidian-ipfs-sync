import type { AuthScheme } from "../core/config";
import type { NodeKey } from "../kubo";
import { DEFAULT_EXCLUSIONS, effectiveExclusions, excludesHash } from "../sync/exclusions";
import { createKeyAdoption, type KeyAdoption } from "./key-adoption";
import { previewPullTarget, type PullTargetPreview } from "./pull-target";
import { describePublish, describePull, describePullTarget, type ActivityView } from "./settings-activity";
import {
  errorKeysOf,
  groupOf,
  parseGroup,
  valuesFrom,
  visibleAuthFields,
  type EditableFieldId,
  type FieldId,
  type FieldValues,
} from "./settings-fields";
import { AUTH_SCHEMES, type PluginSettings } from "./settings-model";
import type { SettingsStore } from "./settings-store";
import { exclusionsWithConfigDir, validateSettings, type FieldError, type SettingsField } from "./settings-to-config";

export { ADOPT_CONSEQUENCES, type AdoptState, type KeyStateView } from "./key-adoption";
export { errorKeyOf, FIELD_IDS, PULL_FIELD_IDS, SECRET_FIELDS, type EditableFieldId, type FieldId, type PullFieldId } from "./settings-fields";
export type { ActivityView } from "./settings-activity";

/**
 * Everything the settings tab shows and does, as plain data and functions: field text, per-field errors,
 * scheme-dependent fields, the exclusions editor, key state and the adopt flow. The tab renders this and
 * forwards input; it holds no rules of its own.
 */

type Errors = Readonly<Partial<Record<SettingsField, string>>>;

export interface SettingsViewState {
  /** The text of every field, including edits that could not be saved. */
  readonly values: FieldValues;
  /** Inline errors, one per field (all auth controls share `auth`). Empty when everything saved is valid. */
  readonly errors: Errors;
  /** Findings that do not block saving, such as an expired JWT. */
  readonly warnings: readonly string[];
  /** True while a scheme switch or auth edit is incomplete and has not been saved. */
  readonly authPending: boolean;
  /** The "name that will be pulled" line, from what is stored: the entered name, the owned key's ID, or a note that none is available. */
  readonly pullTarget: string;
  /** The same preview as data: the tab shows which of the two target kinds is in effect (an `explicit-root` gets the advanced-input note, copy in task 5.2). */
  readonly pullTargetPreview: PullTargetPreview;
  /** The pull ceiling in megabytes as stored, and the text of the field including an edit that could not be saved. */
  readonly pullCeilingMb: number;
  readonly pullCeilingText: string;
  /** The last pull and the last publish on this device: time, counts and root CID, or a note that none has run. */
  readonly lastPull: ActivityView;
  readonly lastPublish: ActivityView;
}

export interface EditResult {
  readonly saved: boolean;
  readonly state: SettingsViewState;
}

export interface ExclusionsView {
  readonly defaults: readonly string[];
  readonly user: readonly string[];
  /** Defaults plus the user's additions, sorted: exactly what the engine applies. */
  readonly effective: readonly string[];
  readonly excludesHash: string;
}

export interface ExclusionChange {
  readonly ok: boolean;
  /** Why nothing changed, when `ok` is false. */
  readonly message?: string;
}

export interface SettingsViewModelDeps {
  readonly store: SettingsStore;
  readonly listNodeKeys: () => Promise<readonly NodeKey[]>;
  readonly now?: () => Date;
  /** `vault.configDir`: added to the effective exclusions when it is not `.obsidian`, so the list and hash shown are what the engine applies. */
  readonly configDir?: string;
  /** Called after a change was saved (the plugin re-arms its timer from it). */
  readonly onSaved?: (settings: PluginSettings) => void;
}

export interface SettingsViewModel {
  state(): SettingsViewState;
  /** The auth controls to show for the scheme currently in the draft. */
  visibleAuthFields(): readonly FieldId[];
  /** Change one field. A valid change is saved; an invalid one leaves the saved value alone and reports the error. */
  edit(field: EditableFieldId, text: string): Promise<EditResult>;
  /** Change the pull ceiling (64 to 8192 megabytes): `edit("pullConfirmAboveMb", text)`. A valid value is saved, an invalid one reports the error under `pullConfirmAboveMb`. */
  editPullCeiling(text: string): Promise<EditResult>;
  /** Drop unsaved edits and errors: the text goes back to what is stored. */
  reset(): SettingsViewState;
  exclusions(): Promise<ExclusionsView>;
  addExclusion(entry: string): Promise<ExclusionChange>;
  removeExclusion(entry: string): Promise<ExclusionChange>;
  readonly keys: KeyAdoption;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function normalizeEntry(entry: string): string {
  return entry.trim().replaceAll("\\", "/");
}

/** `current` without the errors of `keys`, plus `found`. */
function replaceErrors(current: Errors, keys: readonly SettingsField[], found: readonly FieldError[]): Errors {
  const next: Partial<Record<SettingsField, string>> = {};
  for (const key of Object.keys(current) as SettingsField[]) {
    if (!keys.includes(key)) next[key] = current[key];
  }
  for (const error of found) next[error.field] = error.message;
  return next;
}

function isAuthScheme(text: string): text is AuthScheme {
  return AUTH_SCHEMES.some((scheme) => scheme === text);
}

export function createSettingsViewModel(deps: SettingsViewModelDeps): SettingsViewModel {
  const now = deps.now ?? ((): Date => new Date());
  let values: FieldValues = valuesFrom(deps.store.get());
  let errors: Errors = {};
  let authPending = false;

  /** Errors and warnings of what is stored now. Errors are shown only for fields the user edited or that are stored invalid. */
  const stored = () => validateSettings(deps.store.get(), now());
  const snapshot = (): SettingsViewState => {
    const settings = deps.store.get();
    return {
      values,
      errors,
      warnings: stored().warnings,
      authPending,
      pullTarget: describePullTarget(previewPullTarget(settings)),
      pullTargetPreview: previewPullTarget(settings),
      pullCeilingMb: settings.pullConfirmAboveMb,
      pullCeilingText: values.pullConfirmAboveMb,
      lastPull: describePull(settings.lastPull),
      lastPublish: describePublish(settings.lastPublish),
    };
  };

  async function edit(field: EditableFieldId, text: string): Promise<EditResult> {
    if (field === "authScheme" && !isAuthScheme(text)) return { saved: false, state: snapshot() };
    values = { ...values, [field]: text };
    const group = groupOf(field);
    const keys = errorKeysOf(group);
    const parsed = parseGroup(group, values);
    if (parsed.kind === "incomplete") {
      authPending = true;
      errors = replaceErrors(errors, keys, []);
      return { saved: false, state: snapshot() };
    }
    if (parsed.kind === "invalid") {
      errors = replaceErrors(errors, keys, [parsed.error]);
      return { saved: false, state: snapshot() };
    }
    const candidate = parsed.apply(deps.store.get());
    const blocking = validateSettings(candidate, now()).errors.filter((e) => keys.includes(e.field));
    if (blocking.length > 0) {
      errors = replaceErrors(errors, keys, blocking);
      return { saved: false, state: snapshot() };
    }
    // Apply the group to the latest stored settings, so a concurrent change elsewhere is kept.
    const saved = await deps.store.update(parsed.apply);
    errors = replaceErrors(errors, keys, []);
    if (group === "auth") authPending = false;
    deps.onSaved?.(saved);
    return { saved: true, state: snapshot() };
  }

  async function changeExclusions(change: (current: readonly string[]) => readonly string[]): Promise<void> {
    const saved = await deps.store.update((s) => ({ ...s, userExclusions: change(s.userExclusions) }));
    deps.onSaved?.(saved);
  }

  return {
    state: snapshot,
    visibleAuthFields: () => (isAuthScheme(values.authScheme) ? visibleAuthFields(values.authScheme) : []),
    edit,
    editPullCeiling: (text) => edit("pullConfirmAboveMb", text),
    reset: () => {
      values = valuesFrom(deps.store.get());
      errors = {};
      authPending = false;
      return snapshot();
    },

    exclusions: async () => {
      const user = deps.store.get().userExclusions;
      const applied = exclusionsWithConfigDir(user, deps.configDir);
      return { defaults: DEFAULT_EXCLUSIONS, user, effective: effectiveExclusions(applied), excludesHash: await excludesHash(applied) };
    },

    addExclusion: async (raw) => {
      const entry = normalizeEntry(raw);
      if (entry === "" || CONTROL_CHARS.test(entry)) return { ok: false, message: "Enter a vault-relative path such as drafts/ or notes/private.md." };
      const known = effectiveExclusions(deps.store.get().userExclusions);
      if (known.includes(entry)) return { ok: false, message: `"${entry}" is already excluded.` };
      await changeExclusions((current) => [...current, entry]);
      return { ok: true };
    },

    removeExclusion: async (raw) => {
      const entry = normalizeEntry(raw);
      if (DEFAULT_EXCLUSIONS.includes(entry)) return { ok: false, message: `"${entry}" is a default exclusion and cannot be removed.` };
      if (!deps.store.get().userExclusions.includes(entry)) return { ok: false, message: `"${entry}" is not in your additions.` };
      await changeExclusions((current) => current.filter((item) => item !== entry));
      return { ok: true };
    },

    keys: createKeyAdoption({ store: deps.store, listNodeKeys: deps.listNodeKeys }),
  };
}
