import { describe, expect, it } from "vitest";
import {
  checkVaultBeforeDerivation,
  effectiveRecord,
  evaluatePullVerdict,
  recordAfterVerdict,
  type EffectiveRecord,
  type PullFlags,
  type PullTargetKind,
  type PullVerdict,
} from "../../src/sync/pull-sequence";

const VAULT = "a".repeat(32);
const OTHER = "b".repeat(32);
const ID_A = "1".repeat(64);
const ID_B = "2".repeat(64);
const ID_C = "3".repeat(64);

const record = (sequence: number, identity = ID_A, extra: Partial<EffectiveRecord> = {}): EffectiveRecord => ({
  vaultId: VAULT,
  sequence,
  identity,
  source: "state",
  conflict: false,
  pendingPublish: false,
  ...extra,
});
const candidate = (sequence: number, identity = ID_A, vaultId = VAULT) => ({ vaultId, sequence, identity });

const NO_FLAGS: PullFlags = {};
const run = (rec: EffectiveRecord | undefined, cand: ReturnType<typeof candidate>, target: PullTargetKind, flags: PullFlags = NO_FLAGS): PullVerdict =>
  evaluatePullVerdict({ record: rec, candidate: cand, target, flags });

function refusal(verdict: PullVerdict): Extract<PullVerdict, { kind: "refused" }> {
  if (verdict.kind !== "refused") throw new Error(`expected a refusal, got ${verdict.kind}`);
  return verdict;
}

describe("pull verdicts: decision 4 table", () => {
  it("row 2: no record is a first pull for every target kind", () => {
    for (const target of ["name", "root-cid", "manifest"] as const) {
      expect(run(undefined, candidate(5), target).kind).toBe("first-pull");
    }
  });

  it("row 2: a first pull with an allow-rollback flag on an explicit target is still a first pull", () => {
    expect(run(undefined, candidate(2), "root-cid", { allowRollback: true }).kind).toBe("first-pull");
  });

  it("row 3: another vault is refused for every target and flag, and cannot be overridden", () => {
    for (const target of ["name", "root-cid", "manifest"] as const) {
      const verdict = refusal(run(record(5), candidate(9, ID_B, OTHER), target, target === "name" ? {} : { allowRollback: true }));
      expect(verdict.reason).toBe("other-vault");
    }
    expect(refusal(run(record(5), candidate(5, ID_A, OTHER), "name", { resolveFork: true })).reason).toBe("other-vault");
  });

  it("row 4: lower by name is refused; the text names both sequences, says stale or hostile, and has no flag", () => {
    const verdict = refusal(run(record(5), candidate(4), "name"));
    expect(verdict.reason).toBe("older");
    expect(verdict.message).toContain("4");
    expect(verdict.message).toContain("5");
    expect(verdict.message).toMatch(/older state/);
    expect(verdict.message).toMatch(/hostile/);
    expect(verdict.message).not.toMatch(/allow-rollback/);
    expect(verdict.message).not.toMatch(/rollback/i);
    expect(verdict.message).not.toMatch(/--root-cid|--manifest/);
  });

  it.each(["root-cid", "manifest"] as const)("row 4: lower with explicit target %s and no flag is refused with a message naming the flag", (target) => {
    const verdict = refusal(run(record(5), candidate(2), target));
    expect(verdict.reason).toBe("older");
    expect(verdict.message).toContain("--allow-rollback");
    expect(verdict.message).toContain("2");
    expect(verdict.message).toContain("5");
  });

  it.each(["root-cid", "manifest"] as const)("row 4: lower with explicit target %s and the flag is a restore", (target) => {
    const verdict = run(record(5), candidate(2), target, { allowRollback: true });
    expect(verdict).toEqual({ kind: "restore", recordedSequence: 5, candidateSequence: 2 });
  });

  it("row 4: lower with the flag but a name target is refused as a flag combination, before any comparison", () => {
    const verdict = refusal(run(record(5), candidate(2), "name", { allowRollback: true }));
    expect(verdict.reason).toBe("flag-combination");
    expect(verdict.message).toContain("--allow-rollback");
    expect(verdict.message).toMatch(/--root-cid/);
  });

  it("row 4: the flag with a name target is refused even when the candidate is not lower", () => {
    expect(refusal(run(record(5), candidate(7), "name", { allowRollback: true })).reason).toBe("flag-combination");
    expect(refusal(run(undefined, candidate(7), "name", { allowRollback: true })).reason).toBe("flag-combination");
  });

  it("row 5: equal sequence with the same identity is the same state and proceeds", () => {
    for (const target of ["name", "root-cid", "manifest"] as const) {
      expect(run(record(5), candidate(5), target).kind).toBe("same");
    }
  });

  it("row 6: equal sequence with a different identity is a fork, by name and by explicit target", () => {
    const byName = refusal(run(record(5), candidate(5, ID_B), "name"));
    expect(byName.reason).toBe("fork");
    expect(byName.message).toContain("5");
    expect(byName.message).toContain("--resolve-fork");
    const explicit = refusal(run(record(5), candidate(5, ID_B), "root-cid"));
    expect(explicit.reason).toBe("fork");
    expect(explicit.message).not.toContain("--resolve-fork");
  });

  it("row 6: a fork is refused even with the allow-rollback flag on an explicit target", () => {
    for (const target of ["root-cid", "manifest"] as const) {
      expect(refusal(run(record(5), candidate(5, ID_B), target, { allowRollback: true })).reason).toBe("fork");
    }
  });

  it("row 6: a fork is resolved only with resolveFork and a name target", () => {
    expect(run(record(5), candidate(5, ID_B), "name", { resolveFork: true })).toEqual({ kind: "fork-resolution", sequence: 5 });
    expect(refusal(run(record(5), candidate(5, ID_B), "root-cid", { resolveFork: true })).reason).toBe("flag-combination");
    expect(refusal(run(record(5), candidate(5, ID_B), "manifest", { resolveFork: true })).reason).toBe("flag-combination");
  });

  it("resolveFork cannot be combined with allow-rollback", () => {
    const verdict = refusal(run(record(5), candidate(5, ID_B), "name", { resolveFork: true, allowRollback: true }));
    expect(verdict.reason).toBe("flag-combination");
  });

  it("row 7: higher proceeds as newer for every target", () => {
    for (const target of ["name", "root-cid", "manifest"] as const) {
      expect(run(record(5), candidate(7, ID_C), target)).toEqual({ kind: "newer", from: 5, to: 7 });
    }
  });

  it("row 7: higher with allow-rollback on an explicit target is still newer, not a restore", () => {
    expect(run(record(5), candidate(7, ID_C), "root-cid", { allowRollback: true }).kind).toBe("newer");
  });
});

