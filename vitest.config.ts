import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `obsidian` only exists inside the running app; tests get a recording stub (never bundled).
    alias: { obsidian: fileURLToPath(new URL("./tests/support/obsidian-stub.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts", "cli/**/*.test.ts"],
    environment: "node",
    // Publish tests derive keys with real Argon2id (at the smallest allowed cost) and encrypt real data; under a loaded
    // machine a test can take several seconds, so the default 5 s would fail for reasons that are not the test's.
    testTimeout: 20_000,
  },
});
