import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import {
  lstatSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
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
  preflightRegistry,
  registryReuseOrigin,
  runPublicConsumer,
  verifyProvenanceAudit,
  verifyPublishingJobs,
  verifyReusedPackages,
  validateReusePolicy,
  verifyRegistryRelease,
} from "../scripts/release-registry-verify.mjs";
import type {
  PreparedManifest,
  PreparedPackage,
  VerificationSeams,
} from "../scripts/release-registry-verify.mjs";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/release-registry/${name}`, import.meta.url));
const awsClient = {
  name: "@aws-sdk/client-dynamodb",
  version: "3.1130.0",
  integrity:
    "sha512-yPEc9TWLY1McM6xA9wlxA9rM0ZeS8RAeyi1t7rdHPNxq0TpyCDn6z651ccRJ1RrMU4k2aiVzNCaBYUZA4aaA/w==",
  tarballUrl:
    "https://registry.npmjs.org/@aws-sdk/client-dynamodb/-/client-dynamodb-3.1130.0.tgz",
  archiveSha256:
    "b0f2cf96a293592e70a4b0cee40d0ef387c10b0cdc541b0c3fd99a8d4b753335",
} as const;
type AwsConsumerFault =
  | "metadata-name"
  | "metadata-version"
  | "metadata-url"
  | "metadata-integrity"
  | "archive-bytes"
  | "lock-missing"
  | "lock-version"
  | "lock-link"
  | "lock-url"
  | "lock-integrity"
  | "installed-name"
  | "installed-version"
  | "installed-directory-link"
  | "nested-version";
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
    dsseEnvelope: {
      payloadType: string;
      payload: string;
      signatures?: unknown[];
    };
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

async function historicalWriterFixture() {
  const { policy } = await loadReusePolicy();
  const bundleFiles = [
    "core040-slsa.json",
    "azure040-slsa.json",
    "d1041-slsa.json",
  ];
  const records = policy.packages.map((entry) => ({
    ...entry,
    origin: registryReuseOrigin(entry),
    publish: false,
    tarball: `${entry.name.slice(1).replace("/", "-")}-${entry.version}.tgz`,
    ...inspectReleaseTarball(
      fixture(`${entry.directory}-${entry.version}.tgz`),
    ),
  }));
  // A scripted trusted npm-output boundary, NOT a claim that this test ran
  // ECDSA/Sigstore. Every nested signed bundle is the genuine public fixture.
  const audit = {
    invalid: [],
    missing: [],
    verified: records.map((record, index) => ({
      name: record.name,
      version: record.version,
      location: `node_modules/${record.name}`,
      registry: REGISTRY,
      attestationBundles: [
        JSON.parse(fixture(bundleFiles[index]!).toString("utf8")),
      ],
    })),
  };
  const facts = verifyProvenanceAudit(audit, records, identity, policy);
  const responses = new Map<string, Record<string, unknown>>();
  for (const runId of new Set(facts.map((fact) => fact.runId))) {
    const group = facts.filter((fact) => fact.runId === runId);
    const first = group[0]!;
    const start = new Date(
      Math.min(...group.map((fact) => Date.parse(fact.certificate.validFrom))) -
        1000,
    ).toISOString();
    const end = new Date(
      Math.max(...group.map((fact) => Date.parse(fact.certificate.validTo))) +
        1000,
    ).toISOString();
    const runUrl = `https://api.github.com/repos/pegma-dev/storage-core/actions/runs/${runId}`;
    responses.set(runUrl, {
      id: runId,
      head_sha: first.sourceCommit,
      head_branch: first.sourceTag,
      run_attempt: 1,
      event: "release",
      path: ".github/workflows/publish.yml",
      repository: { id: 1312519623, owner: { id: 309286193 } },
    });
    responses.set(`${runUrl}/attempts/1/jobs?per_page=100`, {
      total_count: 1,
      jobs: [
        {
          id: runId === 30334062325 ? 90195221537 : 90750106220,
          run_id: runId,
          run_attempt: 1,
          head_branch: first.sourceTag,
          name: "publish",
          status: "completed",
          conclusion: "success",
          head_sha: first.sourceCommit,
          started_at: start,
          completed_at: end,
          steps: [
            {
              name: "Publish verified prepared tarballs",
              status: "completed",
              conclusion: "success",
              started_at: start,
              completed_at: end,
            },
          ],
        },
      ],
    });
  }
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const response = responses.get(String(url));
    return response
      ? Response.json(response)
      : new Response(null, { status: 404 });
  });
  return { records, audit, facts, responses, fetch };
}

