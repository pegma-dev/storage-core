import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  REGISTRY,
  assertTrustedPublishingEnvironment,
  canonicalTarball,
  downloadRegistryArtifact,
  inspectReleaseTarball,
  isolatedVerificationEnvironment,
  loadReusePolicy,
  registryReuseOrigin,
  verifyProvenanceAudit,
} from "../scripts/release-registry-verify.mjs";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/release-registry/${name}`, import.meta.url));
const commit = "a".repeat(40);
const identity = {
  gitCommit: commit,
  releaseTag: "v0.4.3",
  runId: 12345,
  runAttempt: 2,
};
const digest = (
  bytes: Buffer,
  algorithm = "sha256",
  encoding: "hex" | "base64" = "hex",
) => createHash(algorithm).update(bytes).digest(encoding);

function packageJson() {
  return {
    name: "@pegma/storage-dynamodb",
    version: "0.4.3",
    license: "MIT",
    type: "module",
    engines: { node: ">=22" },
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: "git+https://github.com/pegma-dev/storage-core.git",
      directory: "packages/storage-dynamodb",
    },
    exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    dependencies: { "@pegma/storage-core": "0.4.0" },
  };
}

// These small unsigned archives exercise the real bounded tar parser. They
// never stand in for the pinned original archives or a provenance audit.
function archive(
  additions: Array<{ path: string; body: string; type?: string }> = [],
  metadata: object = packageJson(),
): Buffer {
  const entries = [
    { path: "package/package.json", body: JSON.stringify(metadata) },
    { path: "package/README.md", body: "Fictional parser fixture" },
    { path: "package/LICENSE", body: "MIT" },
    { path: "package/dist/index.js", body: "export const fixture = true;" },
    {
      path: "package/dist/index.d.ts",
      body: "export declare const fixture: true;",
    },
    ...additions,
  ];
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
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
    header.write(entry.type ?? "0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function syntheticRecord(bytes = archive()) {
  const metadata = packageJson();
  return {
    name: metadata.name,
    version: metadata.version,
    size: bytes.length,
    sha256: digest(bytes),
    shasum: digest(bytes, "sha1"),
    integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
    tarballUrl: canonicalTarball(metadata),
  };
}

function downloadPorts(record = syntheticRecord(), bytes = archive()) {
  const metadata = {
    name: record.name,
    version: record.version,
    dist: {
      integrity: record.integrity,
      shasum: record.shasum,
      tarball: record.tarballUrl,
      // Presence is not authentication; npm's real signature audit is separate.
      signatures: [
        { keyid: "parser-fixture", sig: "not-a-verified-signature" },
      ],
    },
  };
  const fetch = vi.fn(async (url: string | URL | Request) =>
    String(url) === record.tarballUrl
      ? new Response(new Uint8Array(bytes))
      : Response.json(metadata),
  );
  return { metadata, fetch };
}

interface BundleFixture {
  predicateType: string;
  bundle: {
    dsseEnvelope: { payloadType: string; payload: string };
    verificationMaterial: unknown;
  };
}

async function provenanceFixture() {
  const { policy } = await loadReusePolicy();
  const entry = policy.packages[0]!;
  const record = {
    ...entry,
    origin: registryReuseOrigin(entry),
    publish: false,
    tarball: `${entry.name.slice(1).replace("/", "-")}-${entry.version}.tgz`,
    ...inspectReleaseTarball(
      fixture(`${entry.directory}-${entry.version}.tgz`),
    ),
  };
  const bundle = JSON.parse(
    fixture("core040-slsa.json").toString("utf8"),
  ) as BundleFixture;
  // Deliberately a trusted-audit stub at the pure claim-validator boundary.
  // The genuine public bundle is not cryptographically verified by this test.
  const audit = {
    invalid: [] as unknown[],
    missing: [] as unknown[],
    verified: [
      {
        name: entry.name,
        version: entry.version,
        location: `node_modules/${entry.name}`,
        registry: REGISTRY,
        attestationBundles: [bundle],
      },
    ],
  };
  return { audit, record, policy };
}

function changeClaim(bundle: BundleFixture, path: string[], value: unknown) {
  const statement = JSON.parse(
    Buffer.from(bundle.bundle.dsseEnvelope.payload, "base64").toString("utf8"),
  ) as Record<string, unknown>;
  let target = statement;
  for (const key of path.slice(0, -1))
    target = target[key] as Record<string, unknown>;
  target[path.at(-1)!] = value;
  bundle.bundle.dsseEnvelope.payload = Buffer.from(
    JSON.stringify(statement),
  ).toString("base64");
}

describe("registry reuse source policy", () => {
  it("pins the original literal archives and their original publishing sources", async () => {
    const { policy, sha256 } = await loadReusePolicy();
    expect(sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(policy.repository).toBe("pegma-dev/storage-core");
    expect(
      policy.packages.map(({ name, version }) => `${name}@${version}`),
    ).toEqual([
      "@pegma/storage-core@0.4.0",
      "@pegma/storage-azure-tables@0.4.0",
      "@pegma/storage-cloudflare-d1@0.4.1",
    ]);
    let total = 0;
    for (const entry of policy.packages) {
      const bytes = fixture(`${entry.directory}-${entry.version}.tgz`);
      total += bytes.length;
      expect(bytes.length).toBe(entry.size);
      expect(digest(bytes)).toBe(entry.sha256);
      expect(digest(bytes, "sha1")).toBe(entry.shasum);
      expect(`sha512-${digest(bytes, "sha512", "base64")}`).toBe(
        entry.integrity,
      );
      const inspected = inspectReleaseTarball(bytes);
      expect(inspected.package.name).toBe(entry.name);
      expect(inspected.package.version).toBe(entry.version);
      expect(registryReuseOrigin(entry)).toEqual({
        kind: "registryReuse",
        registry: REGISTRY,
        policyEntry: `${entry.name}@${entry.version}`,
        tarballUrl: entry.tarballUrl,
        sourceCommit: entry.sourceCommit,
        sourceTag: entry.sourceTag,
        workflowPath: ".github/workflows/publish.yml",
        originalRunId: entry.originalRunId,
        originalRunAttempt: entry.originalRunAttempt,
      });
      expect(entry.sourceCommit).not.toBe(commit);
    }
    expect(total).toBe(47126);
  });

  it("inspects the actual public exports and excludes packed tests", () => {
    const inspected = inspectReleaseTarball(archive());
    expect(inspected.package.dependencies).toEqual({
      "@pegma/storage-core": "0.4.0",
    });
    expect(inspected.files.map(({ path }) => path)).toEqual(
      [
        "dist/index.d.ts",
        "dist/index.js",
        "LICENSE",
        "package.json",
        "README.md",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it.each([
    "package/../escape.js",
    "package/dist/../escape.js",
    "package/dist/test.test.js",
    "elsewhere/index.js",
  ])("rejects unreviewed archive entry %s", (path) => {
    expect(() =>
      inspectReleaseTarball(archive([{ path, body: "unsafe" }])),
    ).toThrow();
  });

  it("rejects links and duplicate entries rather than extracting them", () => {
    expect(() =>
      inspectReleaseTarball(
        archive([{ path: "package/dist/link.js", body: "", type: "2" }]),
      ),
    ).toThrow(/safe regular/u);
    expect(() =>
      inspectReleaseTarball(
        archive([{ path: "package/LICENSE", body: "duplicate" }]),
      ),
    ).toThrow(/identities/u);
  });

  it("rejects missing exports, missing exported files and registration-only metadata", () => {
    expect(() =>
      inspectReleaseTarball(archive([], { ...packageJson(), exports: {} })),
    ).toThrow(/exports/u);
    expect(() =>
      inspectReleaseTarball(
        archive([], {
          ...packageJson(),
          exports: { ".": "./dist/missing.js" },
        }),
      ),
    ).toThrow(/entry/u);
    expect(() =>
      inspectReleaseTarball(
        archive([], {
          name: "@pegma/storage-dynamodb",
          version: "0.4.2",
          license: "MIT",
        }),
      ),
    ).toThrow();
  });

  it("bounds compressed input and expanded archive records", () => {
    expect(() =>
      inspectReleaseTarball(Buffer.alloc(4 * 1024 * 1024 + 1)),
    ).toThrow(/bound/u);
    expect(() =>
      inspectReleaseTarball(
        archive([
          {
            path: "package/dist/large.js",
            body: "x".repeat(4 * 1024 * 1024 + 1),
          },
        ]),
      ),
    ).toThrow(/bound/u);
  });
});

describe("canonical registry bytes", () => {
  it("accepts only the exact canonical metadata and literal archive", async () => {
    const bytes = archive(),
      record = syntheticRecord(bytes),
      ports = downloadPorts(record, bytes);
    const result = await downloadRegistryArtifact(record, ports);
    expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
    expect(ports.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${REGISTRY}${encodeURIComponent(record.name)}/${record.version}`,
      record.tarballUrl,
    ]);
  });

  it.each(["name", "version", "integrity", "shasum", "tarball", "signatures"])(
    "refuses changed registry %s before accepting bytes",
    async (field) => {
      const bytes = archive(),
        record = syntheticRecord(bytes),
        ports = downloadPorts(record, bytes);
      if (field === "name" || field === "version")
        ports.metadata[field] = "changed";
      else if (field === "signatures") ports.metadata.dist.signatures = [];
      else (ports.metadata.dist as Record<string, unknown>)[field] = "changed";
      await expect(downloadRegistryArtifact(record, ports)).rejects.toThrow(
        /metadata/u,
      );
      expect(ports.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses altered tar bytes even when self-declared metadata agrees", async () => {
    const bytes = archive(),
      record = syntheticRecord(bytes);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] = 1;
    await expect(
      downloadRegistryArtifact(record, downloadPorts(record, changed)),
    ).rejects.toThrow(/original bytes/u);
  });

  it("refuses missing reused versions and non404 registry outages", async () => {
    for (const status of [404, 429, 500]) {
      await expect(
        downloadRegistryArtifact(syntheticRecord(), {
          fetch: async () => new Response(null, { status }),
        }),
      ).rejects.toThrow(/unavailable/u);
    }
    await expect(
      downloadRegistryArtifact(syntheticRecord(), {
        fetch: async () => {
          throw new Error("fictional transport outage");
        },
      }),
    ).rejects.toThrow(/availability is unknown/u);
  });
});