describe("pull verdicts: expectations (row 1)", () => {
  it("a failed expectMinSequence is refused and writes nothing, with no record, a lower record and a higher record", () => {
    for (const rec of [undefined, record(3), record(8)]) {
      const verdict = refusal(run(rec, candidate(7), "name", { expectMinSequence: 9 }));
      expect(verdict.reason).toBe("expectation-failed");
      expect(verdict.message).toContain("9");
      expect(verdict.message).toContain("7");
    }
  });

  it("a satisfied expectMinSequence (equal or lower bound) does not change the verdict", () => {
    expect(run(record(5), candidate(7, ID_C), "name", { expectMinSequence: 7 }).kind).toBe("newer");
    expect(run(undefined, candidate(7), "name", { expectMinSequence: 1 }).kind).toBe("first-pull");
  });

  it("a failed expectVaultId is refused even on a first pull and when the record matches the candidate", () => {
    expect(refusal(run(undefined, candidate(7), "name", { expectVaultId: OTHER })).reason).toBe("expectation-failed");
    expect(refusal(run(record(5), candidate(7, ID_C), "name", { expectVaultId: OTHER })).reason).toBe("expectation-failed");
  });

  it("a matching expectVaultId passes", () => {
    expect(run(undefined, candidate(7), "name", { expectVaultId: VAULT }).kind).toBe("first-pull");
  });

  it("an expectation is not overridable by the flags and wins over every later row", () => {
    expect(refusal(run(record(5), candidate(2), "root-cid", { allowRollback: true, expectMinSequence: 3 })).reason).toBe("expectation-failed");
    expect(refusal(run(record(5), candidate(5, ID_B), "name", { resolveFork: true, expectMinSequence: 6 })).reason).toBe("expectation-failed");
    expect(refusal(run(record(5), candidate(9, ID_B, OTHER), "name", { expectVaultId: VAULT })).reason).toBe("expectation-failed");
  });
});

