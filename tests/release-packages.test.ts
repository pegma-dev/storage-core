import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  RELEASE_PACKAGES,
  decidePublication,
  isolatedNpmEnvironment,
  lockVersionSatisfiesSpecifier,
  parseArguments,
  parsePnpmLockfileImporters,
  prepareRelease,
  publishPreparedRelease,
  smokePreparedRelease,
  validateLockImporter,
  validateReleaseTag,
  validateRepository,
  verifyReleaseInventory,
  verifyPreparedManifest,
} from "../scripts/release-packages.mjs";
import {
  inspectReleaseTarball,
  loadReusePolicy,
  preflightRegistry,
  registryReuseOrigin,
} from "../scripts/release-registry-verify.mjs";

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

    // Core/Azure040 and D1041 retain their original registry bytes. Dynamo044
    // is the reviewed runtime candidate; registration-only042 is no SDK.
    // Every adapter pins the port exactly where it was published.
    expect(manifests.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "@pegma/storage-core", version: "0.4.0" },
      { name: "@pegma/storage-azure-tables", version: "0.4.0" },
      { name: "@pegma/storage-cloudflare-d1", version: "0.4.1" },
      { name: "@pegma/storage-dynamodb", version: "0.4.4" },
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
    const nextJob = jobs.indexOf("\n  verify:", publishStart);
    const publish = jobs.slice(
      publishStart,
      nextJob === -1 ? undefined : nextJob,
    );
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
      "pegma-storage-dynamodb-0.4.3.tgz",
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
        RUNNER_ENVIRONMENT: "github-hosted",
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
      RUNNER_ENVIRONMENT: "github-hosted",
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

interface PreparedRecord {
  name: string;
  version: string;
  directory: string;
  tarball: string;
  size: number;
  shasum: string;
  sha256: string;
  integrity: string;
  publish: boolean;
  package: Record<string, unknown>;
  files: Array<{ path: string; size: number }>;
  origin: Record<string, unknown>;
}

interface PreparedManifest {
  schemaVersion: number;
  repository: string;
  gitCommit: string;
  releaseTag: string;
  registryPolicySha256: string;
  packages: PreparedRecord[];
}