describe("trusted npm audit claim boundary", () => {
  it("uses the genuine original certificate/SLSA fixture and preserves its old source and physical writer", async () => {
    const { audit, record, policy } = await provenanceFixture();
    const facts = verifyProvenanceAudit(audit, [record], identity, policy);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      name: record.name,
      sourceCommit: record.origin.sourceCommit,
      sourceTag: "v0.4.0",
      runId: 30334062325,
      attempt: 1,
    });
  });

  it("rejects missing or failed npm ECDSA/Sigstore verification results", async () => {
    const { audit, record, policy } = await provenanceFixture();
    for (const changed of [
      undefined,
      {},
      { ...audit, invalid: [{}] },
      { ...audit, missing: [{}] },
      { ...audit, verified: [] },
    ]) {
      expect(() =>
        verifyProvenanceAudit(changed, [record], identity, policy),
      ).toThrow();
    }
  });

  it.each([
    [
      "repository",
      [
        "predicate",
        "buildDefinition",
        "externalParameters",
        "workflow",
        "repository",
      ],
      "https://github.com/other/repo",
    ],
    [
      "workflow",
      [
        "predicate",
        "buildDefinition",
        "externalParameters",
        "workflow",
        "path",
      ],
      ".github/workflows/other.yml",
    ],
    [
      "tag",
      ["predicate", "buildDefinition", "externalParameters", "workflow", "ref"],
      "refs/tags/v0.4.3",
    ],
    [
      "owner",
      [
        "predicate",
        "buildDefinition",
        "internalParameters",
        "github",
        "repository_owner_id",
      ],
      "1",
    ],
    [
      "repository ID",
      [
        "predicate",
        "buildDefinition",
        "internalParameters",
        "github",
        "repository_id",
      ],
      "1",
    ],
    [
      "source",
      [
        "predicate",
        "buildDefinition",
        "resolvedDependencies",
        "0",
        "digest",
        "gitCommit",
      ],
      commit,
    ],
    [
      "builder",
      ["predicate", "runDetails", "builder", "id"],
      "https://example.invalid/runner",
    ],
    [
      "writer",
      ["predicate", "runDetails", "metadata", "invocationId"],
      "https://github.com/pegma-dev/storage-core/actions/runs/30334062325/attempts/2",
    ],
  ] as const)(
    "rejects a mismatched authenticated %s claim",
    async (_name, path, value) => {
      const { audit, record, policy } = await provenanceFixture();
      changeClaim(audit.verified[0]!.attestationBundles[0]!, [...path], value);
      expect(() =>
        verifyProvenanceAudit(audit, [record], identity, policy),
      ).toThrow(/identity|invocation/u);
    },
  );

  it("rejects wrong subject bytes, absent certificates and ambiguous SLSA bundles", async () => {
    const first = await provenanceFixture();
    changeClaim(
      first.audit.verified[0]!.attestationBundles[0]!,
      ["subject", "0", "digest", "sha512"],
      "0".repeat(128),
    );
    expect(() =>
      verifyProvenanceAudit(
        first.audit,
        [first.record],
        identity,
        first.policy,
      ),
    ).toThrow();
    const second = await provenanceFixture();
    second.audit.verified[0]!.attestationBundles[0]!.bundle.verificationMaterial =
      {};
    expect(() =>
      verifyProvenanceAudit(
        second.audit,
        [second.record],
        identity,
        second.policy,
      ),
    ).toThrow(/certificate/u);
    const third = await provenanceFixture();
    third.audit.verified[0]!.attestationBundles.push(
      third.audit.verified[0]!.attestationBundles[0]!,
    );
    expect(() =>
      verifyProvenanceAudit(
        third.audit,
        [third.record],
        identity,
        third.policy,
      ),
    ).toThrow(/ambiguous/u);
  });

  it("refuses relabeling a historical certificate as the new release source", async () => {
    const { audit, record, policy } = await provenanceFixture();
    const relabeled = {
      ...record,
      origin: {
        kind: "source" as const,
        repository: "pegma-dev/storage-core" as const,
        gitCommit: commit,
        releaseTag: "v0.4.3",
        directory: record.directory,
      },
    };
    expect(() =>
      verifyProvenanceAudit(audit, [relabeled], identity, policy),
    ).toThrow(/certificate identity/u);
  });

  it("keeps the original physical writer distinct from a later verification attempt", async () => {
    const { audit, record, policy } = await provenanceFixture();
    const historicalIdentity = {
      gitCommit: record.origin.sourceCommit,
      releaseTag: record.origin.sourceTag,
      runId: record.origin.originalRunId,
      runAttempt: 2,
    };
    const sourceRecord = {
      ...record,
      origin: {
        kind: "source" as const,
        repository: "pegma-dev/storage-core" as const,
        gitCommit: historicalIdentity.gitCommit,
        releaseTag: historicalIdentity.releaseTag,
        directory: record.directory,
      },
    };
    const facts = verifyProvenanceAudit(
      audit,
      [sourceRecord],
      historicalIdentity,
      policy,
    );
    expect(facts[0]!.attempt).toBe(1);
    expect(() =>
      verifyProvenanceAudit(
        audit,
        [sourceRecord],
        { ...historicalIdentity, runId: historicalIdentity.runId + 1 },
        policy,
      ),
    ).toThrow(/publishing invocation/u);
  });
});

