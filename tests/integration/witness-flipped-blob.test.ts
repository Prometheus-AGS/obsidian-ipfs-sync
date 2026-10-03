// Mutation witness for the blob verification guard (mvp-07a task 6.1). The guard: every blob is decrypted segment by segment with
// authentication, and its size and sha256 are checked, before its plaintext may replace a vault file. The seam below removes it IN THIS
// FILE ONLY: the fetch writes what the node served and reports it as verified. Production code is not touched. The same driver and
// assertion as tests/integration/safety-guards.test.ts must then fail.
import { describe, expect, it, vi } from "vitest";
import { TEMP_DIR } from "../../src/sync/temp-files";
import { PLAN } from "../helpers/integration-devices";
import { assertFlippedBlobFailsAlone, expectAssertionFailure, runFlippedBlob } from "../helpers/safety-scenarios";

vi.mock("../../src/sync/blob-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sync/blob-fetch")>();
  return {
    ...actual,
    // MUTATION: no authentication, no size check, no hash check; the bytes the node served are the file.
    fetchBlobToTemp: async (deps: Parameters<typeof actual.fetchBlobToTemp>[0], input: Parameters<typeof actual.fetchBlobToTemp>[1]) => {
      const temp = `${TEMP_DIR}/${(deps.newId ?? (() => "unverified"))()}.part`;
      await deps.fs.write(temp, new Uint8Array(0));
      for await (const chunk of input.source.chunks) await deps.fs.append(temp, chunk as Uint8Array<ArrayBuffer>);
      return { temp, size: input.entry.size, sha256: input.entry.sha256 };
    },
  };
});

describe("witness: the flipped-blob scenario fails when blob verification is removed", () => {
  it("the tampered blob is written to the vault as if it were the file, so the guarded assertions throw", async () => {
    const observed = await runFlippedBlob();

    const failure = expectAssertionFailure(() => assertFlippedBlobFailsAlone(observed));
    // The first thing the guard gives is the list of integrity-failed paths: here it is empty where the flipped file belongs.
    expect(failure).toMatch(/expected \[\] to deeply equal/);

    // What the unguarded pull did: nothing was reported as failed and the tampered path now exists in the vault.
    expect(observed.outcome.kind).toBe("completed");
    if (observed.outcome.kind === "completed") expect(observed.outcome.result.settlement.integrityFailed).toEqual([]);
    expect(observed.texts[PLAN]).toBeDefined();
    expect(observed.texts[PLAN]).not.toBe(observed.published[PLAN]);
  });
});
