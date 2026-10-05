import { readFileSync } from "node:fs";
import type { App as ObsidianApp } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KDF_ITERATIONS_CEILING, KDF_ITERATIONS_DEFAULT, KDF_MEMORY_CEILING_KIB, KDF_MEMORY_DEFAULT_KIB, KDF_PARALLELISM, type KdfParams } from "../../src/crypto";
import { AcceptSlotsDialog, type AcceptSlotsDialogRequest } from "../../src/plugin/accept-slots-dialog";
import type { AcceptCheckResult, AcceptCommitResult } from "../../src/plugin/accept-slots-dialog-model";
import { ChangePassphraseDialog, type ChangePassphraseDialogRequest } from "../../src/plugin/change-passphrase-dialog";
import type { ChangePassphraseResult } from "../../src/plugin/change-passphrase-dialog-model";
import { ACCEPT_SLOTS_COPY, CHANGE_PASSPHRASE_COPY, INCREASE_COST_COPY, KEY_DIALOG_COPY, MASS_REMOVAL_COPY, TEST_UNLOCK_COPY } from "../../src/plugin/encryption-copy";
import { IncreaseCostDialog, type IncreaseCostDialogRequest } from "../../src/plugin/increase-cost-dialog";
import type { IncreaseCostResult } from "../../src/plugin/increase-cost-dialog-model";
import { MassRemovalDialog, askMassRemoval } from "../../src/plugin/mass-removal-dialog";
import { REVOCATION_STATEMENT } from "../../src/sync/key-management-text";
import { byId, focusOrder, type FakeEl } from "../support/fake-dom";
import { App, Modal } from "../support/obsidian-stub";
import { flush, labelOf } from "../support/settings-tab-rig";

const NEW_PASSPHRASE = "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2";
const OLD = "KLMNO-PQRST-UVWX2-ABCDE-FGHIJ";
const STANDARD: KdfParams = { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM };
const HIGH: KdfParams = { m: KDF_MEMORY_CEILING_KIB, t: KDF_ITERATIONS_CEILING, p: KDF_PARALLELISM };

const app = (): ObsidianApp => new App() as unknown as ObsidianApp;
const check = (text: string) => (text.replaceAll("-", "").length === 25 ? undefined : ("wrong-length" as const));

beforeEach(() => Modal.reset());

const content = (dialog: unknown): FakeEl => (dialog as { contentEl: FakeEl }).contentEl;

function must(root: FakeEl, id: string): FakeEl {
  const el = byId(root, id);
  if (el === undefined) throw new Error(`no element ${id}`);
  return el;
}