describe("publishing authority", () => {
  function environment(): NodeJS.ProcessEnv {
    return {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "release",
      GITHUB_REPOSITORY: "pegma-dev/storage-core",
      GITHUB_REPOSITORY_ID: "1312519623",
      GITHUB_REPOSITORY_OWNER_ID: "309286193",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_SHA: commit,
      GITHUB_REF: "refs/tags/v0.4.3",
      GITHUB_WORKFLOW_SHA: commit,
      GITHUB_WORKFLOW_REF:
        "pegma-dev/storage-core/.github/workflows/publish.yml@refs/tags/v0.4.3",
      RUNNER_ENVIRONMENT: "github-hosted",
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://fixture.actions.githubusercontent.com/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fictional-oidc-test-value",
    };
  }

  it("requires the exact github-hosted source-bound token-free publishing environment", () => {
    expect(() =>
      assertTrustedPublishingEnvironment(environment(), identity),
    ).not.toThrow();
    for (const changes of [
      { RUNNER_ENVIRONMENT: undefined },
      { RUNNER_ENVIRONMENT: "self-hosted" },
      { GITHUB_SHA: "b".repeat(40) },
      { GITHUB_REPOSITORY_ID: "1" },
      { GITHUB_REPOSITORY_OWNER_ID: "1" },
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
      { ACTIONS_ID_TOKEN_REQUEST_URL: "https://evil.invalid/oidc" },
      { NPM_TOKEN: "poison" },
      { NODE_AUTH_TOKEN: "poison" },
    ])
      expect(() =>
        assertTrustedPublishingEnvironment(
          { ...environment(), ...changes },
          identity,
        ),
      ).toThrow();
  });

  it("isolates local verification from credentials while retaining only explicit publishing identity", () => {
    const source = {
      ...environment(),
      PATH: "bin",
      NODE_OPTIONS: "poison",
      HTTPS_PROXY: "poison",
      NODE_EXTRA_CA_CERTS: "poison",
      NPM_TOKEN: "poison",
      npm_config_registry: "https://evil.invalid",
    };
    const local = isolatedVerificationEnvironment(source, "/fixture");
    expect(local).not.toHaveProperty("RUNNER_ENVIRONMENT");
    expect(local).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    const publish = isolatedVerificationEnvironment(source, "/fixture", true);
    expect(publish.RUNNER_ENVIRONMENT).toBe("github-hosted");
    expect(publish.GITHUB_SHA).toBe(commit);
    for (const key of [
      "NODE_OPTIONS",
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "NPM_TOKEN",
    ])
      expect(publish).not.toHaveProperty(key);
    expect(publish.npm_config_registry).toBe(REGISTRY);
    expect(publish.npm_config_ignore_scripts).toBe("true");
  });
});
