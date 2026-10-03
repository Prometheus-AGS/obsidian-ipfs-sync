// Mutation witness for the resume check (mvp-07a task 6.1). The guard: before an interrupted publish is adopted, re-encrypted or finished,
// the name must still be where that publish started (`assertNameStillAt`); a name that moved is an overlapping publish. The seam below
// removes it IN THIS FILE ONLY. Production code is not touched. The same driver and assertion as tests/integration/safety-guards.test.ts
// must then fail.
import { describe, expect, it, vi } from "vitest";
import { assertCrashResumeRefused, expectAssertionFailure, runCrashForeignPublishResume } from "../helpers/safety-scenarios";

vi.mock("../../src/sync/name-recheck", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sync/name-recheck")>();
  return {
    ...actual,
    // MUTATION: the resume-time check never refuses.
    assertNameStillAt: async () => undefined,
  };
});

describe("witness: the crash-and-resume scenario fails when the resume check is removed", () => {
  it("the rerun no longer ends in the overlapping-publish refusal, so the guarded assertions throw", async () => {
    const observed = await runCrashForeignPublishResume();

    const failure = expectAssertionFailure(() => assertCrashResumeRefused(observed));
    expect(failure).toContain("overlapping-publish");

    // What the rerun did without the name check: nothing was published (a second guard, `journal-manifest-mismatch` in publish-resume.ts,
    // sees that the node's manifest is not the one the journal announced), but the refusal is the other one, and it steers the user to
    // --repair or abandon instead of to pull. The specific refusal the spec asks for depends on the name check.
    expect(observed.rerunEnded).toBe("journal-manifest-mismatch");
    expect(observed.rerunMessage).toContain("--repair");
    expect(observed.rerunMutations).toEqual([]);
  });
});