function sourceArchive(metadata: Record<string, unknown>): Buffer {
  const files = new Map([
    ["package/package.json", JSON.stringify(metadata)],
    ["package/README.md", "Unsigned source-archive parser fixture"],
    ["package/LICENSE", "MIT"],
    ["package/dist/index.js", "export const fixture = true;"],
    ["package/dist/index.d.ts", "export declare const fixture: true;"],
  ]);
  const chunks: Buffer[] = [];
  for (const [path, text] of files) {
    const body = Buffer.from(text),
      header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(
      `${body.length.toString(8).padStart(11, "0")}\0`,
      124,
      "ascii",
    );
    header.write("00000000000\0", 136, "ascii");
    header.fill(32, 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function preparedSchema2() {
  const root = mkdtempSync(join(tmpdir(), "storage-schema2-"));
  const output = join(root, "prepared");
  mkdirSync(output);
  run(git, ["init", "--quiet"], root);
  run(git, ["config", "user.name", "Release Fixture"], root);
  run(git, ["config", "user.email", "release@example.invalid"], root);
  writeFileSync(join(root, "README.md"), "Fictional release source\n");
  run(git, ["add", "README.md"], root);
  run(
    git,
    ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
    root,
  );
  const gitCommit = run(git, ["rev-parse", "HEAD"], root);
  const { policy, sha256: registryPolicySha256 } = await loadReusePolicy();
  const packages: PreparedRecord[] = [];
  for (const entry of policy.packages) {
    const bytes = readFileSync(
      new URL(
        `./fixtures/release-registry/${entry.directory}-${entry.version}.tgz`,
        import.meta.url,
      ),
    );
    const inspected = inspectReleaseTarball(bytes);
    const tarball = `${entry.name.slice(1).replace("/", "-")}-${entry.version}.tgz`;
    writeFileSync(join(output, tarball), bytes);
    packages.push({
      name: entry.name,
      version: entry.version,
      directory: entry.directory,
      tarball,
      size: bytes.length,
      shasum: entry.shasum,
      sha256: entry.sha256,
      integrity: entry.integrity,
      publish: false,
      package: inspected.package,
      files: [...inspected.files],
      origin: { ...registryReuseOrigin(entry) },
    });
  }
  const metadata = JSON.parse(
    readFileSync(
      new URL("../packages/storage-dynamodb/package.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const sourceDirectory = join(root, "packages", "storage-dynamodb");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    join(sourceDirectory, "package.json"),
    JSON.stringify(metadata),
  );
  const bytes = sourceArchive(metadata),
    inspected = inspectReleaseTarball(bytes);
  const version = inspected.package.version;
  const releaseTag = `v${version}`;
  const tarball = `pegma-storage-dynamodb-${version}.tgz`;
  writeFileSync(join(output, tarball), bytes);
  packages.push({
    name: "@pegma/storage-dynamodb",
    version,
    directory: "storage-dynamodb",
    tarball,
    size: bytes.length,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    publish: true,
    files: [...inspected.files],
    package: inspected.package,
    origin: {
      kind: "source",
      repository: "pegma-dev/storage-core",
      gitCommit,
      releaseTag,
      directory: "storage-dynamodb",
    },
  });
  const manifest: PreparedManifest = {
    schemaVersion: 2,
    repository: "pegma-dev/storage-core",
    gitCommit,
    releaseTag,
    registryPolicySha256,
    packages,
  };
  const manifestPath = join(output, "package-manifest.json");
  const save = () =>
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  save();
  return { root, output, manifest, manifestPath, save };
}

describe("selected-source schema2 archives", () => {
  it.each(["reuse-verification", "consumer-verification"] as const)(
    "refuses a retained default %s namespace before repository or tool work",
    async (suffix) => {
      const root = mkdtempSync(join(tmpdir(), "storage-fresh-admission-"));
      const proof = join(root, `.release-${suffix}`);
      mkdirSync(proof);
      try {
        // This deliberately incomplete root has no package.json or Git state:
        // reaching repository admission would fail for a different reason.
        await expect(
          prepareRelease({ root, requireClean: true, skipSmoke: true }),
        ).rejects.toThrow(
          /release proof output already exists:.*preserve existing evidence and choose a fresh --output/u,
        );
        expect(existsSync(proof)).toBe(true);
        expect(existsSync(join(root, ".release"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("refuses occupied artifacts and explicit smoke proof before reading a repository or manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "storage-fresh-artifact-"));
    const output = join(root, ".release");
    mkdirSync(output);
    writeFileSync(join(output, "retained.txt"), "preserve me");
    const proof = join(root, "prior-proof");
    mkdirSync(proof);
    try {
      await expect(
        prepareRelease({ root, requireClean: true }),
      ).rejects.toThrow(/release output directory must be empty/u);
      await expect(
        smokePreparedRelease({
          manifest: join(root, "missing-manifest.json"),
          output: proof,
        }),
      ).rejects.toThrow(
        /preserve existing evidence and choose a fresh --output/u,
      );
      expect(readFileSync(join(output, "retained.txt"), "utf8")).toBe(
        "preserve me",
      );
      expect(existsSync(proof)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps exactly the default proof siblings ignored in a real clean checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "storage-default-ignore-"));
    try {
      const ignore = readFileSync(
        new URL("../.gitignore", import.meta.url),
        "utf8",
      );
      expect(ignore.split(/\r?\n/u)).toContain("/.release-reuse-verification/");
      expect(ignore.split(/\r?\n/u)).toContain(
        "/.release-consumer-verification/",
      );
      expect(ignore).not.toContain("/.release-*/");
      run(git, ["init", "--quiet"], root);
      run(git, ["config", "user.name", "Release Fixture"], root);
      run(git, ["config", "user.email", "release@example.invalid"], root);
      writeFileSync(join(root, ".gitignore"), ignore);
      run(git, ["add", ".gitignore"], root);
      run(
        git,
        ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
        root,
      );
      for (const name of [
        ".release",
        ".release-reuse-verification",
        ".release-consumer-verification",
      ]) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, "proof.json"), "{}\n");
      }
      expect(run(git, ["status", "--porcelain"], root)).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withholds every preflight decision when a reused package is unavailable after original-manifest verification", async () => {
    const f = await preparedSchema2();
    try {
      const expectedManifestSha256 = createHash("sha256")
        .update(readFileSync(f.manifestPath))
        .digest("hex");
      const options = {
        root: f.root,
        manifest: f.manifestPath,
        expectedReleaseCommit: f.manifest.gitCommit,
        expectedManifestSha256,
        runId: 12345,
        runAttempt: 2,
        output: join(f.root, "proof"),
      };
      const verified = await verifyPreparedManifest(f.manifestPath, options);
      const fetch = vi.fn(async () => new Response(null, { status: 404 }));
      const run = vi.fn();
      await expect(
        preflightRegistry(verified, options, { fetch, run }),
      ).rejects.toThrow(/original registry package is missing/u);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]).toEqual([
        "https://registry.npmjs.org/%40pegma%2Fstorage-core/0.4.0",
        expect.objectContaining({ redirect: "error" }),
      ]);
      expect(run).not.toHaveBeenCalled();
      expect(existsSync(options.output)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects Core043 source labeling over the genuine Core040 archive and package metadata", async () => {
    const f = await preparedSchema2();
    try {
      const record = f.manifest.packages[0]!;
      expect(record.package.version).toBe("0.4.0");
      const originalPath = join(f.output, record.tarball);
      record.version = "0.4.3";
      record.tarball = "pegma-storage-core-0.4.3.tgz";
      record.publish = true;
      record.origin = {
        kind: "source",
        repository: f.manifest.repository,
        gitCommit: f.manifest.gitCommit,
        releaseTag: f.manifest.releaseTag,
        directory: record.directory,
      };
      // Preserve the genuine old archive/hash and make the independent source
      // metadata agree with its old package.json, so those later comparisons
      // cannot mask the required record.version <-> package.version refusal.
      writeFileSync(join(f.output, record.tarball), readFileSync(originalPath));
      rmSync(originalPath);
      const sourceDirectory = join(f.root, "packages", "storage-core");
      mkdirSync(sourceDirectory, { recursive: true });
      writeFileSync(
        join(sourceDirectory, "package.json"),
        JSON.stringify(record.package),
      );
      f.save();
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow("prepared artifact metadata is invalid");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("verifies exactly three pinned originals and one source candidate without rebuilding the originals", async () => {
    const f = await preparedSchema2();
    try {
      const expectedManifestSha256 = createHash("sha256")
        .update(readFileSync(f.manifestPath))
        .digest("hex");
      const actual = await verifyPreparedManifest(f.manifestPath, {
        root: f.root,
        expectedReleaseCommit: f.manifest.gitCommit,
        expectedManifestSha256,
      });
      expect(actual).toEqual(f.manifest);
      expect(f.manifest.packages.map(({ publish }) => publish)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      expect(f.manifest.packages[0]!.origin.sourceCommit).not.toBe(
        f.manifest.gitCommit,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects independent artifact-digest, current-source and policy swaps", async () => {
    const f = await preparedSchema2();
    try {
      await expect(
        verifyPreparedManifest(f.manifestPath, {
          root: f.root,
          expectedManifestSha256: "0".repeat(64),
        }),
      ).rejects.toThrow(/digest/u);
      await expect(
        verifyPreparedManifest(f.manifestPath, {
          root: f.root,
          expectedReleaseCommit: "0".repeat(40),
        }),
      ).rejects.toThrow(/checkout/u);
      f.manifest.registryPolicySha256 = "0".repeat(64);
      f.save();
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow(/policy digest/u);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("enforces every closed origin key and the source/original-source distinction", async () => {
    const f = await preparedSchema2();
    try {
      for (const record of f.manifest.packages) {
        const original = structuredClone(record.origin);
        for (const key of Object.keys(original)) {
          record.origin = { ...original };
          delete record.origin[key];
          f.save();
          await expect(
            verifyPreparedManifest(f.manifestPath, { root: f.root }),
          ).rejects.toThrow(/origin/u);
        }
        record.origin = { ...original, extra: "not admitted" };
        f.save();
        await expect(
          verifyPreparedManifest(f.manifestPath, { root: f.root }),
        ).rejects.toThrow(/origin/u);
        record.origin = original;
      }
      f.manifest.packages[0]!.origin.sourceCommit = f.manifest.gitCommit;
      f.save();
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow(/independent policy/u);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects source/reuse relabeling, package-order swaps and unexpected top-level fields", async () => {
    const f = await preparedSchema2();
    try {
      f.manifest.packages[0]!.publish = true;
      f.save();
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow(/source origin/u);
      f.manifest.packages[0]!.publish = false;
      [f.manifest.packages[0], f.manifest.packages[1]] = [
        f.manifest.packages[1]!,
        f.manifest.packages[0]!,
      ];
      f.save();
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow(/inventory/u);
      [f.manifest.packages[0], f.manifest.packages[1]] = [
        f.manifest.packages[1]!,
        f.manifest.packages[0]!,
      ];
      writeFileSync(
        f.manifestPath,
        JSON.stringify({ ...f.manifest, trusted: true }),
      );
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow(/identity/u);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects changed selected exports/dependencies and changed literal original tar bytes", async () => {
    const f = await preparedSchema2();
    try {
      const selected = f.manifest.packages[3]!;
      const original = structuredClone(selected.package);
      selected.package = {
        ...original,
        dependencies: { "@pegma/storage-core": "0.4.1" },
      };
      f.save();
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow(/source/u);
      selected.package = { ...original, exports: { ".": "./private.js" } };
      f.save();
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow(/source/u);
      selected.package = original;
      f.save();
      const first = f.manifest.packages[0]!,
        path = join(f.output, first.tarball),
        bytes = readFileSync(path);
      bytes[0] = bytes[0]! ^ 1;
      writeFileSync(path, bytes);
      await expect(
        verifyPreparedManifest(f.manifestPath, { root: f.root }),
      ).rejects.toThrow();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses the alternate publisher before even reading a malicious or missing artifact", async () => {
    await expect(
      publishPreparedRelease({
        manifest: "does-not-exist",
        root: "does-not-exist",
      }),
    ).rejects.toThrow(/disabled.*protected GitHub release workflow/u);
    const source = readFileSync(
      new URL("../scripts/release-packages.mjs", import.meta.url),
      "utf8",
    );
    const body =
      /export async function publishPreparedRelease\([^]*?\n\}/u.exec(
        source,
      )?.[0];
    expect(body).toBeDefined();
    expect(body).not.toContain("runNpm");
    expect(body).not.toContain("readFile");
    expect(body).not.toContain("queryRegistry");
  });
});