const button = (root: FakeEl, text: string): FakeEl => {
  const found = root.find((el) => el.tag === "button" && el.text === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};

const buttons = (root: FakeEl): string[] => root.findAll((el) => el.tag === "button" && el.style["display"] !== "none").map((el) => el.text);

async function type(el: FakeEl, text: string): Promise<void> {
  el.value = text;
  await el.dispatch("input");
}

async function tick(el: FakeEl, on: boolean): Promise<void> {
  el.checked = on;
  await el.dispatch("change");
}

/** Controls (not prose) whose name or title mentions copying or the clipboard. */
const copyControls = (root: FakeEl): FakeEl[] =>
  root.findAll((el) => ["button", "a", "input"].includes(el.tag) && /copy|clipboard/i.test(`${el.text} ${el.title} ${el.getAttr("aria-label") ?? ""}`));

/** The row a toggle's checkbox sits in: the checkbox's own row, then the row the dialog hides. */
const toggleRow = (root: FakeEl, id: string): FakeEl | null => must(root, id).parent?.parent ?? null;

const focusedNames = (root: FakeEl): string[] => focusOrder(root).filter((el) => el.focused).map((el) => el.id || el.text);

/** The tab order: the id or text of every control a keyboard user can reach, hidden controls left out. */
function tabOrder(root: FakeEl): string[] {
  const hidden = (el: FakeEl): boolean => {
    for (let node: FakeEl | null = el; node !== null; node = node.parent) if (node.style["display"] === "none") return true;
    return false;
  };
  return focusOrder(root).filter((el) => !hidden(el)).map((el) => el.id || el.text);
}

// ---------- change passphrase ----------

type Run = ChangePassphraseDialogRequest["run"];
const verified: ChangePassphraseResult = { ok: true, testUnlock: "verified" };

function openChange(run: Run = async () => verified) {
  const finished = vi.fn();
  const runner = vi.fn(run);
  const dialog = new ChangePassphraseDialog(app(), { passphrase: NEW_PASSPHRASE, cost: STANDARD, check, run: runner }, finished);
  dialog.open();
  return { dialog, root: content(dialog), finished, runner };
}

async function fillChange(root: FakeEl): Promise<void> {
  await type(must(root, "ipfs-sync-change-current"), OLD);
  await type(must(root, "ipfs-sync-change-reentry"), NEW_PASSPHRASE);
  await tick(must(root, "ipfs-sync-change-acknowledge"), true);
}

describe("change-passphrase dialog", () => {
  it("shows the generated passphrase once in monospace in 5 groups of 5, with the case note, and the statements before confirm", () => {
    const { root } = openChange();
    const group = must(root, "ipfs-sync-change-passphrase");
    expect(group.style["font-family"]).toContain("monospace");
    expect(group.findAll((el) => el.tag === "code").map((el) => el.text)).toEqual(["ABCDE", "FGHIJ", "KLMNO", "PQRST", "UVWX2"]);
    const text = root.textContent();
    expect(text).toContain("Letters are not case-sensitive");
    expect(text).toContain(REVOCATION_STATEMENT);
    expect(text).toContain(CHANGE_PASSPHRASE_COPY.noRecovery);
    expect(text).toContain("four key derivations");
  });

  it("offers no field for choosing a passphrase and no copy control", () => {
    const { root } = openChange();
    const inputs = root.findAll((el) => el.tag === "input" && el.type !== "checkbox");
    expect(inputs.map((el) => el.id)).toEqual(["ipfs-sync-change-current", "ipfs-sync-change-reentry"]);
    expect(inputs.every((el) => el.type === "password")).toBe(true);
    expect(copyControls(root)).toEqual([]);
    expect(root.find((el) => el.tag === "textarea")).toBeUndefined();
  });

  it("puts every control in reading order with a visible label, and lands the first focus on the current passphrase", () => {
    const { root } = openChange();
    expect(focusedNames(root)).toEqual(["ipfs-sync-change-current"]);
    expect(tabOrder(root)).toEqual([
      "ipfs-sync-change-current",
      "ipfs-sync-change-current-reveal",
      "ipfs-sync-change-reentry",
      "ipfs-sync-change-reveal",
      "ipfs-sync-change-acknowledge",
      KEY_DIALOG_COPY.cancel,
    ]);
    for (const el of focusOrder(root)) expect(labelOf(root, el) || el.text, `${el.tag} ${el.id} has no accessible name`).not.toBe("");
  });

  it("keeps the confirm control disabled until the statement is acknowledged", async () => {
    const { root } = openChange();
    const confirm = button(root, CHANGE_PASSPHRASE_COPY.confirm);
    await type(must(root, "ipfs-sync-change-current"), OLD);
    await type(must(root, "ipfs-sync-change-reentry"), NEW_PASSPHRASE);
    expect(confirm.disabled).toBe(true);
    expect(must(root, "ipfs-sync-change-requirements").text).toContain(CHANGE_PASSPHRASE_COPY.needAcknowledgement);
    await tick(must(root, "ipfs-sync-change-acknowledge"), true);
    expect(confirm.disabled).toBe(false);
    expect(must(root, "ipfs-sync-change-requirements").text).toBe("");
  });

  it("does nothing for Enter before the gating holds", async () => {
    const { root, runner } = openChange();
    await type(must(root, "ipfs-sync-change-current"), OLD);
    await must(root, "ipfs-sync-change-current").dispatch("keydown", { key: "Enter" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs once with the current passphrase, empties the field, and shows the test unlock result without closing", async () => {
    const { root, runner, finished } = openChange();
    await fillChange(root);
    await button(root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    await flush();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toBe(OLD);
    expect(must(root, "ipfs-sync-change-current").value).toBe("");
    const result = must(root, "ipfs-sync-change-result").textContent();
    expect(result).toContain(CHANGE_PASSPHRASE_COPY.doneTitle);
    expect(result).toContain(`${TEST_UNLOCK_COPY.heading}: ${TEST_UNLOCK_COPY.verified}`);
    expect(finished).not.toHaveBeenCalled();
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.close]);
    await button(root, KEY_DIALOG_COPY.close).dispatch("click");
    expect(finished).toHaveBeenCalledWith("done");
  });

  it("keeps the new passphrase on screen after success so it can still be saved", async () => {
    const { root } = openChange();
    await fillChange(root);
    await button(root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    await flush();
    expect(must(root, "ipfs-sync-change-passphrase").findAll((el) => el.tag === "code")).toHaveLength(5);
  });

  it("settles with the real outcome: a wrong passphrase leaves the dialog open with a text error on the field and a retry possible", async () => {
    const answers: ChangePassphraseResult[] = [{ ok: false, reason: "That passphrase did not open this vault.", retryable: true }, verified];
    const { root, runner, finished } = openChange(async () => answers.shift() ?? verified);
    await fillChange(root);
    await button(root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    await flush();
    const field = must(root, "ipfs-sync-change-current");
    expect(finished).not.toHaveBeenCalled();
    expect(must(root, "ipfs-sync-change-current-error").text).toBe("Error: That passphrase did not open this vault.");
    expect(field.getAttr("aria-invalid")).toBe("true");
    expect(focusedNames(root)).toContain("ipfs-sync-change-current");
    expect(button(root, CHANGE_PASSPHRASE_COPY.confirm).disabled).toBe(true);
    await type(field, OLD);
    expect(button(root, CHANGE_PASSPHRASE_COPY.confirm).disabled).toBe(false);
    await button(root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    await flush();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(must(root, "ipfs-sync-change-result").textContent()).toContain(CHANGE_PASSPHRASE_COPY.doneTitle);
  });

  it("locks the form after a failure that may have changed the node and ends as stopped", async () => {
    const { root, finished } = openChange(async () => ({ ok: false, reason: "test unlock failed", retryable: false }));
    await fillChange(root);
    await button(root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    await flush();
    expect(must(root, "ipfs-sync-change-failure").text).toBe(`Error: ${CHANGE_PASSPHRASE_COPY.failed}: test unlock failed.`);
    expect(must(root, "ipfs-sync-change-result").textContent()).toContain(KEY_DIALOG_COPY.stopped);
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.close]);
    await button(root, KEY_DIALOG_COPY.close).dispatch("click");
    expect(finished).toHaveBeenCalledWith("stopped");
  });

  it("treats a thrown error as a stop with fixed text, never the error's message", async () => {
    const { root } = openChange(async () => {
      throw new Error("secret passphrase ABCDE leaked in a message");
    });
    await fillChange(root);
    await button(root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    await flush();
    expect(root.textContent()).not.toContain("leaked");
    expect(must(root, "ipfs-sync-change-failure").text).toContain("unexpected error");
  });

  it("renders a reason from the node as text, with control and bidirectional characters written out", async () => {
    const hostile = '<img src=x onerror="alert(1)">‮evil';
    const { root } = openChange(async () => ({ ok: false, reason: hostile, retryable: false }));
    await fillChange(root);
    await button(root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    await flush();
    expect(root.find((el) => el.tag === "img")).toBeUndefined();
    const text = must(root, "ipfs-sync-change-failure").text;
    expect(text).toContain('<img src=x onerror="alert(1)">');
    expect(text).toContain("\\u202eevil");
    expect(text).not.toContain("‮");
  });

  it("is a cancel when closed before running, and reports the real end when closed while the run goes", async () => {
    const early = openChange();
    early.dialog.close();
    expect(early.finished).toHaveBeenCalledWith("cancelled");

    let release: (r: ChangePassphraseResult) => void = () => undefined;
    const late = openChange(() => new Promise<ChangePassphraseResult>((resolve) => (release = resolve)));
    await fillChange(late.root);
    await button(late.root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    late.dialog.close();
    expect(late.finished).not.toHaveBeenCalled();
    release(verified);
    await flush();
    expect(late.finished).toHaveBeenCalledWith("done");
  });

  it("reports progress in text while the run goes", async () => {
    let report: (fraction: number) => void = () => undefined;
    let release: (r: ChangePassphraseResult) => void = () => undefined;
    const { root } = openChange((_text, onProgress) => {
      report = onProgress;
      return new Promise<ChangePassphraseResult>((resolve) => (release = resolve));
    });
    await fillChange(root);
    await button(root, CHANGE_PASSPHRASE_COPY.confirm).dispatch("click");
    report(0.5);
    expect(must(root, "ipfs-sync-change-progress").textContent()).toContain("50 percent");
    release(verified);
    await flush();
  });
});

// ---------- increase cost ----------

type CostRun = IncreaseCostDialogRequest["run"];
const costOk: IncreaseCostResult = { ok: true, testUnlock: "verified" };

function openCost(current: KdfParams = STANDARD, run: CostRun = async () => costOk) {
  const finished = vi.fn();
  const runner = vi.fn(run);
  const dialog = new IncreaseCostDialog(app(), { current, check, run: runner }, finished);
  dialog.open();
  return { dialog, root: content(dialog), finished, runner };
}

const radio = (root: FakeEl, id: string): FakeEl => must(root, `ipfs-sync-cost-choice-${id}`);

async function choose(root: FakeEl, id: string): Promise<void> {
  await tick(radio(root, id), true);
}

describe("increase-cost dialog", () => {
  it("offers the current cost and the higher preset as native radio buttons, each naming memory and iterations, and no free field", () => {
    const { root } = openCost();
    const radios = root.findAll((el) => el.type === "radio");
    expect(radios.map((el) => el.id)).toEqual(["ipfs-sync-cost-choice-current", "ipfs-sync-cost-choice-high"]);
    expect(radios.every((el) => el.getAttr("name") === "ipfs-sync-cost-choice")).toBe(true);
    for (const el of radios) expect(labelOf(root, el)).toMatch(/\d+ MiB, \d iterations/);
    expect(radio(root, "current").checked).toBe(true);
    expect(root.findAll((el) => el.tag === "input" && ["text", "number", "range"].includes(el.type))).toEqual([]);
    expect(must(root, "ipfs-sync-cost-choice-desc").text).toContain("Nothing above the allowed maximum");
  });

  it("states the old-passphrase facts, the slower-device warning and the same-passphrase limit before confirm", () => {
    const text = openCost().root.textContent();
    expect(text).toContain(REVOCATION_STATEMENT);
    expect(text).toContain("Slower devices");
    expect(text).toContain("does not protect against an attacker who already holds the old slot");
  });

  it("keeps confirm disabled until a different cost is chosen and the statement is acknowledged, then runs with the chosen cost", async () => {
    const { root, runner, finished } = openCost();
    const confirm = button(root, INCREASE_COST_COPY.confirm);
    await type(must(root, "ipfs-sync-cost-current"), OLD);
    await tick(must(root, "ipfs-sync-cost-acknowledge"), true);
    expect(confirm.disabled).toBe(true);
    expect(must(root, "ipfs-sync-cost-requirements").text).toContain(INCREASE_COST_COPY.needChoice);
    await choose(root, "high");
    expect(confirm.disabled).toBe(false);
    expect(must(root, "ipfs-sync-cost-selection").text).toContain(INCREASE_COST_COPY.aboveDefault);
    await confirm.dispatch("click");
    await flush();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toEqual({ passphrase: OLD, params: HIGH, allowDowngrade: false });
    expect(must(root, "ipfs-sync-cost-result").textContent()).toContain(TEST_UNLOCK_COPY.verified);
    await button(root, KEY_DIALOG_COPY.close).dispatch("click");
    expect(finished).toHaveBeenCalledWith("done");
  });

  it("hides the downgrade confirmation for a higher choice and shows both costs with a separate confirmation for a lower one", async () => {
    const { root, runner } = openCost(HIGH);
    const row = toggleRow(root, "ipfs-sync-cost-downgrade");
    expect(row?.style["display"]).toBe("none");
    await type(must(root, "ipfs-sync-cost-current"), OLD);
    await tick(must(root, "ipfs-sync-cost-acknowledge"), true);
    await choose(root, "standard");
    expect(row?.style["display"]).toBe("");
    const question = must(root, "ipfs-sync-cost-downgrade-question").text;
    expect(question).toContain("128 MiB, 4 iterations");
    expect(question).toContain("64 MiB, 3 iterations");
    const confirm = button(root, INCREASE_COST_COPY.confirmLower);
    expect(confirm.disabled).toBe(true);
    await tick(must(root, "ipfs-sync-cost-downgrade"), true);
    expect(confirm.disabled).toBe(false);
    await confirm.dispatch("click");
    await flush();
    expect(runner.mock.calls[0]?.[0]).toEqual({ passphrase: OLD, params: STANDARD, allowDowngrade: true });
  });

  it("returns to the form with a text error after a wrong passphrase, and stops on a failure that may have changed the node", async () => {
    const { root, finished } = openCost(STANDARD, async () => ({ ok: false, reason: "wrong passphrase", retryable: true }));
    await type(must(root, "ipfs-sync-cost-current"), OLD);
    await tick(must(root, "ipfs-sync-cost-acknowledge"), true);
    await choose(root, "high");
    await button(root, INCREASE_COST_COPY.confirm).dispatch("click");
    await flush();
    expect(must(root, "ipfs-sync-cost-current-error").text).toBe("Error: Wrong passphrase.");
    expect(finished).not.toHaveBeenCalled();

    const stopped = openCost(STANDARD, async () => ({ ok: false, reason: "node went away", retryable: false }));
    await type(must(stopped.root, "ipfs-sync-cost-current"), OLD);
    await tick(must(stopped.root, "ipfs-sync-cost-acknowledge"), true);
    await choose(stopped.root, "high");
    await button(stopped.root, INCREASE_COST_COPY.confirm).dispatch("click");
    await flush();
    expect(buttons(stopped.root)).toEqual([KEY_DIALOG_COPY.close]);
    stopped.dialog.close();
    expect(stopped.finished).toHaveBeenCalledWith("stopped");
  });

  it("puts every control in reading order with an accessible name", () => {
    const { root } = openCost();
    expect(tabOrder(root)).toEqual([
      "ipfs-sync-cost-choice-current",
      "ipfs-sync-cost-choice-high",
      "ipfs-sync-cost-current",
      "ipfs-sync-cost-current-reveal",
      "ipfs-sync-cost-acknowledge",
      KEY_DIALOG_COPY.cancel,
    ]);
    for (const el of focusOrder(root)) expect(labelOf(root, el) || el.text, `${el.id} has no accessible name`).not.toBe("");
  });
});

// ---------- accept key slots ----------

const review = { current: STANDARD, incoming: STANDARD, changes: true };

function openAccept(
  patch: Partial<Pick<AcceptSlotsDialogRequest, "checkSlots" | "accept">> = {},
  target: "name" | "root-cid" = "name",
) {
  const finished = vi.fn();
  const checkSlots = vi.fn(patch.checkSlots ?? (async (): Promise<AcceptCheckResult> => ({ ok: true, review })));
  const accept = vi.fn(patch.accept ?? (async (): Promise<AcceptCommitResult> => ({ ok: true, kind: "accepted" })));
  const dialog = new AcceptSlotsDialog(app(), { target, check, checkSlots, accept }, finished);
  dialog.open();
  return { dialog, root: content(dialog), finished, checkSlots, accept };
}

describe("accept-slots dialog", () => {
  it("explains that the passphrase must be the one the other device set, and asks only for it at first", () => {
    const { root } = openAccept();
    expect(root.textContent()).toContain("the one the other device set");
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.cancel, ACCEPT_SLOTS_COPY.checkButton]);
    expect(button(root, ACCEPT_SLOTS_COPY.checkButton).disabled).toBe(true);
    expect(focusedNames(root)).toEqual(["ipfs-sync-accept-current"]);
  });

  it("checks the slots with the passphrase, empties the field, then shows the review", async () => {
    const { root, checkSlots } = openAccept();
    await type(must(root, "ipfs-sync-accept-current"), OLD);
    await button(root, ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await flush();
    expect(checkSlots).toHaveBeenCalledTimes(1);
    expect(checkSlots.mock.calls[0]?.[0]).toBe(OLD);
    expect(must(root, "ipfs-sync-accept-current").value).toBe("");
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.cancel, ACCEPT_SLOTS_COPY.acceptButton]);
    expect(must(root, "ipfs-sync-accept-costs").textContent()).toContain("64 MiB, 3 iterations");
    expect(button(root, ACCEPT_SLOTS_COPY.acceptButton).disabled).toBe(false);
  });

  it("puts the focus on Cancel, not Accept, once the slots are reviewed (review round 3, P-M2)", async () => {
    const { root } = openAccept();
    await type(must(root, "ipfs-sync-accept-current"), OLD);
    await button(root, ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await flush();
    expect(button(root, ACCEPT_SLOTS_COPY.acceptButton).disabled).toBe(false);
    expect(focusedNames(root)).toEqual([KEY_DIALOG_COPY.cancel]);
  });

  it("shows both costs and needs a ticked confirmation when the incoming slot is cheaper", async () => {
    const { root, accept } = openAccept({ checkSlots: async () => ({ ok: true, review: { current: HIGH, incoming: STANDARD, changes: true } }) });
    await type(must(root, "ipfs-sync-accept-current"), OLD);
    await button(root, ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await flush();
    const costs = must(root, "ipfs-sync-accept-costs").textContent();
    expect(costs).toContain("128 MiB, 4 iterations");
    expect(costs).toContain("64 MiB, 3 iterations");
    expect(toggleRow(root, "ipfs-sync-accept-downgrade")?.style["display"]).toBe("");
    const acceptButton = button(root, ACCEPT_SLOTS_COPY.acceptButton);
    expect(acceptButton.disabled).toBe(true);
    await acceptButton.dispatch("click");
    expect(accept).not.toHaveBeenCalled();
    await tick(must(root, "ipfs-sync-accept-downgrade"), true);
    expect(acceptButton.disabled).toBe(false);
    await acceptButton.dispatch("click");
    await flush();
    expect(accept).toHaveBeenCalledWith({ downgradeConfirmed: true });
  });

  it("hides the confirmation when the incoming slot costs the same or more", async () => {
    const { root } = openAccept({ checkSlots: async () => ({ ok: true, review: { current: STANDARD, incoming: HIGH, changes: true } }) });
    await type(must(root, "ipfs-sync-accept-current"), OLD);
    await button(root, ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await flush();
    expect(toggleRow(root, "ipfs-sync-accept-downgrade")?.style["display"]).toBe("none");
    expect(button(root, ACCEPT_SLOTS_COPY.acceptButton).disabled).toBe(false);
  });

  it("returns to the passphrase step with a text error when the check refuses a wrong passphrase", async () => {
    const { root, finished } = openAccept({ checkSlots: async () => ({ ok: false, reason: "that passphrase did not open the key slots", retryable: true }) });
    await type(must(root, "ipfs-sync-accept-current"), OLD);
    await button(root, ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await flush();
    expect(must(root, "ipfs-sync-accept-current-error").text).toBe("Error: That passphrase did not open the key slots.");
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.cancel, ACCEPT_SLOTS_COPY.checkButton]);
    expect(finished).not.toHaveBeenCalled();
  });

  it("says there is nothing to accept when the copy already matches, and offers only Close", async () => {
    const { root } = openAccept({ checkSlots: async () => ({ ok: true, review: { ...review, changes: false } }) });
    await type(must(root, "ipfs-sync-accept-current"), OLD);
    await button(root, ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await flush();
    expect(must(root, "ipfs-sync-accept-nothing").style["display"]).toBe("");
    expect(button(root, ACCEPT_SLOTS_COPY.acceptButton).disabled).toBe(true);
    expect(buttons(root)[0]).toBe(KEY_DIALOG_COPY.close);
  });

  it("finishes done after a successful accept and says nothing was pulled", async () => {
    const { root, finished } = openAccept();
    await type(must(root, "ipfs-sync-accept-current"), OLD);
    await button(root, ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await flush();
    await button(root, ACCEPT_SLOTS_COPY.acceptButton).dispatch("click");
    await flush();
    expect(must(root, "ipfs-sync-accept-result").textContent()).toContain(ACCEPT_SLOTS_COPY.done);
    await button(root, KEY_DIALOG_COPY.close).dispatch("click");
    expect(finished).toHaveBeenCalledWith("done");
  });

  it("adds the older-root statement only for an explicit root", () => {
    expect(openAccept({}, "name").root.textContent()).not.toContain("You named an explicit root");
    expect(openAccept({}, "root-cid").root.textContent()).toContain("You named an explicit root");
  });

  it("has no copy control and renders a node reason as text", async () => {
    const { root } = openAccept({ checkSlots: async () => ({ ok: false, reason: "<b>bold</b>\u0007", retryable: false }) });
    await type(must(root, "ipfs-sync-accept-current"), OLD);
    await button(root, ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await flush();
    expect(root.find((el) => el.tag === "b")).toBeUndefined();
    expect(must(root, "ipfs-sync-accept-failure").text).toContain("<b>bold</b>\\u0007");
    expect(copyControls(root)).toEqual([]);
  });
});

// ---------- mass removal ----------

const counts = { removing: 6, remaining: 10, exclusionDriven: 0 };

describe("mass-removal dialog", () => {
  it("states the counts and that an emptied or unmounted vault looks the same", () => {
    const dialog = new MassRemovalDialog(app(), counts, vi.fn());
    dialog.open();
    const text = content(dialog).textContent();
    expect(text).toContain("This publish would remove 6 of 10 entries from the published vault.");
    expect(text).toContain("emptied or unmounted");
    expect(text).toContain(MASS_REMOVAL_COPY.nothingWritten);
  });

  it("puts the default focus on Cancel, with Cancel first in reading order", () => {
    const dialog = new MassRemovalDialog(app(), counts, vi.fn());
    dialog.open();
    const root = content(dialog);
    expect(focusedNames(root)).toEqual([MASS_REMOVAL_COPY.cancel]);
    expect(tabOrder(root)).toEqual([MASS_REMOVAL_COPY.cancel, "Remove 6 entries and publish"]);
  });

  it("is a yes only after the explicit confirm press", async () => {
    const finished = vi.fn();
    const dialog = new MassRemovalDialog(app(), counts, finished);
    dialog.open();
    await button(content(dialog), "Remove 6 entries and publish").dispatch("click");
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith(true);
  });

  it("is a no for Cancel, for closing, and for a second close", async () => {
    const cancelled = vi.fn();
    const first = new MassRemovalDialog(app(), counts, cancelled);
    first.open();
    await button(content(first), MASS_REMOVAL_COPY.cancel).dispatch("click");
    first.close();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledWith(false);

    const escaped = vi.fn();
    const second = new MassRemovalDialog(app(), counts, escaped);
    second.open();
    second.close();
    expect(escaped).toHaveBeenCalledWith(false);
  });

  it("resolves the engine port with true only after the confirm", async () => {
    const yes = askMassRemoval(app(), counts);
    const dialog = Modal.instances.at(-1);
    await button(content(dialog), "Remove 6 entries and publish").dispatch("click");
    await expect(yes).resolves.toBe(true);
    const no = askMassRemoval(app(), counts);
    Modal.instances.at(-1)?.close();
    await expect(no).resolves.toBe(false);
  });

  it("reports the exclusion-driven removals apart", () => {
    const dialog = new MassRemovalDialog(app(), { removing: 2, remaining: 2, exclusionDriven: 3 }, vi.fn());
    dialog.open();
    const text = content(dialog).textContent();
    expect(text).toContain("all 2 entries");
    expect(text).toContain("3 more entries are removed because the exclusion list now matches them");
  });
});

// ---------- no HTML sinks, no Node imports ----------

const NEW_FILES = [
  "accept-slots-dialog.ts",
  "accept-slots-dialog-model.ts",
  "change-passphrase-dialog.ts",
  "change-passphrase-dialog-model.ts",
  "increase-cost-dialog.ts",
  "increase-cost-dialog-model.ts",
  "key-dialog-controls.ts",
  "key-dialog-shared.ts",
  "key-secret-entry.ts",
  "mass-removal-dialog.ts",
  "mass-removal-dialog-model.ts",
  "measure-notice.ts",
  "encryption-settings.ts",
  "encryption-settings-model.ts",
] as const;

describe("source hygiene of the key and removal dialogs", () => {
  const source = (name: string): string => readFileSync(new URL(`../../src/plugin/${name}`, import.meta.url), "utf8");

  it.each(NEW_FILES)("%s writes no HTML and touches no clipboard", (name) => {
    const text = source(name);
    expect(text).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createEl\(\s*["']script|document\.write|\.clipboard|execCommand/);
  });

  it.each(NEW_FILES)("%s imports no Node module", (name) => {
    expect(source(name)).not.toMatch(/from\s+["'](node:|fs|path|os|crypto|child_process|buffer|stream|util)["']/);
  });
});
