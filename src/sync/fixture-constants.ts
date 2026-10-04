// The fixture marker file name and its two words. This module has NO imports: `fixtures/generate-fixture-vault.ts`
// loads it with a plain `node` run (no build), and the guard removal (mvp-07b task 6.2) leaves it unchanged.

/** Marker file that flags a synthetic fixture vault (the guard is removed by the encrypted-pull change, mvp-07). */
export const FIXTURE_MARKER = ".ipfs-sync-fixture";

/** Marker text created by the user or the fixture generator. The only value that enables publish. */
export const FIXTURE_MARKER_VALUE = "fixture";

/** Marker text created by pull when it populated an empty destination. Enables pull, never publish. */
export const PULLED_MARKER_VALUE = "pulled-fixture";
