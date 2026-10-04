import { describeKdfCost, exceedsDefaultCost, type KdfParams } from "../crypto";
import { COST_PRESETS } from "../sync/key-management";
import { PHONE_STATEMENT, REVOCATION_STATEMENT, SAME_PASSPHRASE_STATEMENT, costLine, derivationsStatement, downgradeQuestion } from "../sync/key-management-text";
import { INCREASE_COST_COPY as COPY, KEY_DIALOG_COPY } from "./encryption-copy";
import { costPlan, nextProgress, reasonText, relateCost, requirementsSentence, type CostRelation, type KeyActionFailure } from "./key-dialog-shared";
import { createSecretEntry, type SecretEntry, type SecretEntryState } from "./key-secret-entry";
import type { PassphraseFormatCheck } from "./unlock-dialog-model";

/**
 * The rules of the increase-cost dialog as plain data. The choices are the current cost and the presets of `COST_PRESETS`, which sit inside
 * the ceilings; there is no field for another value, and `choose` ignores any id that is not offered. A lower choice (a preset below the current
 * cost, a mixed change counts as lower) needs its own confirmation that shows both costs. The confirm control also needs the current passphrase
 * (the rewrap derives it a second time) and the acknowledgement that old passphrases and old copies keep working. The model never keeps typed text.
 */

export type CostChoiceId = "current" | "standard" | "high";
export type CostRequirement = "choice" | "downgrade" | "current" | "acknowledgement";
export type CostPhase = "form" | "working" | "done" | "stopped";

export interface CostOption {
  readonly id: CostChoiceId;
  readonly params: KdfParams;
  readonly relation: CostRelation;
  /** Names memory and iterations. */
  readonly label: string;
}

export type IncreaseCostResult = { readonly ok: true; readonly testUnlock: "verified" | "not-run" } | KeyActionFailure;

export interface IncreaseCostInit {
  /** The cost of the current slot (the weakest slot an unlock tries). */
  readonly current: KdfParams;
  readonly check: PassphraseFormatCheck;
}

export interface IncreaseCostState {
  readonly phase: CostPhase;
  readonly options: readonly CostOption[];
  readonly selected: CostOption;
  /** Static statements, in reading order. */
  readonly statements: readonly string[];
  /** The cost line, the derivations and, above the default, the warning, for the selected choice. */
  readonly selectionText: string;
  /** Asked before a lower choice; shows both costs. */
  readonly downgradeQuestion: string | undefined;
  readonly downgradeConfirmed: boolean;
  /** True when the run will pass the downgrade flag: a lower choice that was confirmed. */
  readonly allowDowngrade: boolean;
  readonly current: SecretEntryState;
  readonly acknowledged: boolean;
  readonly canConfirm: boolean;
  readonly missing: readonly CostRequirement[];
  readonly requirementsText: string;
  readonly busy: boolean;
  readonly progress: number | undefined;
  readonly failure: string | undefined;
  readonly testUnlock: "verified" | "not-run" | undefined;
}

export interface IncreaseCostModel {
  state(): IncreaseCostState;
  /** Select a choice by id. An id that is not offered changes nothing. A new choice drops the downgrade confirmation. */
  choose(id: string): IncreaseCostState;
  setDowngradeConfirmed(on: boolean): IncreaseCostState;
  setAcknowledged(on: boolean): IncreaseCostState;
  setCurrent(text: string): IncreaseCostState;
  touchCurrent(): IncreaseCostState;
  setCurrentRevealed(on: boolean): IncreaseCostState;
  begin(): boolean;
  reportProgress(fraction: number): IncreaseCostState;
  settle(result: IncreaseCostResult): IncreaseCostState;
}

const NEED: Readonly<Record<CostRequirement, string>> = {
  choice: COPY.needChoice,
  downgrade: COPY.needDowngrade,
  current: KEY_DIALOG_COPY.needCurrent,
  acknowledgement: COPY.needAcknowledgement,
};

const PRESET_NAME: Readonly<Record<Exclude<CostChoiceId, "current">, string>> = { standard: "Standard", high: "High" };

