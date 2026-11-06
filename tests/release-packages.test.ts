import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  decidePublication,
  isolatedNpmEnvironment,
  lockVersionSatisfiesSpecifier,
  parseArguments,
  parsePnpmLockfileImporters,
  validateLockImporter,
  validateReleaseTag,
  validateRepository,
  verifyReleaseInventory,
} from "../scripts/release-packages.mjs";

const git = process.platform === "win32" ? "git.exe" : "git";
const releaseVersion = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "packages", "storage-core", "package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

function run(command: string, arguments_: string[], cwd?: string): string {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("release package metadata", () => {
  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
  });

  it("supports packing before a separate smoke run", () => {
    expect(parseArguments(["--skip-smoke", "--output", ".release"])).toEqual({
      skipSmoke: true,
      output: ".release",
    });
  });

  it("keeps the exact public package inventory", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual([
      "@pegma/storage-core",
      "@pegma/storage-azure-tables",
      "@pegma/storage-cloudflare-d1",
      "@pegma/storage-dynamodb",
    ]);
  });

  it("keeps every adapter pinned to the exact released core version", () => {
    const manifests = RELEASE_PACKAGES.map(({ directory }) =>
      JSON.parse(
        readFileSync(
          join(process.cwd(), "packages", directory, "package.json"),
          "utf8",
        ),
      ),
    ) as Array<{
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      scripts?: { prepack?: string };
    }>;

    // The scan contract released core, Azure, and D1 at 0.4.0. D1 carries
    // a patch of its own; DynamoDB is the next unused repository-wide
    // number. Every adapter pins the port exactly where it was published.
    expect(manifests.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "@pegma/storage-core", version: "0.4.0" },
      { name: "@pegma/storage-azure-tables", version: "0.4.0" },
      { name: "@pegma/storage-cloudflare-d1", version: "0.4.1" },
      { name: "@pegma/storage-dynamodb", version: "0.4.2" },
    ]);
    for (const adapter of manifests.slice(1)) {
      expect(adapter.dependencies?.["@pegma/storage-core"]).toBe("0.4.0");
    }
    for (const manifest of manifests) {
      expect(manifest.scripts?.prepack).toBe("npm run build");
    }
  });

  it("reads workspace inventory and link pins from pnpm-lock.yaml", () => {
    expect(existsSync(join(process.cwd(), "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(process.cwd(), "package-lock.json"))).toBe(false);

    const importers = parsePnpmLockfileImporters(`importers:

  .:
    devDependencies:
      prettier:
        specifier: ^3.9.6
        version: 3.9.6

  packages/storage-core: {}

  packages/storage-azure-tables:
    dependencies:
      '@pegma/storage-core':
        specifier: 0.4.0
        version: link:../storage-core

packages:
  prettier@3.9.6:
    resolution: {integrity: sha512-example}
`);
    expect(Object.keys(importers)).toEqual([
      ".",
      "packages/storage-core",
      "packages/storage-azure-tables",
    ]);
    expect(
      importers["packages/storage-azure-tables"]?.dependencies?.[
        "@pegma/storage-core"
      ],
    ).toEqual({
      specifier: "0.4.0",
      version: "link:../storage-core",
    });

    const live = parsePnpmLockfileImporters(
      readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8"),
    );
    expect(
      live["packages/storage-azure-tables"]?.dependencies?.[
        "@pegma/storage-core"
      ],
    ).toEqual({
      specifier: "0.4.0",
      version: "link:../storage-core",
    });
    expect(
      live["packages/storage-cloudflare-d1"]?.dependencies?.[
        "@pegma/storage-core"
      ],
    ).toEqual({
      specifier: "0.4.0",
      version: "link:../storage-core",
    });
    expect(
      live["packages/storage-dynamodb"]?.dependencies?.["@pegma/storage-core"],
    ).toEqual({
      specifier: "0.4.0",
      version: "link:../storage-core",
    });
    expect(
      live["packages/storage-azure-tables"]?.dependencies?.[
        "@azure/data-tables"
      ],
    ).toEqual({
      specifier: "^13.3.1",
      version: "13.3.2",
    });
    expect(
      live["packages/storage-dynamodb"]?.dependencies?.[
        "@aws-sdk/client-dynamodb"
      ],
    ).toEqual({
      specifier: "^3.1097.0",
      version: "3.1130.0",
    });
  });

  it("decodes quoted lockfile scalars before comparing pins", () => {
    const importers = parsePnpmLockfileImporters(`importers:

  packages/example:
    dependencies:
      'quoted':
        specifier: '1'
        version: "1.0.0"
    peerDependencies:
      peer:
        specifier: '*'
        version: 2.0.0
`);
    expect(importers["packages/example"]?.dependencies?.quoted).toEqual({
      specifier: "1",
      version: "1.0.0",
    });
    expect(importers["packages/example"]?.peerDependencies?.peer).toEqual({
      specifier: "*",
      version: "2.0.0",
    });
  });

  it("accepts resolved versions that satisfy a range and exact pins exactly", () => {
    expect(lockVersionSatisfiesSpecifier("^1.2.0", "1.2.3")).toBe(true);
    expect(lockVersionSatisfiesSpecifier("^13.3.1", "13.3.2")).toBe(true);
    expect(lockVersionSatisfiesSpecifier("0.4.0", "0.4.0")).toBe(true);
    expect(lockVersionSatisfiesSpecifier("0.4.0", "link:../storage-core")).toBe(
      true,
    );
    expect(lockVersionSatisfiesSpecifier("0.4.0", "0.4.1")).toBe(false);
    expect(lockVersionSatisfiesSpecifier("^1.2.0", "2.0.0")).toBe(false);
    expect(lockVersionSatisfiesSpecifier("^0", "0.5.0")).toBe(true);
    expect(lockVersionSatisfiesSpecifier("^0", "1.0.0")).toBe(false);
    expect(lockVersionSatisfiesSpecifier("^0.0", "0.0.5")).toBe(true);
    expect(lockVersionSatisfiesSpecifier("^0.0", "0.1.0")).toBe(false);
    expect(lockVersionSatisfiesSpecifier("^0.0.3", "0.0.3")).toBe(true);
    expect(lockVersionSatisfiesSpecifier("^0.0.3", "0.0.4")).toBe(false);
    expect(lockVersionSatisfiesSpecifier("1.0.0-rc.1", "1.0.0-rc.1")).toBe(
      true,
    );
    expect(
      lockVersionSatisfiesSpecifier("1.0.0-rc.1", "1.0.0-rc.1(foo@1.0.0)"),
    ).toBe(true);
    expect(lockVersionSatisfiesSpecifier("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(lockVersionSatisfiesSpecifier("1.2.3", "1.2.3-rc.1")).toBe(false);
    expect(
      lockVersionSatisfiesSpecifier("1.2.3", "1.2.3-rc.1(foo@1.0.0)"),
    ).toBe(false);
  });

  it("does not require importer.peerDependencies, which pnpm does not record", () => {
    expect(() =>
      validateLockImporter(
        {
          dependencies: {
            leftpad: { specifier: "1.0.0", version: "1.0.0" },
          },
        },
        {
          name: "@pegma/example",
          version: "0.0.0",
          dependencies: { leftpad: "1.0.0" },
          peerDependencies: { vitest: "^4.1.10" },
        },
        "example",
      ),
    ).not.toThrow();
    expect(() =>
      validateLockImporter(
        {
          peerDependencies: {
            vitest: { specifier: "^4.1.10", version: "4.1.10" },
          },
        },
        { name: "@pegma/example", version: "0.0.0" },
        "example",
      ),
    ).not.toThrow();
    expect(() =>
      validateLockImporter(
        {},
        {
          name: "@pegma/example",
          version: "0.0.0",
          dependencies: { leftpad: "1.0.0" },
          peerDependencies: { vitest: "^4.1.10" },
        },
        "example",
      ),
    ).toThrow("dependencies.leftpad");
  });

  it("validates package manifests and the lockfile together", async () => {
    await expect(validateRepository()).resolves.toBeDefined();
  });

  it("requires the release tag to match a public package version", async () => {
    await expect(validateRepository({ releaseTag: "v9.9.9" })).rejects.toThrow(
      "does not match any public package version",
    );
    await expect(
      validateRepository({
        releaseTag: `v${releaseVersion}`,
        releasePrerelease: true,
      }),
    ).rejects.toThrow("prereleases cannot publish packages");
  });
});

describe("release source authentication", () => {
  it("accepts only an approved signed annotated tag at the event commit", () => {
    const root = mkdtempSync(join(tmpdir(), "storage-release-tag-"));
    try {
      run(git, ["init", "--quiet"], root);
      run(git, ["config", "user.name", "Release Test"], root);
      run(git, ["config", "user.email", "release@example.com"], root);
      writeFileSync(join(root, "README.md"), "release test\n");
      run(git, ["add", "README.md"], root);
      run(git, ["commit", "--quiet", "-m", "release"], root);
      run(git, ["branch", "-M", "main"], root);
      run(git, ["update-ref", "refs/remotes/origin/main", "HEAD"], root);
      const releaseCommit = run(git, ["rev-parse", "HEAD"], root);

      const signingKey = join(root, "release-signing-key");
      run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "release@example.com",
        "-f",
        signingKey,
      ]);
      const allowedSigners = join(root, "allowed-signers");
      writeFileSync(
        allowedSigners,
        `release@example.com ${readFileSync(`${signingKey}.pub`, "utf8").trim()}\n`,
      );
      run(git, ["config", "gpg.format", "ssh"], root);
      run(git, ["config", "user.signingkey", signingKey], root);
      run(git, ["config", "gpg.ssh.allowedSignersFile", allowedSigners], root);

      run(git, ["tag", "--sign", "v0.1.0", "--message", "signed"], root);
      expect(
        validateReleaseTag({
          root,
          releaseTag: "v0.1.0",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toEqual({ headCommit: releaseCommit, releaseTag: "v0.1.0" });

      run(git, ["tag", "v0.1.1"], root);
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.1.1",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("annotated tag object");

      run(
        git,
        [
          "-c",
          "commit.gpgsign=false",
          "tag",
          "--annotate",
          "v0.1.2",
          "--message",
          "unsigned",
        ],
        root,
      );
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.1.2",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("not valid for an approved signer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps preparation outside the OIDC-enabled publisher job", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const jobsMarker = "\njobs:\n";
    const jobsIndex = workflow.indexOf(jobsMarker);
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    const header = workflow.slice(0, jobsIndex);
    const jobs = workflow.slice(jobsIndex + jobsMarker.length);
    const prepareStart = jobs.indexOf("  prepare:");
    const publishStart = jobs.indexOf("\n  publish:");
    expect(header).not.toContain("id-token: write");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(prepareStart);
    const prepare = jobs.slice(prepareStart, publishStart);
    const publish = jobs.slice(publishStart);
    expect(prepare).not.toContain("id-token: write");
    expect(prepare).toContain("--skip-smoke");
    expect(prepare).toContain("include-hidden-files: false");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm install");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toContain("corepack");
    expect(publish).not.toContain("pnpm");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("scripts/release-packages.mjs");
    expect(publish).toContain('"--ignore-scripts"');
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("retention-days: 30");
  });
});

describe("prepared release files", () => {
  function preparedDirectory(): {
    readonly root: string;
    readonly manifestPath: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "pegma-release-files-"));
    const packages = [
      "pegma-storage-core-0.4.0.tgz",
      "pegma-storage-azure-tables-0.4.0.tgz",
      "pegma-storage-cloudflare-d1-0.4.1.tgz",
      "pegma-storage-dynamodb-0.4.2.tgz",
    ].map((tarball) => ({ tarball }));
    for (const { tarball } of packages) {
      writeFileSync(join(root, tarball), tarball);
    }
    const manifestPath = join(root, "package-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ packages }));
    return { root, manifestPath };
  }

  it("accepts exactly the manifest and four regular tarballs", async () => {
    const { root, manifestPath } = preparedDirectory();
    try {
      const manifest = (await verifyReleaseInventory(manifestPath)) as {
        packages: unknown[];
      };
      expect(manifest.packages).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects extra files and directories", async () => {
    const first = preparedDirectory();
    try {
      writeFileSync(join(first.root, "extra.txt"), "extra");
      await expect(verifyReleaseInventory(first.manifestPath)).rejects.toThrow(
        /inventory/,
      );
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }

    const second = preparedDirectory();
    try {
      mkdirSync(join(second.root, "nested"));
      await expect(verifyReleaseInventory(second.manifestPath)).rejects.toThrow(
        /inventory/,
      );
    } finally {
      rmSync(second.root, { recursive: true, force: true });
    }
  });

  it("keeps workflow identity variables and replaces npm configuration", () => {
    const selected = isolatedNpmEnvironment(
      {
        PATH: "bin",
        HOME: "home",
        CI: "1",
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
        NPM_TOKEN: "not-kept",
        NODE_AUTH_TOKEN: "not-kept",
        NODE_OPTIONS: "not-kept",
        NODE_EXTRA_CA_CERTS: "not-kept",
        HTTPS_PROXY: "not-kept",
        npm_config_registry: "not-kept",
      },
      "/private/userconfig",
      "/private/globalconfig",
    );

    expect(selected).toEqual({
      PATH: "bin",
      HOME: "home",
      CI: "1",
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
      NPM_CONFIG_USERCONFIG: "/private/userconfig",
      NPM_CONFIG_GLOBALCONFIG: "/private/globalconfig",
    });
  });
});

describe("retry-safe publication", () => {
  const integrity = "sha512-cHJlcGFyZWQtdGFyYmFsbA==";

  it("publishes an absent version", () => {
    expect(decidePublication(integrity, null)).toBe("publish");
  });

  it("skips a byte-identical existing version", () => {
    expect(decidePublication(integrity, integrity)).toBe("skip");
  });

  it("rejects an existing version with different bytes", () => {
    expect(() => decidePublication(integrity, "sha512-ZGlmZmVyZW50")).toThrow(
      "different tarball integrity",
    );
  });
});