describe("pull verdicts: unfinished publish pending", () => {
  const adopted = record(7, ID_B, { pendingPublish: true });

  it("a state adopted above the node gives the unfinished-publish text, not the rollback text, for a name target", () => {
    const verdict = refusal(run(adopted, candidate(6, ID_C), "name"));
    expect(verdict.reason).toBe("unfinished-publish");
    expect(verdict.message).toBe("an unfinished publish of sequence 7 is pending; run publish");
    expect(verdict.message).not.toMatch(/hostile|rollback|older state/i);
  });

  it("the same candidate without a pending publish gets the rollback-family text", () => {
    expect(refusal(run(record(7, ID_B), candidate(6, ID_C), "name")).reason).toBe("older");
  });

  it("an explicit target without the flag over a pending publish still names the flag", () => {
    const verdict = refusal(run(adopted, candidate(6, ID_C), "root-cid"));
    expect(verdict.reason).toBe("older");
    expect(verdict.message).toContain("--allow-rollback");
  });

  it("equal and higher candidates are judged by the ordinary rows", () => {
    expect(run(adopted, candidate(7, ID_B), "name").kind).toBe("same");
    expect(refusal(run(adopted, candidate(7, ID_C), "name")).reason).toBe("fork");
    expect(run(adopted, candidate(8, ID_C), "name").kind).toBe("newer");
  });
});

describe("effective record over state and floor", () => {
  const state = (sequence: number, identity = ID_A, pendingPublish = false) => ({ vaultId: VAULT, sequence, identity, pendingPublish });
  const floor = (sequence: number, identity = ID_A, vaultId = VAULT) => ({ vaultId, sequence, identity });

  it("is undefined with neither a state nor a floor", () => {
    expect(effectiveRecord(undefined, undefined)).toBeUndefined();
  });

  it("is the state alone when there is no floor, and the floor alone when there is no state", () => {
    expect(effectiveRecord(state(5), undefined)).toMatchObject({ vaultId: VAULT, sequence: 5, identity: ID_A, source: "state", conflict: false });
    expect(effectiveRecord(undefined, floor(5, ID_B))).toMatchObject({ vaultId: VAULT, sequence: 5, identity: ID_B, source: "floor", conflict: false });
  });

  it("is the floor when the floor is higher than the state", () => {
    expect(effectiveRecord(state(3), floor(5, ID_B))).toMatchObject({ sequence: 5, identity: ID_B, source: "floor", conflict: false });
  });

  it("is the state when the state is higher than the floor", () => {
    expect(effectiveRecord(state(6, ID_B), floor(5))).toMatchObject({ sequence: 6, identity: ID_B, source: "state", conflict: false });
  });

  it("is both, without conflict, when sequence and identity agree", () => {
    expect(effectiveRecord(state(5), floor(5))).toMatchObject({ sequence: 5, identity: ID_A, source: "both", conflict: false });
  });

  it("flags a conflict when state and floor hold the same sequence with different identities", () => {
    const rec = effectiveRecord(state(5, ID_A), floor(5, ID_B));
    expect(rec).toMatchObject({ sequence: 5, conflict: true });
    expect(rec).toBeDefined();
  });

  it("a conflicting record is a fork for any candidate at that sequence, including one matching either side", () => {
    const rec = effectiveRecord(state(5, ID_A), floor(5, ID_B));
    expect(refusal(run(rec, candidate(5, ID_A), "name")).reason).toBe("fork");
    expect(refusal(run(rec, candidate(5, ID_B), "name")).reason).toBe("fork");
    expect(refusal(run(rec, candidate(5, ID_C), "root-cid", { allowRollback: true })).reason).toBe("fork");
    expect(run(rec, candidate(5, ID_C), "name", { resolveFork: true }).kind).toBe("fork-resolution");
  });

  it("a conflicting record still refuses a lower candidate as older and accepts a higher one", () => {
    const rec = effectiveRecord(state(5, ID_A), floor(5, ID_B));
    expect(refusal(run(rec, candidate(4, ID_C), "name")).reason).toBe("older");
    expect(run(rec, candidate(6, ID_C), "name").kind).toBe("newer");
  });

  it("a floor higher than the state makes a lower node an older refusal even though the directory state would accept it", () => {
    const rec = effectiveRecord(state(3), floor(5, ID_B));
    expect(refusal(run(rec, candidate(4, ID_C), "name")).reason).toBe("older");
    expect(run(rec, candidate(4, ID_C), "root-cid", { allowRollback: true }).kind).toBe("restore");
  });

  it("a pending publish is recognised only while the state is above the floor", () => {
    expect(effectiveRecord(state(7, ID_B, true), floor(5))).toMatchObject({ sequence: 7, pendingPublish: true });
    expect(effectiveRecord(state(7, ID_B, true), undefined)).toMatchObject({ pendingPublish: true });
    expect(effectiveRecord(state(7, ID_B, true), floor(7, ID_B))).toMatchObject({ pendingPublish: false });
    expect(effectiveRecord(state(7, ID_B, true), floor(9, ID_C))).toMatchObject({ sequence: 9, pendingPublish: false });
    expect(effectiveRecord(state(7, ID_B, false), floor(5))).toMatchObject({ pendingPublish: false });
  });

  it("a floor of another vault does not affect the directory's record", () => {
    expect(effectiveRecord(state(3), floor(9, ID_B, OTHER))).toMatchObject({ vaultId: VAULT, sequence: 3, source: "state" });
  });

  it("a pending publish drives the unfinished-publish refusal end to end", () => {
    const rec = effectiveRecord(state(7, ID_B, true), floor(5));
    expect(refusal(run(rec, candidate(6, ID_C), "name")).reason).toBe("unfinished-publish");
  });
});

