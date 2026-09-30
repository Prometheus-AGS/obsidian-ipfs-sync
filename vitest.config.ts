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
  },
});
