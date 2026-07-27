import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/storage-core/src/**/*.test.ts",
      "packages/storage-azure-tables/src/**/*.test.ts",
    ],
    exclude: ["**/dist/**", "**/node_modules/**"],
    globalSetup: ["./test/azurite.ts"],
    testTimeout: 30_000,
  },
});
