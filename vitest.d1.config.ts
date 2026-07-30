import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        // Pinned on purpose. Left unset, the pool defaults to today's date,
        // so the suite stops starting the day the calendar moves past the
        // installed workerd's newest supported compatibility date.
        compatibilityDate: "2026-07-28",
        d1Databases: ["DB"],
      },
    }),
  ],
  test: {
    include: ["packages/storage-cloudflare-d1/src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
