import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        d1Databases: ["DB"],
      },
    }),
  ],
  test: {
    include: ["packages/storage-cloudflare-d1/src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
