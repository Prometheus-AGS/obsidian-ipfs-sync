// Mutation witness for the replay guard (mvp-07a task 6.1). The guard: a manifest whose sequence is below the recorded one is refused
// when the target is the name (`older`). The seam below removes it IN THIS FILE ONLY: the verdict function reports such a manifest as
// newer. Production code is not touched. The same driver and assertion as tests/integration/safety-guards.test.ts must then fail.
import { describe, expect, it, vi } from "vitest";
import { DAILY } from "../helpers/integration-devices";
import { assertReplayRefused, expectAssertionFailure, runReplayByName } from "../helpers/safety-scenarios";

vi.mock("../../src/sync/pull-sequence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sync/pull-sequence")>();
  return {
    ...actual,
    evaluatePullVerdict: (input: Parameters<typeof actual.evaluatePullVerdict>[0]) => {
      const verdict = actual.evaluatePullVerdict(input);
      // MUTATION: the `older` refusal is lifted; an older manifest is treated as a newer one.
      if (verdict.kind === "refused" && verdict.reason === "older") return { kind: "newer" as const, from: input.record?.sequence ?? 0, to: input.candidate.sequence };
      return verdict;
    },
  };
});

describe("witness: the replayed-manifest scenario fails when the older-manifest refusal is removed", () => {
  it("the older state is pulled over the newer one, so the guarded assertions throw", async () => {
    const observed = await runReplayByName();

    const failure = expectAssertionFailure(() => assertReplayRefused(observed));
    expect(failure).toContain("older");

    // What the unguarded pull did: it completed and the vault went back to the sequence 1 text.
    expect(observed.outcome.kind).toBe("completed");
    expect(observed.before.texts[DAILY]).toBe("A's second edition of the daily note.\n");
    expect(observed.after.texts[DAILY]).not.toBe(observed.before.texts[DAILY]);
  });
});