describe("registry reuse source policy", () => {
  it("accepts only a unique canonical inventory subset without inventing a future runtime pin", async () => {
    const { policy } = await loadReusePolicy();
    expect(validateReusePolicy({ ...policy, packages: [] }).packages).toEqual(
      [],
    );
    expect(
      validateReusePolicy({
        ...policy,
        packages: [policy.packages[0], policy.packages[2]],
      }).packages,
    ).toEqual([policy.packages[0], policy.packages[2]]);
    expect(() =>
      validateReusePolicy({
        ...policy,
        packages: [policy.packages[0], policy.packages[0]],
      }),
    ).toThrow();
    expect(() =>
      validateReusePolicy({
        ...policy,
        packages: [policy.packages[2], policy.packages[0]],
      }),
    ).toThrow();
    expect(() =>
      validateReusePolicy({
        ...policy,
        packages: [{ ...policy.packages[0], name: "@other/storage" }],
      }),
    ).toThrow();
    expect(
      policy.packages.some(({ name }) => name === "@pegma/storage-dynamodb"),
    ).toBe(false);
  });

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

describe("all authenticated historical writer observations", () => {
  it("checks both actual historical runs and their exact legacy writer jobs for all three reused packages", async () => {
    const f = await historicalWriterFixture();
    const jobs = await verifyPublishingJobs(f.facts, { fetch: f.fetch });
    expect(jobs.map(({ id }) => id).sort()).toEqual([90195221537, 90750106220]);
    expect(
      jobs.every(
        ({ stepName }) => stepName === "Publish verified prepared tarballs",
      ),
    ).toBe(true);
    expect(jobs.map(({ runId }) => runId).sort()).toEqual([
      30334062325, 30504107513,
    ]);
    expect(jobs.flatMap(({ packages }) => packages).join(" ")).toContain(
      "@pegma/storage-core",
    );
    expect(jobs.flatMap(({ packages }) => packages).join(" ")).toContain(
      "@pegma/storage-azure-tables",
    );
    expect(jobs.flatMap(({ packages }) => packages).join(" ")).toContain(
      "@pegma/storage-cloudflare-d1",
    );
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      ...f.responses.keys(),
    ]);
  });

  it.each([
    "run-source",
    "known-job-id",
    "legacy-step",
    "step-window",
    "incomplete-page",
    "unavailable",
  ] as const)(
    "refuses a historical %s mismatch instead of accepting an empty job-proof set",
    async (fault) => {
      const f = await historicalWriterFixture();
      const runUrl =
        "https://api.github.com/repos/pegma-dev/storage-core/actions/runs/30334062325";
      const page = f.responses.get(`${runUrl}/attempts/1/jobs?per_page=100`)!;
      const job = (page.jobs as Array<Record<string, unknown>>)[0]!;
      const step = (job.steps as Array<Record<string, unknown>>)[0]!;
      if (fault === "run-source")
        f.responses.get(runUrl)!.head_sha = "0".repeat(40);
      else if (fault === "known-job-id") job.id = 90195221538;
      else if (fault === "legacy-step")
        step.name = "Verify and publish the prepared release";
      else if (fault === "step-window") {
        step.started_at = "2020-01-01T00:00:00.000Z";
        step.completed_at = "2020-01-01T00:01:00.000Z";
      } else if (fault === "incomplete-page") page.total_count = 101;
      else f.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await expect(
        verifyPublishingJobs(f.facts, { fetch: f.fetch }),
      ).rejects.toThrow();
      expect(f.fetch).toHaveBeenCalled();
    },
  );
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

const npmToolUrl = "https://registry.npmjs.org/npm/-/npm-11.18.0.tgz";
const npmToolSha256 =
  "73f6155215ebabf4ed96dca1f567c2372cc713c33af2e5b9b62fde4e92373e2e";
const maximumNpmToolBytes = 16 * 1024 * 1024;
let npmToolPromise: Promise<Buffer> | undefined;

/** Real official archive, never a fabricated hash/tree. A supplied bad cache
 * is an error, not permission to fetch different bytes or skip the test. */
function officialNpmTool(): Promise<Buffer> {
  npmToolPromise ??= (async () => {
    const cached = process.env.PEGMA_TEST_NPM_ARCHIVE_PATH;
    let bytes: Buffer;
    if (cached !== undefined) {
      const metadata = lstatSync(cached);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > maximumNpmToolBytes
      )
        throw new Error(
          "The test npm archive cache is not a bounded regular file.",
        );
      bytes = readFileSync(cached);
    } else {
      const response = await globalThis.fetch(npmToolUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status !== 200 || response.body === null)
        throw new Error("The pinned official test npm archive is unavailable.");
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > maximumNpmToolBytes) {
            void reader.cancel().catch(() => {});
            throw new Error(
              "The official test npm archive exceeds its byte bound.",
            );
          }
          chunks.push(Buffer.from(next.value));
        }
      } finally {
        reader.releaseLock();
      }
      bytes = Buffer.concat(chunks, length);
    }
    if (digest(bytes) !== npmToolSha256)
      throw new Error(
        "The test npm archive differs from the pinned official bytes.",
      );
    return bytes;
  })();
  return npmToolPromise;
}

async function withoutExplicitNpm<T>(action: () => Promise<T>): Promise<T> {
  const previous = process.env.RELEASE_NPM_CLI;
  delete process.env.RELEASE_NPM_CLI;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.RELEASE_NPM_CLI;
    else process.env.RELEASE_NPM_CLI = previous;
  }
}

/** Delegate real extraction, but stop at the first selected npm --version
 * command. No npm version, install, signature audit, or consumer is executed,
 * and no successful crypto receipt is synthesized. */
function observingToolPorts(
  bytes: Buffer,
  selected: (cli: string, cwd: string) => never,
) {
  const commands: Array<{
    command: string;
    args: readonly string[];
    cwd: string;
  }> = [];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe(npmToolUrl);
    return new Response(new Uint8Array(bytes));
  });
  const run: NonNullable<VerificationSeams["run"]> = async (
    command,
    args,
    options,
  ) => {
    commands.push({ command, args: [...args], cwd: options.cwd });
    if (command === "tar") {
      const stdout = execFileSync(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: 20_000,
      });
      return { status: 0, stdout, stderr: "" };
    }
    if (
      command === process.execPath &&
      args.length === 2 &&
      args[1] === "--version"
    ) {
      const cli = args[0];
      if (cli === undefined)
        throw new Error("No selected npm CLI was supplied.");
      return selected(cli, options.cwd);
    }
    throw new Error(
      "Unexpected command after the test tool-selection boundary.",
    );
  };
  return { fetch, run, commands };
}

