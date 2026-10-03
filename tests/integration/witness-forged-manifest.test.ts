// Mutation witness for the forged-manifest guard (mvp-07a task 6.1). The guard: a `manifest.enc` that does not authenticate under the
// unlocked vault key stops the pull before any blob is requested. The seam below removes it IN THIS FILE ONLY, by replacing the module
// export the pull calls: a file that fails authentication is read as the plain-text manifest it claims to be. Production code is not
// touched. The same driver and assertion as tests/integration/safety-guards.test.ts must then fail.
import { describe, expect, it, vi } from "vitest";
import { assertForgedManifestRefused, expectAssertionFailure, runForgedManifest } from "../helpers/safety-scenarios";

vi.mock("../../src/sync/encrypted-manifest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sync/encrypted-manifest")>();
  return {
    ...actual,
    decodeManifestFile: async (keys: Parameters<typeof actual.decodeManifestFile>[0], file: Uint8Array) => {
      try {
        return await actual.decodeManifestFile(keys, file);
      } catch (error) {
        // MUTATION: authentication failure is ignored; the node's bytes are trusted as a plain-text manifest.
        try {
          return await actual.parseManifestV2(keys, file);
        } catch {
          throw error;
        }
      }
    },
  };
});

describe("witness: the forged-manifest scenario fails when manifest authentication is removed", () => {
  it("a plain-text manifest served as manifest.enc is accepted and its blobs requested, so the guarded assertions throw", async () => {
    const observed = await runForgedManifest("plaintext");

    const failure = expectAssertionFailure(() => assertForgedManifestRefused(observed));
    expect(failure).toContain("manifest-not-authentic"); // it fails at the first thing the guard gives: the stop

    // What the unguarded pull did: it took the hostile manifest, asked the node for blobs, and wrote the vault.
    expect(observed.outcome.kind).toBe("completed");
    expect(observed.blobReads.length).toBeGreaterThan(0);
    expect(observed.hostMutations.length).toBeGreaterThan(0);
  });
});
