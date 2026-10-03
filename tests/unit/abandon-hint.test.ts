import { describe, expect, it } from "vitest";
import { ABANDON_HOW } from "../../src/sync/abandon-hint";
import { RootStateError } from "../../src/sync/local-record";
import { journalMismatch, sequenceAhead, sequenceBehind, sequenceFork } from "../../src/sync/publish-refusals";

/** Refusals that tell the user to abandon a vault must name the command that exists in both hosts. */
describe("refusals that name the abandon action", () => {
  it("names the CLI command and the plugin command", () => {
    expect(ABANDON_HOW).toContain("ipfs-sync abandon <vault>");
    expect(ABANDON_HOW).toContain('"Abandon this vault"');
  });

  it.each([
    ["sequence-behind", sequenceBehind(1, 2).message],
    ["journal-mismatch", journalMismatch("vault").message],
    ["unusable local record", new RootStateError("it is not valid JSON").message],
  ])("%s carries the real command", (_label, message) => {
    expect(message).toContain(ABANDON_HOW);
  });
});

/**
 * Task 2.1: the fork and ahead refusals no longer send the user to abandon. They name the recovery that exists for them:
 * `pull --resolve-fork` for a fork and pull for a device the node is ahead of. Neither mentions `--repair` or abandon.
 */
describe("refusals that point to pull", () => {
  it("sequence-fork names pull --resolve-fork", () => {
    const message = sequenceFork(3).message;
    expect(message).toContain("pull --resolve-fork");
    expect(message).not.toContain(ABANDON_HOW);
    expect(message).not.toContain("--repair");
  });

  it.each([
    ["with a record", sequenceAhead(4, 2).message],
    ["without a record", sequenceAhead(4, undefined).message],
  ])("sequence-ahead %s says to pull first", (_label, message) => {
    expect(message).toContain("pull first");
    expect(message).not.toContain(ABANDON_HOW);
    expect(message).not.toContain("--repair");
  });
});