function labelFor(id: CostChoiceId, params: KdfParams, relation: CostRelation): string {
  const cost = describeKdfCost(params);
  if (id === "current") return `${COPY.currentLabel}: ${cost}`;
  const note = relation === "lower" ? ` (${COPY.lowerNote})` : relation === "higher" ? ` (${COPY.higherNote})` : "";
  return `${PRESET_NAME[id]}: ${cost}${note}`;
}

/** The current cost first, then every preset that differs from it. */
export function costOptions(current: KdfParams): readonly CostOption[] {
  const options: CostOption[] = [{ id: "current", params: current, relation: "same", label: labelFor("current", current, "same") }];
  for (const id of ["standard", "high"] as const) {
    const params = COST_PRESETS[id];
    const relation = relateCost(current, params);
    if (relation !== "same") options.push({ id, params, relation, label: labelFor(id, params, relation) });
  }
  return options;
}

export const COST_STATEMENTS: readonly string[] = [REVOCATION_STATEMENT, SAME_PASSPHRASE_STATEMENT, PHONE_STATEMENT, KEY_DIALOG_COPY.otherDevices];

export function createIncreaseCostModel(init: IncreaseCostInit): IncreaseCostModel {
  const options = costOptions(init.current);
  const entry: SecretEntry = createSecretEntry(init.check);
  let selected: CostOption = options[0] as CostOption;
  let acknowledged = false;
  let downgradeConfirmed = false;
  let phase: CostPhase = "form";
  let progress: number | undefined;
  let failure: string | undefined;
  let testUnlock: "verified" | "not-run" | undefined;

  const state = (): IncreaseCostState => {
    const current = entry.state();
    const lower = selected.relation === "lower";
    const plan = costPlan(init.current, selected.params);
    const missing: CostRequirement[] = [];
    if (selected.relation === "same") missing.push("choice");
    if (lower && !downgradeConfirmed) missing.push("downgrade");
    if (current.status !== "ok") missing.push("current");
    if (!acknowledged) missing.push("acknowledgement");
    const form = phase === "form";
    const lines = [costLine(plan), derivationsStatement(selected.params)];
    if (exceedsDefaultCost(selected.params)) lines.push(COPY.aboveDefault);
    return {
      phase,
      options,
      selected,
      statements: COST_STATEMENTS,
      selectionText: lines.join(" "),
      downgradeQuestion: lower ? downgradeQuestion(plan) : undefined,
      downgradeConfirmed,
      allowDowngrade: lower && downgradeConfirmed,
      current,
      acknowledged,
      canConfirm: form && missing.length === 0,
      missing,
      requirementsText: form ? requirementsSentence(missing.map((need) => NEED[need])) : "",
      busy: phase === "working",
      progress: phase === "working" ? progress : undefined,
      failure,
      testUnlock,
    };
  };

  return {
    state,
    choose: (id) => {
      const found = options.find((option) => option.id === id);
      if (found !== undefined && found.id !== selected.id) {
        selected = found;
        downgradeConfirmed = false;
      }
      return state();
    },
    setDowngradeConfirmed: (on) => {
      downgradeConfirmed = on && selected.relation === "lower";
      return state();
    },
    setAcknowledged: (on) => {
      acknowledged = on;
      return state();
    },
    setCurrent: (text) => {
      entry.setText(text);
      return state();
    },
    touchCurrent: () => {
      entry.touch();
      return state();
    },
    setCurrentRevealed: (on) => {
      entry.setRevealed(on);
      return state();
    },
    begin: () => {
      if (!state().canConfirm) return false;
      phase = "working";
      progress = undefined;
      failure = undefined;
      entry.cleared();
      return true;
    },
    reportProgress: (fraction) => {
      if (phase === "working") progress = nextProgress(progress, fraction);
      return state();
    },
    settle: (result) => {
      progress = undefined;
      if (result.ok) {
        phase = "done";
        testUnlock = result.testUnlock;
      } else if (result.retryable) {
        phase = "form";
        entry.refused(result.reason);
      } else {
        phase = "stopped";
        failure = reasonText(result.reason);
      }
      return state();
    },
  };
}
