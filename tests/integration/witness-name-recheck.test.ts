// Mutation witness for the publisher's name re-check (mvp-07a task 6.1). The guard: right before `name/publish` the name is read again and
// the publish is refused when it moved off the root it had when the run started (`assertNameUnmoved`). Since review-final A-01 the commit also
// refuses up front when the node already holds a later publisher's manifest.enc (`assertNoLaterPublication`); both guards stop this
// overlap, so the seam below removes both IN THIS FILE ONLY. Production code is not touched. The same driver and assertion as tests/integration/safety-guards.test.ts must then fail.
import { describe, expect, it, vi } from "vitest";
import { assertOverlapRefused, expectAssertionFailure, runOverlappingPublishes } from "../helpers/safety-scenarios";

vi.mock("../../src/sync/name-recheck", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sync/name-recheck")>();
  return {
    ...actual,
    // MUTATION: the end-of-publish check never refuses.
    assertNameUnmoved: () => undefined,
    // MUTATION (review-final A-01): the commit's look at the winner's manifest.enc, which would otherwise refuse the same overlap earlier, never refuses.
    assertNoLaterPublication: () => undefined,
  };
});

describe("witness: the overlapping-publish scenario fails when the name re-check is removed", () => {
  it("the loser publishes over the winner's name, so the guarded assertions throw", async () => {
    const observed = await runOverlappingPublishes("replaces-a-file");

    const failure = expectAssertionFailure(() => assertOverlapRefused(observed));
    expect(failure).toContain("overlapping-publish");

    // What the unguarded publish did: it published, and the name no longer serves the winner's root.
    expect(observed.loserEnded).toBe("published");
    expect(observed.publishesAfterWinner.length).toBeGreaterThan(0);
    expect(observed.nameAfter).not.toBe(`/ipfs/${observed.rootOfWinner}`);
  });
});
