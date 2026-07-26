import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    globalSetup: ["./test/azurite.ts"],
    testTimeout: 30_000,
  },
});
