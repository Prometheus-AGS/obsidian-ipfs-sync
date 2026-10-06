import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// E2E suite config (change mvp-09): discovers only `tests/e2e/**/*.e2e.ts`. The default gate's
// include (`tests/**/*.test.ts` in the root vitest.config.ts) never matches the `.e2e.ts` suffix,
// so the two configs are disjoint and the root config stays untouched.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("../support/obsidian-stub.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    environment: "node",
    // Live-node budgets (design decision 7): ~1.8 s PGlite boot per spawned CLI child, a 32 s
    // heaviest local scenario, plus real-network latency and Argon2id unlocks per pull.
    testTimeout: 240_000,
    hookTimeout: 300_000,
    // One ordered spec file owns the run root, the proxy and both devices; files must never
    // run in parallel against the shared node.
    fileParallelism: false,
  },
});
