import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(
  new URL("../scripts/release-registry-verify.mjs", import.meta.url),
);
const cliSource = (await readFile(cli, "utf8")).replace(/\r\n/gu, "\n");
const commands = ["preflight", "verify"] as const;

function actualEntryBody(): string {
  const marker = [
    "if (",
    "  process.argv[1] &&",
    "  resolve(process.argv[1]) === fileURLToPath(import.meta.url)",
    ") {",
    "",
  ].join("\n");
  const parts = cliSource.split(marker);
  if (parts.length !== 2 || !parts[1]!.trimEnd().endsWith("\n}"))
    throw new Error("The actual registry CLI entry guard was not found.");
  return parts[1]!.trimEnd().slice(0, -2);
}

async function runActualCli(
  command: string,
  changes: {
    readonly omit?: readonly string[];
    readonly overrides?: Readonly<Record<string, string>>;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "storage-registry-cli-"));
  const manifest = join(directory, "missing-package-manifest.json");
  try {
    // Synthetic parser inputs only. No release identity or crypto is claimed.
    // A nonexistent manifest refuses before registry, npm or proof operations.
    const fields = new Map([
      ["--manifest", manifest],
      ["--expected-release-commit", "a".repeat(40)],
      ["--expected-manifest-sha256", "b".repeat(64)],
      ["--output", join(directory, "verification-output")],
      ["--run-id", "12345"],
      ["--run-attempt", "1"],
    ]);
    for (const flag of changes.omit ?? []) fields.delete(flag);
    for (const [flag, value] of Object.entries(changes.overrides ?? {}))
      fields.set(flag, value);
    // Enter the actual file: importing an API never exercised its CLI cycle.
    const result = spawnSync(
      process.execPath,
      [
        cli,
        command,
        ...Array.from(fields).flatMap(([flag, value]) => [flag, value]),
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
          // In particular, missing-ID cases inherit no host GitHub fallback.
          ...changes.env,
        },
      },
    );
    return { result, manifest, entries: await readdir(directory) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("release registry CLI startup", () => {
  it.each(commands)(
    "%s reaches the missing-manifest error through the actual cyclic CLI modules",
    async (command) => {
      const f = await runActualCli(command);
      expect(f.result.error).toBeUndefined();
      expect(f.result.signal).toBeNull();
      expect(f.result.status, f.result.stderr).toBe(1);
      expect(f.result.stderr).toMatch(/\bENOENT\b/u);
      expect(f.result.stderr).toContain(f.manifest);
      expect(f.result.stderr).not.toMatch(/unsettled top-level await/iu);
      expect(f.result.stdout).toBe("");
      expect(f.entries).toEqual([]);
    },
  );

  it.each(
    commands.flatMap((command) =>
      ["--output", "--run-id", "--run-attempt"].map((flag) => ({
        command,
        flag,
      })),
    ),
  )(
    "$command rejects missing $flag before manifest I/O",
    async ({ command, flag }) => {
      const f = await runActualCli(command, { omit: [flag] });
      expect(f.result.error).toBeUndefined();
      expect(f.result.signal).toBeNull();
      expect(f.result.status, f.result.stderr).toBe(1);
      expect(f.result.stderr).toContain("usage: release-registry-verify.mjs");
      expect(f.result.stderr).not.toMatch(/ENOENT|unsettled top-level await/iu);
      expect(f.result.stdout).toBe("");
      expect(f.entries).toEqual([]);
    },
  );

  it.each([
    { command: "preflight", flag: "--run-id", value: "0" },
    { command: "verify", flag: "--run-attempt", value: "-1" },
    { command: "preflight", flag: "--run-id", value: "9007199254740992" },
    { command: "verify", flag: "--run-attempt", value: "1.5" },
  ])(
    "$command rejects $flag=$value before manifest I/O",
    async ({ command, flag, value }) => {
      const f = await runActualCli(command, { overrides: { [flag]: value } });
      expect(f.result.error).toBeUndefined();
      expect(f.result.signal).toBeNull();
      expect(f.result.status, f.result.stderr).toBe(1);
      expect(f.result.stderr).toContain("usage: release-registry-verify.mjs");
      expect(f.result.stderr).not.toMatch(/ENOENT|unsettled top-level await/iu);
      expect(f.result.stdout).toBe("");
      expect(f.entries).toEqual([]);
    },
  );

  it.each(commands)(
    "%s retains valid GitHub run-ID environment fallbacks",
    async (command) => {
      const f = await runActualCli(command, {
        omit: ["--run-id", "--run-attempt"],
        env: { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "2" },
      });
      expect(f.result.error).toBeUndefined();
      expect(f.result.signal).toBeNull();
      expect(f.result.status, f.result.stderr).toBe(1);
      expect(f.result.stderr).toMatch(/\bENOENT\b/u);
      expect(f.result.stderr).toContain(f.manifest);
      expect(f.result.stderr).not.toMatch(/usage:|unsettled top-level await/iu);
      expect(f.result.stdout).toBe("");
      expect(f.entries).toEqual([]);
    },
  );

  it("rejects an unknown command before manifest I/O", async () => {
    const f = await runActualCli("not-a-command");
    expect(f.result.error).toBeUndefined();
    expect(f.result.signal).toBeNull();
    expect(f.result.status, f.result.stderr).toBe(1);
    expect(f.result.stderr).toContain("usage: release-registry-verify.mjs");
    expect(f.result.stderr).not.toMatch(/ENOENT|unsettled top-level await/iu);
    expect(f.result.stdout).toBe("");
    expect(f.entries).toEqual([]);
  });
});

describe("actual CLI entry exit mapping, without verification", () => {
  it.each([
    { outcome: "fulfilled", status: 0, main: "async function main() {}" },
    {
      outcome: "rejected",
      status: 1,
      main: 'async function main() { throw new Error("synthetic entry failure", {cause: new Error("synthetic underlying cause")}); }',
    },
    {
      outcome: "unsettled",
      status: 13,
      main: "function main() { return new Promise(() => {}); }",
    },
  ])(
    "maps a $outcome main to exit $status using the verbatim entry body",
    async ({ outcome, status, main }) => {
      const directory = await mkdtemp(
        join(tmpdir(), "storage-registry-entry-"),
      );
      try {
        // The exact production guard BODY is executed with only main controlled.
        // This isolates completion/error handling, not a crypto or publish PASS.
        const result = spawnSync(
          process.execPath,
          ["--input-type=module", "-e", main + "\n" + actualEntryBody()],
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
        expect(result.status, result.stderr).toBe(status);
        expect(result.stdout).toBe("");
        if (outcome === "rejected") {
          expect(result.stderr).toContain("Error: synthetic entry failure");
          expect(result.stderr).toMatch(/\bat main\s*\(/u);
          expect(result.stderr).toContain("[cause]");
          expect(result.stderr).toContain("Error: synthetic underlying cause");
        } else {
          expect(result.stderr).toBe("");
        }
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
