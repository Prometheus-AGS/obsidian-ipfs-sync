import { describe, expect, it } from "vitest";
import { PLAINTEXT_UNSUPPORTED_MESSAGE, PlaintextUnsupportedError } from "../../src/sync/pull-errors";

describe("the plaintext-publication refusal", () => {
  it("says plaintext publications are no longer supported and that nothing was written", () => {
    const error = new PlaintextUnsupportedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PlaintextUnsupportedError");
    expect(error.message).toBe(PLAINTEXT_UNSUPPORTED_MESSAGE);
    expect(error.message).toMatch(/plaintext publications are no longer supported/);
    expect(error.message).toMatch(/nothing was written/);
  });

  it("offers no flag or recorded-state escape", () => {
    expect(PLAINTEXT_UNSUPPORTED_MESSAGE).not.toMatch(/--allow|--manifest-file|unless|even with/i);
  });
});
