// Mutation witness for the sequence floor (mvp-07a task 6.1). The guard: the pull's record is the higher of the directory's state and the
// device-local floor, so abandoning a directory does not make an older manifest acceptable. The seam below removes it IN THIS FILE ONLY:
// the pull's floor read finds nothing, from the moment the scenario arms it (just before the attack), so abandon and the baseline pulls
// still see the floor. Production code is not touched. The same driver and assertion as safety-guards.test.ts must then fail.
import { describe, expect, it, vi } from "vitest";
import { DAILY } from "../helpers/integration-devices";
import { assertFloorRefusesOlderAfterAbandon, expectAssertionFailure, runFloorAfterAbandon } from "../helpers/safety-scenarios";

const seam = vi.hoisted(() => ({ blind: false }));

vi.mock("../../src/sync/sequence-floor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sync/sequence-floor")>();
  return {
    ...actual,
    // MUTATION: once armed, no floor is ever found.
    readFloor: async (store: Parameters<typeof actual.readFloor>[0], vaultId: string) => (seam.blind ? undefined : actual.readFloor(store, vaultId)),
  };
});

describe("witness: the floor scenario fails when the pull ignores the floor", () => {
  it("the older manifest is accepted as a first pull into the abandoned directory, so the guarded assertions throw", async () => {
    const observed = await runFloorAfterAbandon(() => {
      seam.blind = true;
    });

    const failure = expectAssertionFailure(() => assertFloorRefusesOlderAfterAbandon(observed));
    expect(failure).toContain("older");

    // What the unguarded pull did: a first pull of sequence 1 was accepted and the vault went back to the sequence 1 text.
    expect(observed.outcome.kind).toBe("completed");
    expect(observed.texts[DAILY]).not.toBe(observed.expectedTexts[DAILY]);
  });
});