describe("verified official npm tool selection", () => {
  it("selects the verified owned archive CLI without bundled-tree discovery, before npm execution", async () => {
    const bytes = await officialNpmTool();
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "storage-npm-selection-test-"),
    );
    const stop = new Error("Stop before executing the selected npm CLI.");
    let observed = false;
    const ports = observingToolPorts(bytes, (cli, cwd) => {
      observed = true;
      expect(relative(cwd, cli).replaceAll("\\", "/")).toBe(
        "npm-tool/package/bin/npm-cli.js",
      );
      expect(realpathSync(cli)).toBe(cli);
      expect(
        JSON.parse(
          readFileSync(join(dirname(dirname(cli)), "package.json"), "utf8"),
        ).version,
      ).toBe("11.18.0");
      expect(readFileSync(cli).length).toBeGreaterThan(0);
      expect(cwd).not.toBe(root);
      throw stop;
    });
    try {
      await withoutExplicitNpm(async () => {
        await expect(
          verifyReusedPackages(
            [],
            identity,
            { output: join(root, "proof") },
            ports,
          ),
        ).rejects.toBe(stop);
      });
      expect(observed).toBe(true);
      expect(ports.commands.map(({ command }) => command)).toEqual([
        "tar",
        process.execPath,
      ]);
      const source = readFileSync(
        new URL("../scripts/release-registry-verify.mjs", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("async function npmContext(");
      const context = source.slice(
        start,
        source.indexOf("\nfunction derValue", start),
      );
      expect(start).toBeGreaterThanOrEqual(0);
      expect(context).not.toContain("dirname(process.execPath)");
      expect(context).not.toContain("const candidates");
      expect(context).toMatch(
        /if \(cli === undefined\)\s*\{\s*cli = join\(expected,\s*"package",\s*"bin",\s*"npm-cli.js"\)/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses changed official tool bytes before extraction or npm execution", async () => {
    const bytes = Buffer.from(await officialNpmTool());
    bytes[0] = bytes[0]! ^ 1;
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "storage-npm-digest-test-"),
    );
    const ports = observingToolPorts(bytes, () => {
      throw new Error("A changed tool must never execute.");
    });
    try {
      await withoutExplicitNpm(async () => {
        await expect(
          verifyReusedPackages(
            [],
            identity,
            { output: join(root, "proof") },
            ports,
          ),
        ).rejects.toThrow("the reviewed npm tool archive differs");
      });
      expect(ports.fetch).toHaveBeenCalledTimes(1);
      expect(ports.commands).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    { channel: "option", corruption: "link" },
    { channel: "environment", corruption: "link" },
    { channel: "option", corruption: "bytes" },
    { channel: "environment", corruption: "bytes" },
  ] as const)(
    "refuses an explicit $channel CLI with unreviewed $corruption before npm execution",
    async ({ channel, corruption }) => {
      const bytes = await officialNpmTool();
      const root = mkdtempSync(
        join(realpathSync(tmpdir()), "storage-npm-explicit-test-"),
      );
      try {
        const extracted = join(root, "explicit-tool");
        mkdirSync(extracted);
        const archive = join(root, "npm-official.tgz");
        writeFileSync(archive, bytes);
        execFileSync("tar", ["-xzf", archive, "-C", extracted], {
          timeout: 20_000,
        });
        const packageRoot = join(extracted, "package");
        const cli = join(packageRoot, "bin", "npm-cli.js");
        if (corruption === "link") {
          const target = join(root, "unreviewed-bin");
          mkdirSync(target);
          symlinkSync(target, join(packageRoot, "unreviewed-link"), "junction");
        } else {
          const metadata = join(packageRoot, "package.json");
          writeFileSync(metadata, readFileSync(metadata, "utf8") + "\n");
        }
        const ports = observingToolPorts(bytes, () => {
          throw new Error("A changed explicit tool must never execute.");
        });
        await withoutExplicitNpm(async () => {
          if (channel === "environment") process.env.RELEASE_NPM_CLI = cli;
          await expect(
            verifyReusedPackages(
              [],
              identity,
              {
                output: join(root, "proof"),
                ...(channel === "option" ? { npmCli: cli } : {}),
              },
              ports,
            ),
          ).rejects.toThrow(
            corruption === "link"
              ? "reviewed npm tree contains a link"
              : "npm tool files differ from the pinned official release",
          );
        });
        expect(ports.commands.map(({ command }) => command)).toEqual(["tar"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

/** Exercises real orchestration over temporary files/Git and genuine archive
 * fixtures. npm build/pack/audit and backend execution are CONTROLLED TOOLS:
 * these tests do not qualify crypto, runtime SDK behavior or publication. */
async function pipelineFixture() {
  const historical = await historicalWriterFixture();
  const npmBytes = await officialNpmTool();
  const awsBytes = fixture("aws-client-dynamodb-3.1130.0.tgz");
  expect(digest(awsBytes)).toBe(awsClient.archiveSha256);
  expect("sha512-" + digest(awsBytes, "sha512", "base64")).toBe(
    awsClient.integrity,
  );
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "storage-pipeline-test-"),
  );
  for (const file of ["package.json", "pnpm-lock.yaml", ".gitignore"])
    copyFileSync(new URL(`../${file}`, import.meta.url), join(root, file));
  for (const directory of [
    "storage-core",
    "storage-azure-tables",
    "storage-cloudflare-d1",
    "storage-dynamodb",
  ]) {
    mkdirSync(join(root, "packages", directory), { recursive: true });
    for (const file of ["package.json", "README.md", "LICENSE"])
      copyFileSync(
        new URL(`../packages/${directory}/${file}`, import.meta.url),
        join(root, "packages", directory, file),
      );
  }
  const git = process.platform === "win32" ? "git.exe" : "git";
  const gitRun = (args: string[]) =>
    execFileSync(git, args, { cwd: root, encoding: "utf8" }).trim();
  gitRun(["init", "--quiet"]);
  gitRun(["config", "user.name", "Release Pipeline Fixture"]);
  gitRun(["config", "user.email", "release@example.invalid"]);
  gitRun(["add", "."]);
  gitRun(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  const records = new Map<string, PreparedPackage>(
    historical.records.map((record) => [record.name, record]),
  );
  const tarballs = new Map<string, Buffer>(
    historical.records.map((record) => [
      record.name,
      fixture(`${record.directory}-${record.version}.tgz`),
    ]),
  );
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const consumerEvents: string[] = [];
  const state = {
    auditFails: false,
    consumerFails: false,
    lockTamper: false,
    selected: "absent" as "absent" | "present" | "unknown",
    acceptedPublish: false,
    publishThrows: false,
    auditOutput: historical.audit as unknown,
    consumerDependencies: [] as Array<Record<string, string>>,
    afterConsumer: undefined as (() => void) | undefined,
    awsFault: undefined as AwsConsumerFault | undefined,
  };
  const output = (stdout = "", status = 0) => ({
    pid: 0,
    status,
    signal: null,
    error: undefined,
    stdout,
    stderr: status ? "controlled test tool failure" : "",
    output: [null, stdout, ""],
  });
  function command(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    calls.push({ command, args: [...args] });
    const cwd = options.cwd ?? root;
    if (command === "tar" || command === git || command === "git")
      return output(
        execFileSync(command, [...args], {
          cwd,
          env: options.env,
          encoding: "utf8",
          timeout: 20_000,
        }),
      );
    if (command === "npm" || command === "npm.cmd") {
      if (args[0] === "run" && args[1] === "build") return output();
      if (args[0] === "pack") {
        const directory = args[1]!;
        const metadata = JSON.parse(
          readFileSync(join(directory, "package.json"), "utf8"),
        );
        const bytes = archive([], metadata);
        const inspected = inspectReleaseTarball(bytes);
        const tarball = `${metadata.name.slice(1).replace("/", "-")}-${metadata.version}.tgz`;
        const destination = args[args.indexOf("--pack-destination") + 1]!;
        writeFileSync(join(destination, tarball), bytes);
        const record: PreparedPackage = {
          name: metadata.name,
          version: metadata.version,
          directory: basename(directory),
          tarball,
          size: bytes.length,
          sha256: digest(bytes),
          shasum: digest(bytes, "sha1"),
          integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
          publish: true,
          package: inspected.package,
          files: inspected.files,
          origin: {
            kind: "source",
            repository: "pegma-dev/storage-core",
            gitCommit: gitRun(["rev-parse", "HEAD"]),
            releaseTag: "v0.4.3",
            directory: basename(directory),
          },
        };
        records.set(record.name, record);
        tarballs.set(record.name, bytes);
        return output(
          JSON.stringify([
            {
              name: record.name,
              version: record.version,
              filename: tarball,
              integrity: record.integrity,
              shasum: record.shasum,
            },
          ]),
        );
      }
      if (args[0] === "--version") return output("11.18.0\n");
      if (args[0] === "publish") {
        state.acceptedPublish = true;
        state.selected = "present";
        return output(
          "CONTROLLED_PUBLISH_TOOL_ONLY",
          state.publishThrows ? 1 : 0,
        );
      }
    }
    if (command === process.execPath && args[0]?.endsWith("npm-cli.js")) {
      if (args[1] === "--version") return output("11.18.0\n");
      if (args[1] === "install") {
        const input = JSON.parse(
          readFileSync(join(cwd, "package.json"), "utf8"),
        );
        if (input.name === "storage-public-consumer") {
          consumerEvents.push("consumer-install");
          state.consumerDependencies.push(structuredClone(input.dependencies));
        }
        const packages: Record<string, unknown> = {};
        for (const record of records.values()) {
          if (!Object.hasOwn(input.dependencies, record.name)) continue;
          const requested = input.dependencies[record.name] as string;
          packages[`node_modules/${record.name}`] = {
            version: record.version,
            resolved: requested.startsWith("file:")
              ? requested
              : canonicalTarball(record),
            integrity:
              state.lockTamper && record.name === "@pegma/storage-core"
                ? "sha512-invalid"
                : record.integrity,
          };
        }
        if (input.name === "storage-public-consumer") {
          const sdkKey = "node_modules/" + awsClient.name;
          const sdkLock = {
            version:
              state.awsFault === "lock-version"
                ? "3.1131.0"
                : awsClient.version,
            resolved:
              state.awsFault === "lock-url"
                ? "https://unreviewed.invalid/client.tgz"
                : awsClient.tarballUrl,
            integrity:
              state.awsFault === "lock-integrity"
                ? "sha512-unreviewed"
                : awsClient.integrity,
            ...(state.awsFault === "lock-link" ? { link: true } : {}),
          };
          if (state.awsFault !== "lock-missing") packages[sdkKey] = sdkLock;
          if (state.awsFault === "nested-version")
            packages["node_modules/@pegma/storage-dynamodb/" + sdkKey] = {
              ...sdkLock,
              version: "3.1131.0",
            };
          const sdkDirectory = join(cwd, sdkKey);
          mkdirSync(dirname(sdkDirectory), { recursive: true });
          let actualSdkDirectory = sdkDirectory;
          if (state.awsFault === "installed-directory-link") {
            actualSdkDirectory = join(cwd, "controlled-linked-aws-client");
            mkdirSync(actualSdkDirectory);
            symlinkSync(
              actualSdkDirectory,
              sdkDirectory,
              process.platform === "win32" ? "junction" : "dir",
            );
          } else mkdirSync(sdkDirectory);
          // Controlled install metadata, not executable AWS SDK contents. The
          // independent genuine archive admission is exercised separately.
          writeFileSync(
            join(actualSdkDirectory, "package.json"),
            JSON.stringify({
              name:
                state.awsFault === "installed-name"
                  ? "@aws-sdk/other-client"
                  : awsClient.name,
              version:
                state.awsFault === "installed-version"
                  ? "3.1131.0"
                  : awsClient.version,
            }),
          );
        }
        writeFileSync(
          join(cwd, "package-lock.json"),
          JSON.stringify({ packages }),
        );
        return output("CONTROLLED_INSTALL_TOOL_ONLY");
      }
      if (args[1] === "audit")
        return output(
          JSON.stringify(state.auditOutput),
          state.auditFails ? 1 : 0,
        );
    }
    if (
      command === process.execPath &&
      args.includes("--experimental-strip-types")
    ) {
      consumerEvents.push("consumer-command");
      const source = readFileSync(join(cwd, "consumer.mjs"), "utf8");
      expect(source).toContain('from "@pegma/storage-core/conformance"');
      expect(source).toContain('from "@pegma/storage-dynamodb"');
      expect(source).toContain("e instanceof StorageError");
      expect(source).toContain("e instanceof ConcurrencyError");
      state.afterConsumer?.();
      return output(
        JSON.stringify({
          status: "TEST_STUB_UNEXECUTED_PUBLIC_CONSUMER",
          qualification: "UNQUALIFIED_STUBS",
          publicConsumerExecuted: false,
          cryptographicVerificationExecuted: false,
        }),
        state.consumerFails ? 1 : 0,
      );
    }
    throw new Error(
      `Unexpected controlled command: ${command} ${args[0] ?? ""}`,
    );
  }
  const fetch: typeof globalThis.fetch = async (url) => {
    const address = String(url);
    if (address === npmToolUrl) return new Response(new Uint8Array(npmBytes));
    if (
      address ===
      REGISTRY + encodeURIComponent(awsClient.name) + "/" + awsClient.version
    ) {
      consumerEvents.push("aws-metadata");
      return Response.json({
        name:
          state.awsFault === "metadata-name"
            ? "@aws-sdk/other-client"
            : awsClient.name,
        version:
          state.awsFault === "metadata-version"
            ? "3.1131.0"
            : awsClient.version,
        dist: {
          tarball:
            state.awsFault === "metadata-url"
              ? "https://unreviewed.invalid/client.tgz"
              : awsClient.tarballUrl,
          integrity:
            state.awsFault === "metadata-integrity"
              ? "sha512-unreviewed"
              : awsClient.integrity,
        },
      });
    }
    if (address === awsClient.tarballUrl) {
      consumerEvents.push("aws-archive");
      const bytes = Buffer.from(awsBytes);
      if (state.awsFault === "archive-bytes") bytes[0] = bytes[0]! ^ 1;
      return new Response(new Uint8Array(bytes));
    }
    if (historical.responses.has(address))
      return Response.json(historical.responses.get(address));
    for (const record of records.values()) {
      if (
        address ===
        `${REGISTRY}${encodeURIComponent(record.name)}/${record.version}`
      ) {
        if (record.publish && state.selected !== "present")
          return new Response(null, {
            status: state.selected === "unknown" ? 503 : 404,
          });
        return Response.json({
          name: record.name,
          version: record.version,
          dist: {
            integrity: record.integrity,
            shasum: record.shasum,
            tarball: canonicalTarball(record),
            signatures: [
              {
                keyid: "CONTROLLED_METADATA_NOT_SIGNATURE_VERIFICATION",
                sig: "unit-fixture",
              },
            ],
          },
        });
      }
      if (address === canonicalTarball(record))
        return new Response(new Uint8Array(tarballs.get(record.name)!));
    }
    throw new Error("Unexpected controlled fetch URL.");
  };
  const seams: VerificationSeams = {
    fetch,
    run: async (cmd, args, options) => {
      const result = command(cmd, args, options);
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
  return {
    root,
    records,
    tarballs,
    historical,
    state,
    calls,
    consumerEvents,
    command,
    seams,
    gitRun,
  };
}

/** Enables only orchestration coverage at the existing scripted npm boundary.
 * The selected candidate's certificate/SLSA are deliberately invalidated and
 * have NO DSSE signature. This must never be used as registry qualification. */
function enableUnqualifiedRegistryOnlyStub(
  f: Awaited<ReturnType<typeof pipelineFixture>>,
  manifest: PreparedManifest,
) {
  const selected = manifest.packages.filter(({ publish }) => publish);
  expect(selected).toHaveLength(1);
  const record = selected[0]!;
  expect(record.name).toBe("@pegma/storage-dynamodb");
  expect(manifest.releaseTag).toBe("v0.4.3");
  const bundle = JSON.parse(
    fixture("core040-slsa.json").toString("utf8"),
  ) as BundleFixture;
  const material = bundle.bundle.verificationMaterial as {
    certificate: { rawBytes: string };
  };
  const certificate = Buffer.from(material.certificate.rawBytes, "base64");
  const oldSan = Buffer.from(
    "https://github.com/pegma-dev/storage-core/.github/workflows/publish.yml@refs/tags/v0.4.0",
  );
  const stubSan = Buffer.from(
    "https://github.com/pegma-dev/storage-core/.github/workflows/publish.yml@refs/tags/" +
      manifest.releaseTag,
  );
  // Same-length replacement preserves DER structure for the real claim parser
  // while invalidating its signature; no certificate or attestation is signed.
  expect(stubSan.length).toBe(oldSan.length);
  let replacements = 0;
  for (
    let offset = certificate.indexOf(oldSan);
    offset !== -1;
    offset = certificate.indexOf(oldSan, offset + oldSan.length)
  ) {
    stubSan.copy(certificate, offset);
    replacements += 1;
  }
  expect(replacements).toBeGreaterThan(0);
  material.certificate.rawBytes = certificate.toString("base64");
  bundle.bundle.dsseEnvelope.signatures = [];
  changeClaim(
    bundle,
    ["subject"],
    [
      {
        name:
          "pkg:npm/" +
          record.name.split("/").map(encodeURIComponent).join("/") +
          "@" +
          record.version,
        digest: {
          sha512: Buffer.from(record.integrity.slice(7), "base64").toString(
            "hex",
          ),
        },
      },
    ],
  );
  changeClaim(
    bundle,
    ["predicate", "buildDefinition", "externalParameters", "workflow", "ref"],
    "refs/tags/" + manifest.releaseTag,
  );
  changeClaim(
    bundle,
    ["predicate", "buildDefinition", "resolvedDependencies"],
    [
      {
        uri:
          "git+https://github.com/pegma-dev/storage-core@refs/tags/" +
          manifest.releaseTag,
        digest: { gitCommit: manifest.gitCommit },
      },
    ],
  );
  changeClaim(
    bundle,
    ["predicate", "runDetails", "metadata", "invocationId"],
    "https://github.com/pegma-dev/storage-core/actions/runs/12345/attempts/1",
  );
  f.state.auditOutput = {
    ...f.historical.audit,
    qualification: "UNQUALIFIED_STUBS",
    verified: [
      ...f.historical.audit.verified,
      {
        name: record.name,
        version: record.version,
        location: "node_modules/" + record.name,
        registry: REGISTRY,
        attestationBundles: [bundle],
      },
    ],
  };
  const runUrl =
    "https://api.github.com/repos/pegma-dev/storage-core/actions/runs/12345";
  f.historical.responses.set(runUrl, {
    id: 12345,
    head_sha: manifest.gitCommit,
    head_branch: manifest.releaseTag,
    run_attempt: 2,
    event: "release",
    path: ".github/workflows/publish.yml",
    repository: { id: 1312519623, owner: { id: 309286193 } },
  });
  f.historical.responses.set(`${runUrl}/attempts/1/jobs?per_page=100`, {
    qualification: "UNQUALIFIED_STUBS",
    total_count: 1,
    jobs: [
      {
        id: 1234501,
        run_id: 12345,
        run_attempt: 1,
        head_branch: manifest.releaseTag,
        head_sha: manifest.gitCommit,
        name: "publish",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-07-28T06:13:43.000Z",
        completed_at: "2026-07-28T06:14:49.000Z",
        steps: [
          {
            name: "Verify and publish the prepared release",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-07-28T06:13:49.000Z",
            completed_at: "2026-07-28T06:14:47.000Z",
          },
        ],
      },
    ],
  });
  f.state.selected = "present";
}

async function controlledPrepare(
  f: Awaited<ReturnType<typeof pipelineFixture>>,
  output?: string,
) {
  vi.resetModules();
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    spawnSync: f.command,
  }));
  vi.stubGlobal("fetch", f.seams.fetch);
  try {
    const { prepareRelease } = await import("../scripts/release-packages.mjs");
    return await withoutExplicitNpm(() =>
      prepareRelease({
        root: f.root,
        requireClean: true,
        releaseTag: "v0.4.3",
        ...(output === undefined ? {} : { output }),
      }),
    );
  } finally {
    vi.unstubAllGlobals();
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
}

async function actualInlinePublisher(
  f: Awaited<ReturnType<typeof pipelineFixture>>,
  manifestPath: string,
  manifest: PreparedManifest,
  preflightDirectory: string,
) {
  const workflow = readFileSync(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const match = /<<'NODE'\r?\n([^]*?)\r?\n          NODE/u.exec(workflow);
  if (!match) throw new Error("The actual minimal publisher was not found.");
  const original = match[1]!
    .split(/\r?\n/u)
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
  const body = original.replace(
    /^import\s+\{[^]*?\}\s+from\s+"node:[^"]+";\n/gmu,
    "",
  );
  expect(body).not.toMatch(/^import /mu);
  const policy = readFileSync(
    new URL("../scripts/release-reuse-policy.json", import.meta.url),
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SystemRoot,
    RUNNER_TEMP: f.root,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "release",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "pegma-dev/storage-core",
    GITHUB_REPOSITORY_ID: "1312519623",
    GITHUB_REPOSITORY_OWNER_ID: "309286193",
    GITHUB_SHA: manifest.gitCommit,
    GITHUB_WORKFLOW_SHA: manifest.gitCommit,
    GITHUB_REF: "refs/tags/" + manifest.releaseTag,
    GITHUB_WORKFLOW_REF:
      "pegma-dev/storage-core/.github/workflows/publish.yml@refs/tags/" +
      manifest.releaseTag,
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    RUNNER_ENVIRONMENT: "github-hosted",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://unit-fixture.actions.githubusercontent.com/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "UNIT_STUB_NOT_AN_OIDC_CREDENTIAL",
    RELEASE_TAG: manifest.releaseTag!,
    RELEASE_COMMIT: manifest.gitCommit,
    RELEASE_DIRECTORY: dirname(manifestPath),
    PREFLIGHT_DIRECTORY: preflightDirectory,
    EXPECTED_MANIFEST_DIGEST: digest(readFileSync(manifestPath)),
    EXPECTED_POLICY_DIGEST: digest(policy),
    REGISTRY_POLICY_BASE64: policy.toString("base64"),
    EXPECTED_PREFLIGHT_DIGEST: digest(
      readFileSync(join(preflightDirectory, "preflight.json")),
    ),
  };
  const messages: string[] = [];
  const bindings = {
    spawnSync: f.command,
    createHash,
    timingSafeEqual,
    constants,
    chmod: fsPromises.chmod,
    copyFile: fsPromises.copyFile,
    lstat: fsPromises.lstat,
    mkdtemp: fsPromises.mkdtemp,
    open: fsPromises.open,
    readFile: fsPromises.readFile,
    readdir: fsPromises.readdir,
    realpath: fsPromises.realpath,
    rm: fsPromises.rm,
    writeFile: fsPromises.writeFile,
    basename,
    dirname,
    join,
    resolve,
    tmpdir,
    fetch: f.seams.fetch,
    process: {
      env,
      stdout: {
        write: (text: string) => {
          messages.push(text);
        },
      },
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
  };
  // Execute the actual workflow source with only its external command/network
  // ports controlled. The fake OIDC string never leaves this in-process test.
  const execute = new Function(
    "bindings",
    `return (async()=>{const {${Object.keys(bindings).join(",")}}=bindings;\n${body}\n})();`,
  ) as (ports: typeof bindings) => Promise<void>;
  await execute(bindings);
  return messages;
}

describe("controlled real release orchestration (not release qualification)", () => {
  it("admits the genuine reviewed AWS archive and pins the direct consumer root without claiming runtime or crypto execution", async () => {
    const f = await pipelineFixture();
    try {
      const prepared = await controlledPrepare(f);
      const output = join(f.root, "reviewed-aws-consumer");
      mkdirSync(output);
      const eventsBefore = f.consumerEvents.length;
      const result = await withoutExplicitNpm(() =>
        runPublicConsumer(prepared.manifest, { output }, f.seams),
      );
      expect(f.consumerEvents.slice(eventsBefore)).toEqual([
        "aws-metadata",
        "aws-archive",
        "consumer-install",
        "consumer-command",
      ]);
      expect(result).toMatchObject({
        qualification: "UNQUALIFIED_STUBS",
        publicConsumerExecuted: false,
        cryptographicVerificationExecuted: false,
      });
      expect(f.state.consumerDependencies.at(-1)?.[awsClient.name]).toBe(
        awsClient.version,
      );
      const dynamo = prepared.manifest.packages.find(
        ({ name }) => name === "@pegma/storage-dynamodb",
      )!;
      expect(
        (dynamo.package.dependencies as Record<string, string>)[awsClient.name],
      ).toBe("^3.1097.0");
      const admittedArchive = readFileSync(
        join(output, "consumer-aws-sdk.tgz"),
      );
      expect(admittedArchive).toEqual(
        fixture("aws-client-dynamodb-3.1130.0.tgz"),
      );
      expect(digest(admittedArchive)).toBe(awsClient.archiveSha256);
      const metadata = readFileSync(
        join(output, "consumer-aws-sdk-metadata.json"),
      );
      expect(JSON.parse(metadata.toString("utf8"))).toEqual({
        name: awsClient.name,
        version: awsClient.version,
        dist: { tarball: awsClient.tarballUrl, integrity: awsClient.integrity },
      });
      expect(
        JSON.parse(
          readFileSync(join(output, "consumer-aws-sdk-admission.json"), "utf8"),
        ),
      ).toEqual({
        name: awsClient.name,
        version: awsClient.version,
        integrity: awsClient.integrity,
        tarballUrl: awsClient.tarballUrl,
        archiveSha256: awsClient.archiveSha256,
        archiveBytes: admittedArchive.length,
        metadataSha256: digest(metadata),
        scope:
          "Pinned direct consumer root only; no transitive or AWS provenance qualification",
      });
      const lock = JSON.parse(
        readFileSync(join(output, "public-consumer-lock.json"), "utf8"),
      );
      expect(lock.packages["node_modules/" + awsClient.name]).toEqual({
        version: awsClient.version,
        resolved: awsClient.tarballUrl,
        integrity: awsClient.integrity,
      });
      expect(f.calls.some(({ args }) => args[0] === "publish")).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 180_000);

  it.each([
    {
      fault: "metadata-name",
      error: "reviewed consumer AWS SDK metadata differs",
    },
    {
      fault: "metadata-version",
      error: "reviewed consumer AWS SDK metadata differs",
    },
    {
      fault: "metadata-url",
      error: "reviewed consumer AWS SDK metadata differs",
    },
    {
      fault: "metadata-integrity",
      error: "reviewed consumer AWS SDK metadata differs",
    },
    {
      fault: "archive-bytes",
      error: "reviewed consumer AWS SDK archive differs",
    },
    { fault: "lock-missing", error: "public consumer AWS SDK root is missing" },
    {
      fault: "lock-version",
      error: "public consumer resolved an unexpected AWS SDK",
    },
    {
      fault: "lock-link",
      error: "public consumer resolved an unexpected AWS SDK",
    },
    {
      fault: "lock-url",
      error: "public consumer resolved an unexpected AWS SDK",
    },
    {
      fault: "lock-integrity",
      error: "public consumer resolved an unexpected AWS SDK",
    },
    {
      fault: "installed-name",
      error: "public consumer AWS SDK file identity differs",
    },
    {
      fault: "installed-version",
      error: "public consumer AWS SDK file identity differs",
    },
    {
      fault: "installed-directory-link",
      error: "public consumer AWS SDK files have an unexpected origin",
    },
    {
      fault: "nested-version",
      error: "public consumer resolved an unexpected AWS SDK",
    },
  ] as const)(
    "refuses $fault before any public consumer command",
    async ({ fault, error }) => {
      const f = await pipelineFixture();
      try {
        const prepared = await controlledPrepare(f);
        const output = join(f.root, "refused-aws-" + fault);
        mkdirSync(output);
        f.state.awsFault = fault;
        const eventsBefore = f.consumerEvents.length;
        const callsBefore = f.calls.length;
        await withoutExplicitNpm(async () => {
          await expect(
            runPublicConsumer(prepared.manifest, { output }, f.seams),
          ).rejects.toThrow(error);
        });
        const beforeInstall =
          fault.startsWith("metadata-") || fault === "archive-bytes";
        const events = f.consumerEvents.slice(eventsBefore);
        expect(events).toEqual(
          fault.startsWith("metadata-")
            ? ["aws-metadata"]
            : beforeInstall
              ? ["aws-metadata", "aws-archive"]
              : ["aws-metadata", "aws-archive", "consumer-install"],
        );
        expect(
          f.calls
            .slice(callsBefore)
            .filter(({ args }) => args[1] === "install"),
        ).toHaveLength(beforeInstall ? 0 : 1);
        expect(
          f.calls
            .slice(callsBefore)
            .some(({ args }) => args.includes("--experimental-strip-types")),
        ).toBe(false);
        expect(existsSync(join(output, "public-consumer.stdout"))).toBe(false);
        expect(existsSync(join(output, "verification.json"))).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it("preserves prior evidence on retry and accepts a separately fresh output namespace", async () => {
    const f = await pipelineFixture();
    const fresh = f.root + "-fresh-output";
    try {
      const first = await controlledPrepare(f);
      const before = digest(readFileSync(first.manifestPath));
      const calls = f.calls.length;
      await expect(controlledPrepare(f)).rejects.toThrow(
        /preserve existing evidence and choose a fresh --output/u,
      );
      expect(f.calls).toHaveLength(calls);
      const second = await controlledPrepare(f, fresh);
      expect(dirname(second.manifestPath)).toBe(fresh);
      expect(digest(readFileSync(first.manifestPath))).toBe(before);
      expect(f.gitRun(["status", "--porcelain"])).toBe("");
    } finally {
      for (const path of [
        fresh,
        fresh + "-reuse-verification",
        fresh + "-consumer-verification",
        f.root,
      ])
        rmSync(path, { recursive: true, force: true });
    }
  }, 180_000);

  it("prepares selected source only, preserves exact originals, checks all historical writers and runs the public consumer command", async () => {
    const f = await pipelineFixture();
    try {
      const prepared = await controlledPrepare(f);
      expect(
        f.calls
          .filter(({ args }) => args[0] === "pack")
          .map(({ args }) => basename(args[1]!)),
      ).toEqual(["storage-dynamodb"]);
      expect(prepared.manifest.packages.map(({ publish }) => publish)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      for (const record of prepared.manifest.packages.filter(
        ({ publish }) => !publish,
      ))
        expect(
          digest(
            readFileSync(join(dirname(prepared.manifestPath), record.tarball)),
          ),
        ).toBe(record.sha256);
      const jobs = JSON.parse(
        readFileSync(
          join(f.root, ".release-reuse-verification", "publishing-jobs.json"),
          "utf8",
        ),
      );
      expect(jobs).toHaveLength(2);
      expect(
        readFileSync(
          join(
            f.root,
            ".release-consumer-verification",
            "public-consumer.stdout",
          ),
          "utf8",
        ),
      ).toContain("TEST_STUB_UNEXECUTED_PUBLIC_CONSUMER");
      expect(f.gitRun(["status", "--porcelain"])).toBe("");
      const options = {
        root: f.root,
        manifest: prepared.manifestPath,
        expectedReleaseCommit: prepared.manifest.gitCommit,
        expectedManifestSha256: digest(readFileSync(prepared.manifestPath)),
        output: join(f.root, "preflight-proof"),
        runId: 12345,
        runAttempt: 2,
      };
      const preflight = await withoutExplicitNpm(() =>
        preflightRegistry(prepared.manifest, options, f.seams),
      );
      expect(preflight.decisions).toEqual(
        prepared.manifest.packages.map(({ name, version, publish }) => ({
          name,
          version,
          action: publish ? "publish" : "skip",
        })),
      );
      const callsBefore = f.calls.length;
      await withoutExplicitNpm(async () => {
        await expect(
          verifyRegistryRelease(
            prepared.manifest,
            { ...options, output: join(f.root, "postflight-proof") },
            f.seams,
          ),
        ).rejects.toThrow("complete release is not visible");
      });
      expect(
        f.calls
          .slice(callsBefore)
          .some(({ args }) => args.includes("--experimental-strip-types")),
      ).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 180_000);

  it("completes registry-only final receipt orchestration with explicit UNQUALIFIED_STUBS, never release qualification", async () => {
    const f = await pipelineFixture();
    try {
      const prepared = await controlledPrepare(f);
      enableUnqualifiedRegistryOnlyStub(f, prepared.manifest);
      const output = join(f.root, "unqualified-postflight");
      const callsBefore = f.calls.length;
      const consumerInputsBefore = f.state.consumerDependencies.length;
      const result = await withoutExplicitNpm(() =>
        verifyRegistryRelease(
          prepared.manifest,
          {
            root: f.root,
            manifest: prepared.manifestPath,
            expectedReleaseCommit: prepared.manifest.gitCommit,
            expectedManifestSha256: digest(readFileSync(prepared.manifestPath)),
            output,
            runId: 12345,
            runAttempt: 2,
          },
          f.seams,
        ),
      );
      const audited = JSON.parse(
        readFileSync(join(output, "npm-audit-signatures.json"), "utf8"),
      );
      expect(audited.qualification).toBe("UNQUALIFIED_STUBS");
      expect(
        audited.verified.at(-1).attestationBundles[0].bundle.dsseEnvelope
          .signatures,
      ).toEqual([]);
      expect(result).toMatchObject({
        status: "STORAGE_REGISTRY_CRYPTO_SOURCE_PUBLIC_CONSUMER_PASS",
        decisions: prepared.manifest.packages.map(({ name, version }) => ({
          name,
          version,
          action: "skip",
        })),
        consumer: {
          status: "TEST_STUB_UNEXECUTED_PUBLIC_CONSUMER",
          qualification: "UNQUALIFIED_STUBS",
          publicConsumerExecuted: false,
          cryptographicVerificationExecuted: false,
        },
        registryProof: {
          auditSha256: digest(
            readFileSync(join(output, "npm-audit-signatures.json")),
          ),
          lockSha256: digest(readFileSync(join(output, "package-lock.json"))),
          publishingJobs: expect.arrayContaining([
            expect.objectContaining({
              id: 1234501,
              attempt: 1,
              conclusion: "failure",
              sourceCommit: prepared.manifest.gitCommit,
              packages: ["@pegma/storage-dynamodb"],
            }),
          ]),
        },
      });
      expect(
        JSON.parse(readFileSync(join(output, "verification.json"), "utf8")),
      ).toEqual(result);
      expect(f.state.consumerDependencies).toHaveLength(
        consumerInputsBefore + 1,
      );
      const dynamo = prepared.manifest.packages.find(
        ({ name }) => name === "@pegma/storage-dynamodb",
      )!;
      expect(f.state.consumerDependencies.at(-1)).toEqual({
        ...Object.fromEntries(
          prepared.manifest.packages.map(({ name, version }) => [
            name,
            version,
          ]),
        ),
        "@aws-sdk/client-dynamodb": awsClient.version,
      });
      expect(
        (dynamo.package.dependencies as Record<string, string>)[awsClient.name],
      ).toBe("^3.1097.0");
      expect(
        f.calls
          .slice(callsBefore)
          .filter(({ args }) => args.includes("--experimental-strip-types")),
      ).toHaveLength(1);
      expect(f.calls.some(({ args }) => args[0] === "publish")).toBe(false);
      const consumerLock = JSON.parse(
        readFileSync(join(output, "public-consumer-lock.json"), "utf8"),
      );
      for (const record of prepared.manifest.packages)
        expect(consumerLock.packages["node_modules/" + record.name]).toEqual({
          version: record.version,
          integrity: record.integrity,
          resolved: canonicalTarball(record),
        });
      expect(consumerLock.packages["node_modules/" + awsClient.name]).toEqual({
        version: awsClient.version,
        resolved: awsClient.tarballUrl,
        integrity: awsClient.integrity,
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 180_000);

  it.each(["consumer", "retained-audit", "retained-lock", "manifest"] as const)(
    "withholds the final receipt after UNQUALIFIED_STUBS %s failure or post-consumer tampering",
    async (fault) => {
      const f = await pipelineFixture();
      try {
        const prepared = await controlledPrepare(f);
        enableUnqualifiedRegistryOnlyStub(f, prepared.manifest);
        const output = join(f.root, "unqualified-postflight-" + fault);
        const manifestHash = digest(readFileSync(prepared.manifestPath));
        f.state.consumerFails = fault === "consumer";
        f.state.afterConsumer = () => {
          const path =
            fault === "retained-audit"
              ? join(output, "npm-audit-signatures.json")
              : fault === "retained-lock"
                ? join(output, "package-lock.json")
                : fault === "manifest"
                  ? prepared.manifestPath
                  : undefined;
          if (path !== undefined)
            writeFileSync(path, readFileSync(path, "utf8") + "\n");
        };
        const callsBefore = f.calls.length;
        await withoutExplicitNpm(async () => {
          await expect(
            verifyRegistryRelease(
              prepared.manifest,
              {
                root: f.root,
                manifest: prepared.manifestPath,
                expectedReleaseCommit: prepared.manifest.gitCommit,
                expectedManifestSha256: manifestHash,
                output,
                runId: 12345,
                runAttempt: 2,
              },
              f.seams,
            ),
          ).rejects.toThrow(
            fault === "consumer"
              ? "public DynamoDB consumer did not pass"
              : fault === "manifest"
                ? "prepared manifest independent digest differs"
                : "retained cryptographic proof changed during public imports",
          );
        });
        expect(
          f.calls
            .slice(callsBefore)
            .filter(({ args }) => args.includes("--experimental-strip-types")),
        ).toHaveLength(1);
        const retained = JSON.parse(
          readFileSync(join(output, "verification.json"), "utf8"),
        );
        // Earlier proof remains for diagnosis; the final combined receipt must
        // not replace it after a failed consumer, changed proof or manifest.
        expect(retained.status).toBe("REGISTRY_BYTES_CRYPTO_SOURCE_PASS");
        expect(retained).not.toHaveProperty("consumer");
        expect(
          readFileSync(join(output, "public-consumer.stdout"), "utf8"),
        ).toContain("UNQUALIFIED_STUBS");
        expect(f.calls.some(({ args }) => args[0] === "publish")).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it("refuses unknown occupancy, audit failure and byte-identical but unqualified selected source during real preflight", async () => {
    const f = await pipelineFixture();
    try {
      const prepared = await controlledPrepare(f);
      const base = {
        root: f.root,
        manifest: prepared.manifestPath,
        expectedReleaseCommit: prepared.manifest.gitCommit,
        expectedManifestSha256: digest(readFileSync(prepared.manifestPath)),
        runId: 12345,
        runAttempt: 2,
      };
      for (const fault of [
        "unknown",
        "audit",
        "unqualified-existing",
      ] as const) {
        f.state.selected =
          fault === "unknown"
            ? "unknown"
            : fault === "unqualified-existing"
              ? "present"
              : "absent";
        f.state.auditFails = fault === "audit";
        const output = join(f.root, "preflight-" + fault);
        await withoutExplicitNpm(async () => {
          await expect(
            preflightRegistry(prepared.manifest, { ...base, output }, f.seams),
          ).rejects.toThrow();
        });
        expect(existsSync(join(output, "preflight.json"))).toBe(false);
        expect(f.calls.some(({ args }) => args[0] === "publish")).toBe(false);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 180_000);

  it("executes actual inline skip, publish, changed-occupancy and accepted-unknown decisions without real registry writes", async () => {
    const f = await pipelineFixture();
    try {
      const prepared = await controlledPrepare(f);
      const output = join(f.root, "publisher-preflight");
      await withoutExplicitNpm(() =>
        preflightRegistry(
          prepared.manifest,
          {
            root: f.root,
            manifest: prepared.manifestPath,
            expectedReleaseCommit: prepared.manifest.gitCommit,
            expectedManifestSha256: digest(readFileSync(prepared.manifestPath)),
            runId: 12345,
            runAttempt: 2,
            output,
          },
          f.seams,
        ),
      );
      const publishCount = () =>
        f.calls.filter(({ args }) => args[0] === "publish").length;
      // Independent scripted registry scenarios share immutable artifacts;
      // no live registry, signature verification, token or upload is involved.
      f.state.selected = "unknown";
      await expect(
        actualInlinePublisher(
          f,
          prepared.manifestPath,
          prepared.manifest,
          output,
        ),
      ).rejects.toThrow("registry availability is unknown");
      expect(publishCount()).toBe(0);
      f.state.selected = "present";
      await expect(
        actualInlinePublisher(
          f,
          prepared.manifestPath,
          prepared.manifest,
          output,
        ),
      ).rejects.toThrow(/occupancy changed/u);
      expect(publishCount()).toBe(0);
      f.state.selected = "absent";
      const messages = await actualInlinePublisher(
        f,
        prepared.manifestPath,
        prepared.manifest,
        output,
      );
      expect(
        messages.filter((message) => message.includes("skipping.")).length,
      ).toBe(3);
      expect(publishCount()).toBe(1);
      expect(f.calls.find(({ args }) => args[0] === "publish")!.args).toContain(
        "--provenance",
      );
      f.state.selected = "absent";
      f.state.publishThrows = true;
      await expect(
        actualInlinePublisher(
          f,
          prepared.manifestPath,
          prepared.manifest,
          output,
        ),
      ).rejects.toThrow("reviewed npm operation failed");
      expect(f.state.acceptedPublish).toBe(true);
      expect(publishCount()).toBe(2);
      await expect(
        actualInlinePublisher(
          f,
          prepared.manifestPath,
          prepared.manifest,
          output,
        ),
      ).rejects.toThrow(/occupancy changed/u);
      expect(publishCount()).toBe(2);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 180_000);

  it.each(["audit", "consumer", "dependency-lock"] as const)(
    "withholds successful producer proof after controlled %s failure",
    async (fault) => {
      const f = await pipelineFixture();
      f.state.auditFails = fault === "audit";
      f.state.consumerFails = fault === "consumer";
      f.state.lockTamper = fault === "dependency-lock";
      try {
        await expect(controlledPrepare(f)).rejects.toThrow();
        expect(f.calls.some(({ args }) => args[0] === "publish")).toBe(false);
        expect(
          existsSync(
            join(f.root, ".release-consumer-verification", "verification.json"),
          ),
        ).toBe(false);
        if (fault !== "consumer")
          expect(
            f.calls.some(({ args }) =>
              args.includes("--experimental-strip-types"),
            ),
          ).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
