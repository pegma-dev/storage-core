import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(
  new URL("../scripts/release-registry-verify.mjs", import.meta.url),
);

describe("release registry CLI startup", () => {
  it.each(["preflight", "verify"] as const)(
    "%s reaches the missing-manifest error through the actual cyclic CLI modules",
    async (command) => {
      const directory = await mkdtemp(join(tmpdir(), "storage-registry-cli-"));
      const manifest = join(directory, "missing-package-manifest.json");
      try {
        // These are synthetic parser inputs, not release identities or proof.
        // The missing manifest must refuse before registry, npm or crypto work.
        // Enter the actual file directly: importing the exported API would not
        // exercise its CLI guard or the former top-level-await import cycle.
        const result = spawnSync(
          process.execPath,
          [
            cli,
            command,
            "--manifest",
            manifest,
            "--expected-release-commit",
            "a".repeat(40),
            "--expected-manifest-sha256",
            "b".repeat(64),
            "--output",
            join(directory, "verification-output"),
            "--run-id",
            "12345",
            "--run-attempt",
            "1",
          ],
          {
            cwd: directory,
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 128 * 1024,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              HOME: directory,
              TMP: directory,
              TEMP: directory,
            },
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toMatch(/\bENOENT\b/u);
        expect(result.stderr).toContain(manifest);
        expect(result.stderr).not.toMatch(/unsettled top-level await/iu);
        expect(result.stdout).toBe("");
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
