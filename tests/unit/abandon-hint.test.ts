import { describe, expect, it } from "vitest";
import { ABANDON_HOW } from "../../src/sync/abandon-hint";
import { RootStateError } from "../../src/sync/local-record";
import { journalMismatch, sequenceBehind, sequenceFork } from "../../src/sync/publish-refusals";

/** Refusals that tell the user to abandon a vault must name the command that exists in both hosts. */
describe("refusals that name the abandon action", () => {
  it("names the CLI command and the plugin command", () => {
    expect(ABANDON_HOW).toContain("ipfs-sync abandon <vault>");
    expect(ABANDON_HOW).toContain('"Abandon this vault"');
  });

  it.each([
    ["sequence-behind", sequenceBehind(1, 2).message],
    ["sequence-fork", sequenceFork(3).message],
    ["journal-mismatch", journalMismatch("vault").message],
    ["unusable local record", new RootStateError("it is not valid JSON").message],
  ])("%s carries the real command", (_label, message) => {
    expect(message).toContain(ABANDON_HOW);
  });
});
