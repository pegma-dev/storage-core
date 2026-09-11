import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/storage-dynamodb/src/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    globalSetup: ["./test/dynamodb-local.ts"],
    testTimeout: 30_000,
  },
});