describe("the record is never lowered", () => {
  const rec = record(5);
  const cases: ReadonlyArray<readonly [string, PullVerdict, ReturnType<typeof candidate>]> = [
    ["first-pull", { kind: "first-pull" }, candidate(3)],
    ["same", { kind: "same" }, candidate(5)],
    ["newer", { kind: "newer", from: 5, to: 7 }, candidate(7, ID_C)],
    ["restore", { kind: "restore", recordedSequence: 5, candidateSequence: 2 }, candidate(2, ID_B)],
    ["fork-resolution", { kind: "fork-resolution", sequence: 5 }, candidate(5, ID_B)],
    ["refused", { kind: "refused", reason: "older", message: "x" }, candidate(2, ID_B)],
  ];

  it.each(cases)("%s never lowers the sequence", (_name, verdict, cand) => {
    const next = recordAfterVerdict(rec, cand, verdict);
    expect(next === undefined ? 0 : next.sequence).toBeGreaterThanOrEqual(rec.sequence);
  });

  it("a restore and a refusal leave the record exactly as it was", () => {
    expect(recordAfterVerdict(rec, candidate(2, ID_B), { kind: "restore", recordedSequence: 5, candidateSequence: 2 })).toEqual({
      vaultId: VAULT,
      sequence: 5,
      identity: ID_A,
    });
    expect(recordAfterVerdict(rec, candidate(2, ID_B), { kind: "refused", reason: "older", message: "x" })).toEqual({ vaultId: VAULT, sequence: 5, identity: ID_A });
  });

  it("newer and first-pull take the candidate; fork-resolution takes the candidate's identity at the same sequence", () => {
    expect(recordAfterVerdict(rec, candidate(7, ID_C), { kind: "newer", from: 5, to: 7 })).toEqual({ vaultId: VAULT, sequence: 7, identity: ID_C });
    expect(recordAfterVerdict(undefined, candidate(3, ID_B), { kind: "first-pull" })).toEqual({ vaultId: VAULT, sequence: 3, identity: ID_B });
    expect(recordAfterVerdict(rec, candidate(5, ID_B), { kind: "fork-resolution", sequence: 5 })).toEqual({ vaultId: VAULT, sequence: 5, identity: ID_B });
  });

  it("no verdict the function returns lowers the record, over a grid of sequences, targets and flags", () => {
    const flagSets: PullFlags[] = [{}, { allowRollback: true }, { resolveFork: true }, { allowRollback: true, resolveFork: true }];
    for (const target of ["name", "root-cid", "manifest"] as const) {
      for (const flags of flagSets) {
        for (const sequence of [1, 4, 5, 6, 9]) {
          for (const identity of [ID_A, ID_B]) {
            const cand = candidate(sequence, identity);
            const next = recordAfterVerdict(rec, cand, run(rec, cand, target, flags));
            expect(next === undefined ? 0 : next.sequence).toBeGreaterThanOrEqual(rec.sequence);
          }
        }
      }
    }
  });
});

describe("vault check before key derivation", () => {
  it("passes with a matching expectation and record", () => {
    expect(checkVaultBeforeDerivation({ slotVaultId: VAULT, record: record(5), flags: { expectVaultId: VAULT } })).toBeUndefined();
    expect(checkVaultBeforeDerivation({ slotVaultId: VAULT, record: undefined, flags: {} })).toBeUndefined();
  });

  it("refuses a failed expectVaultId before the record", () => {
    const refused = checkVaultBeforeDerivation({ slotVaultId: VAULT, record: record(5), flags: { expectVaultId: OTHER } });
    expect(refused).toMatchObject({ kind: "refused", reason: "expectation-failed" });
  });

  it("refuses a slot file of another vault than the record (state or floor)", () => {
    const refused = checkVaultBeforeDerivation({ slotVaultId: OTHER, record: record(5), flags: {} });
    expect(refused).toMatchObject({ kind: "refused", reason: "other-vault" });
  });
});
