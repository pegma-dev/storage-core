import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REGISTRY = "https://registry.npmjs.org/";
export const RELEASE_REPOSITORY = "pegma-dev/storage-core";
export const RELEASE_NPM_VERSION = "11.18.0";
const workflowPath = ".github/workflows/publish.yml";
const provenanceType = "https://slsa.dev/provenance/v1";
const root = fileURLToPath(new URL("../", import.meta.url));
const npmArchiveUrl = "https://registry.npmjs.org/npm/-/npm-11.18.0.tgz";
const npmArchiveSha256 =
  "73f6155215ebabf4ed96dca1f567c2372cc713c33af2e5b9b62fde4e92373e2e";
const maximumTarBytes = 4 * 1024 * 1024;
// The release consumer's direct SDK root is bound to the reviewed pnpm lock,
// independently of the adapter's supported runtime range. Transitives are not
// claimed reproducible, and this pin does not claim AWS SLSA provenance.
const consumerAwsSdk = {
  name: "@aws-sdk/client-dynamodb",
  version: "3.1130.0",
  integrity:
    "sha512-yPEc9TWLY1McM6xA9wlxA9rM0ZeS8RAeyi1t7rdHPNxq0TpyCDn6z651ccRJ1RrMU4k2aiVzNCaBYUZA4aaA/w==",
  tarballUrl:
    "https://registry.npmjs.org/@aws-sdk/client-dynamodb/-/client-dynamodb-3.1130.0.tgz",
};

function fail(message) {
  throw new Error(message);
}
function hash(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}
function equal(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function exact(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  )
    fail("release data contains invalid fields");
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail("release data contains an invalid bound");
}
export function validateReusePolicy(policy) {
  exact(policy, [
    "schemaVersion",
    "repository",
    "repositoryId",
    "ownerId",
    "builder",
    "packages",
  ]);
  if (
    policy.schemaVersion !== 1 ||
    policy.repository !== RELEASE_REPOSITORY ||
    policy.repositoryId !== "1312519623" ||
    policy.ownerId !== "309286193" ||
    policy.builder !== "https://github.com/actions/runner/github-hosted" ||
    !Array.isArray(policy.packages) ||
    policy.packages.length > 4
  )
    fail("registry reuse policy is invalid");
  const names = [
    "@pegma/storage-core",
    "@pegma/storage-azure-tables",
    "@pegma/storage-cloudflare-d1",
    "@pegma/storage-dynamodb",
  ];
  let previousIndex = -1;
  for (const record of policy.packages) {
    exact(record, [
      "name",
      "version",
      "directory",
      "tarballUrl",
      "size",
      "sha256",
      "integrity",
      "shasum",
      "sourceCommit",
      "sourceTag",
      "workflowPath",
      "originalRunId",
      "originalRunAttempt",
    ]);
    const index = names.indexOf(record.name);
    if (
      index <= previousIndex ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(record.version) ||
      record.directory !== record.name.split("/")[1] ||
      record.tarballUrl !== canonicalTarball(record) ||
      !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      !/^[a-f0-9]{40}$/u.test(record.shasum) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(record.integrity) ||
      !/^[a-f0-9]{40}$/u.test(record.sourceCommit) ||
      record.sourceTag !== "v" + record.version ||
      record.workflowPath !== workflowPath
    )
      fail("registry reuse policy entry is invalid");
    integer(record.size, maximumTarBytes);
    integer(record.originalRunId);
    integer(record.originalRunAttempt);
    previousIndex = index;
  }
  return policy;
}
export async function loadReusePolicy() {
  const bytes = await readFile(
    new URL("./release-reuse-policy.json", import.meta.url),
  );
  const policy = validateReusePolicy(JSON.parse(bytes));
  return { policy, sha256: hash(bytes) };
}
export function registryReuseOrigin(entry) {
  return {
    kind: "registryReuse",
    registry: REGISTRY,
    policyEntry: entry.name + "@" + entry.version,
    tarballUrl: entry.tarballUrl,
    sourceCommit: entry.sourceCommit,
    sourceTag: entry.sourceTag,
    workflowPath: entry.workflowPath,
    originalRunId: entry.originalRunId,
    originalRunAttempt: entry.originalRunAttempt,
  };
}
export function canonicalTarball(record) {
  return (
    REGISTRY +
    record.name +
    "/-/" +
    record.name.split("/")[1] +
    "-" +
    record.version +
    ".tgz"
  );
}
async function responseBytes(response, maximum) {
  const declared = response.headers?.get("content-length");
  if (
    declared !== undefined &&
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximum)
  ) {
    await response.body?.cancel();
    fail("registry response exceeded its limit");
  }
  let size = 0;
  const chunks = [];
  if (response.body)
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximum) {
        await response.body.cancel().catch(() => {});
        fail("registry response exceeded its limit");
      }
      chunks.push(Buffer.from(chunk));
    }
  return Buffer.concat(chunks, size);
}
async function request(url, fetch = globalThis.fetch) {
  try {
    return await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json" },
    });
  } catch {
    fail("registry availability is unknown");
  }
}
export async function downloadRegistryArtifact(entry, seams = {}) {
  const metadataResponse = await request(
    REGISTRY + encodeURIComponent(entry.name) + "/" + entry.version,
    seams.fetch,
  );
  if (metadataResponse.status !== 200) {
    await metadataResponse.body?.cancel();
    fail("required registry artifact is unavailable");
  }
  const metadata = JSON.parse(
    (await responseBytes(metadataResponse, 2 * 1024 * 1024)).toString("utf8"),
  );
  if (
    metadata.name !== entry.name ||
    metadata.version !== entry.version ||
    !equal(metadata.dist?.integrity, entry.integrity) ||
    !equal(metadata.dist?.shasum, entry.shasum) ||
    metadata.dist?.tarball !== canonicalTarball(entry) ||
    !Array.isArray(metadata.dist.signatures) ||
    metadata.dist.signatures.length === 0 ||
    !metadata.dist.signatures.every(
      (s) =>
        typeof s.keyid === "string" &&
        s.keyid.length > 0 &&
        typeof s.sig === "string" &&
        s.sig.length > 0,
    )
  )
    fail("registry metadata conflicts with the pinned artifact");
  const response = await request(metadata.dist.tarball, seams.fetch);
  if (response.status !== 200) {
    await response.body?.cancel();
    fail("canonical registry tarball is unavailable");
  }
  const bytes = await responseBytes(response, entry.size);
  if (
    bytes.length !== entry.size ||
    !equal(hash(bytes), entry.sha256) ||
    !equal(hash(bytes, "sha1"), entry.shasum) ||
    !equal("sha512-" + hash(bytes, "sha512", "base64"), entry.integrity)
  )
    fail("registry tarball conflicts with the original bytes");
  const inspected = inspectReleaseTarball(bytes);
  if (
    inspected.package.name !== entry.name ||
    inspected.package.version !== entry.version
  )
    fail("registry archive identity conflicts with its policy");
  return { bytes, metadata, ...inspected };
}
function tarText(bytes) {
  const zero = bytes.indexOf(0);
  return bytes.subarray(0, zero === -1 ? bytes.length : zero).toString("utf8");
}
export function inspectReleaseTarball(bytes) {
  integer(bytes.length, maximumTarBytes);
  const tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  const files = [],
    contents = new Map();
  let offset = 0,
    ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0))
        fail("invalid archive terminator");
      ended = true;
      break;
    }
    const checksumText = tarText(header.subarray(148, 156)).trim();
    if (!/^[0-7]+$/u.test(checksumText)) fail("invalid archive checksum");
    const checksum = header.reduce(
      (total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte),
      0,
    );
    if (checksum !== Number.parseInt(checksumText, 8))
      fail("invalid archive checksum");
    const prefix = tarText(header.subarray(345, 500));
    const path =
      (prefix ? prefix + "/" : "") + tarText(header.subarray(0, 100));
    const type = header[156],
      sizeText = tarText(header.subarray(124, 136)).trim();
    if (
      (type !== 0 && type !== 48) ||
      !/^[0-7]+$/u.test(sizeText) ||
      !path.startsWith("package/") ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      path.split("/").some((p) => p === "" || p === "." || p === "..")
    )
      fail("archive must contain only safe regular files");
    const size = Number.parseInt(sizeText, 8),
      name = path.slice(8);
    integer(size, 4 * 1024 * 1024, 0);
    const start = offset + 512;
    if (start + size > tar.length || contents.has(name) || files.length >= 1000)
      fail("archive bounds or identities are invalid");
    if (
      !["package.json", "README.md", "LICENSE"].includes(name) &&
      (!/^dist\/[A-Za-z0-9_./-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/u.test(
        name,
      ) ||
        /\.(?:test|spec)\./u.test(name))
    )
      fail("archive contains an unreviewed file");
    files.push({ path: name, size });
    contents.set(name, tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!ended) fail("archive is missing its terminator");
  for (const name of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
  ])
    if (!contents.has(name)) fail("archive is missing a required public file");
  const metadata = JSON.parse(contents.get("package.json").toString("utf8"));
  if (
    ![
      "@pegma/storage-core",
      "@pegma/storage-azure-tables",
      "@pegma/storage-cloudflare-d1",
      "@pegma/storage-dynamodb",
    ].includes(metadata.name) ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(metadata.version) ||
    metadata.license !== "MIT" ||
    metadata.type !== "module" ||
    metadata.engines?.node !== ">=22" ||
    metadata.publishConfig?.access !== "public" ||
    metadata.repository?.url !==
      "git+https://github.com/pegma-dev/storage-core.git" ||
    metadata.repository?.directory !==
      "packages/" + metadata.name.split("/")[1] ||
    metadata.exports === null ||
    typeof metadata.exports !== "object" ||
    Array.isArray(metadata.exports)
  )
    fail("archive public metadata is invalid");
  for (const target of Object.values(metadata.exports ?? {}).flatMap(
    function targets(value) {
      return typeof value === "string"
        ? [value]
        : value && typeof value === "object"
          ? Object.values(value).flatMap(targets)
          : [];
    },
  ))
    if (!target.startsWith("./dist/") || !contents.has(target.slice(2)))
      fail("archive exported entry is missing");
  if (Object.keys(metadata.exports ?? {}).length === 0)
    fail("archive has no public exports");
  return {
    package: metadata,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
export function isolatedVerificationEnvironment(
  source,
  directory,
  publishing = false,
) {
  const env = {};
  const provenance = new Set([
    "GITHUB_ACTIONS",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_SERVER_URL",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "RUNNER_ENVIRONMENT",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (
      /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA)$/iu.test(
        key,
      ) ||
      (publishing && provenance.has(key))
    )
      env[key] = value;
  }
  return {
    ...env,
    CI: "true",
    npm_config_userconfig: join(directory, "user.npmrc"),
    npm_config_globalconfig: join(directory, "global.npmrc"),
    npm_config_cache: join(directory, "cache"),
    npm_config_registry: REGISTRY,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}
export function assertTrustedPublishingEnvironment(env, identity) {
  let url;
  try {
    url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  } catch {
    fail("approved OIDC authority is required");
  }
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "release" ||
    env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY ||
    env.GITHUB_SERVER_URL !== "https://github.com" ||
    env.GITHUB_REPOSITORY_ID !== "1312519623" ||
    env.GITHUB_REPOSITORY_OWNER_ID !== "309286193" ||
    env.GITHUB_SHA !== identity.gitCommit ||
    env.GITHUB_REF !== "refs/tags/" + identity.releaseTag ||
    env.GITHUB_WORKFLOW_SHA !== identity.gitCommit ||
    env.GITHUB_WORKFLOW_REF !==
      RELEASE_REPOSITORY +
        "/" +
        workflowPath +
        "@refs/tags/" +
        identity.releaseTag ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/^(?:[A-Za-z0-9-]+\.)*actions\.githubusercontent\.com$/u.test(
      url.hostname,
    ) ||
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== "string" ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
    Object.entries(env).some(
      ([key, value]) =>
        value &&
        /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN|NPM_AUTH|YARN_NPM_AUTH_TOKEN|npm_config_.*)$/iu.test(
          key,
        ),
    )
  )
    fail("approved token-free github-hosted OIDC authority is required");
}
async function nativeRun(command, args, { cwd, env }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    shell: false,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60_000,
  });
  if (result.error)
    fail("isolated release verification command failed to start");
  return result;
}
async function temporary(action) {
  const parent = await realpath(tmpdir()),
    directory = await mkdtemp(join(parent, "storage-release-proof-"));
  await chmod(directory, 0o700);
  try {
    return await action(directory);
  } finally {
    const actual = await realpath(directory);
    if (
      actual !== directory ||
      dirname(actual) !== parent ||
      !basename(actual).startsWith("storage-release-proof-")
    )
      fail("temporary cleanup refused an unexpected directory");
    await rm(actual, { recursive: true, force: true });
  }
}
async function treeFiles(directory) {
  const files = new Map();
  let directories = 0,
    total = 0;
  async function visit(current, prefix) {
    if (++directories > 6000 || prefix.split("/").length > 32)
      fail("reviewed npm tree exceeds its bound");
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name),
        key = prefix + entry.name;
      const details = await lstat(path);
      if (details.isSymbolicLink()) fail("reviewed npm tree contains a link");
      if (details.isDirectory()) await visit(path, key + "/");
      else if (details.isFile()) {
        total += details.size;
        if (
          files.size >= 3000 ||
          details.size > 16 * 1024 * 1024 ||
          total > 40 * 1024 * 1024
        )
          fail("reviewed npm tree exceeds its bound");
        files.set(key, await readFile(path));
      } else fail("reviewed npm tree contains an unsupported file");
    }
  }
  await visit(directory, "");
  return files;
}
async function npmContext(directory, options, seams) {
  let cli = options.npmCli ?? process.env.RELEASE_NPM_CLI;
  if (
    cli !== undefined &&
    (typeof cli !== "string" ||
      !isAbsolute(cli) ||
      basename(cli) !== "npm-cli.js" ||
      (await realpath(cli)) !== resolve(cli) ||
      !(await lstat(cli)).isFile() ||
      (await lstat(cli)).isSymbolicLink())
  )
    fail("an absolute reviewed npm CLI is required");
  const toolResponse = await request(npmArchiveUrl, seams.fetch);
  if (toolResponse.status !== 200)
    fail("the reviewed npm tool archive is unavailable");
  const toolBytes = await responseBytes(toolResponse, 16 * 1024 * 1024);
  if (!equal(hash(toolBytes), npmArchiveSha256))
    fail("the reviewed npm tool archive differs");
  // Authenticate the exact official archive before extraction or execution.
  // The default runs this owned tool, never a host-bundled npm tree whose
  // legitimate extra .bin links are not part of the published archive.
  gunzipSync(toolBytes, { maxOutputLength: 40 * 1024 * 1024 });
  const archive = join(directory, "npm-tool.tgz"),
    expected = join(directory, "npm-tool");
  await writeFile(archive, toolBytes, { flag: "wx" });
  await mkdir(expected);
  const run = seams.run ?? nativeRun;
  const extracted = await run("tar", ["-xzf", archive, "-C", expected], {
    cwd: directory,
    env: isolatedVerificationEnvironment(process.env, directory),
  });
  if (extracted?.status !== 0) fail("reviewed npm archive extraction failed");
  const expectedTree = await treeFiles(join(expected, "package"));
  if (
    !expectedTree.has("bin/npm-cli.js") ||
    JSON.parse(expectedTree.get("package.json").toString("utf8")).version !==
      RELEASE_NPM_VERSION
  )
    fail("npm tool files differ from the pinned official release");
  if (cli === undefined) {
    cli = join(expected, "package", "bin", "npm-cli.js");
  } else {
    // An explicitly reviewed CLI remains an exact-tree contract. Do not
    // permit links, extra installed files, or another npm implementation.
    const actualTree = await treeFiles(dirname(dirname(cli)));
    if (
      expectedTree.size !== actualTree.size ||
      [...expectedTree].some(
        ([name, bytes]) => !actualTree.get(name)?.equals(bytes),
      )
    )
      fail("npm tool files differ from the pinned official release");
  }
  await writeFile(join(directory, "user.npmrc"), "", {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(directory, "global.npmrc"), "", {
    flag: "wx",
    mode: 0o600,
  });
  const env = isolatedVerificationEnvironment(
    seams.env ?? process.env,
    directory,
  );
  async function invoke(args) {
    const result = await run(process.execPath, [cli, ...args], {
      cwd: directory,
      env,
    });
    if (options.output && result && typeof result.stdout === "string") {
      const label =
        args[0] === "audit"
          ? "npm-audit-signatures"
          : args[0] === "install"
            ? "npm-install"
            : "npm-version";
      await writeFile(
        join(
          resolve(options.output),
          (options.proofPrefix ?? "") + label + ".stdout",
        ),
        result.stdout,
        { flag: "wx" },
      );
      await writeFile(
        join(
          resolve(options.output),
          (options.proofPrefix ?? "") + label + ".stderr",
        ),
        result.stderr ?? "",
        { flag: "wx" },
      );
    }
    if (result?.status !== 0 || typeof result.stdout !== "string")
      fail("reviewed npm command failed");
    return result.stdout;
  }
  if ((await invoke(["--version"])).trim() !== RELEASE_NPM_VERSION)
    fail("reviewed npm version differs");
  return { invoke, run, env, cli };
}
function derValue(bytes, start) {
  const tag = bytes[start],
    initial = bytes[start + 1];
  if (initial === undefined) fail("invalid provenance certificate");
  let offset = start + 2,
    length = initial;
  if (initial > 127) {
    const count = initial & 127;
    if (count < 1 || count > 4 || offset + count > bytes.length)
      fail("invalid provenance certificate");
    length = 0;
    for (let index = 0; index < count; index += 1)
      length = length * 256 + bytes[offset++];
  }
  if (offset + length > bytes.length) fail("invalid provenance certificate");
  return {
    tag,
    value: bytes.subarray(offset, offset + length),
    end: offset + length,
  };
}
function certificateIssuer(certificate) {
  const outer = derValue(certificate.raw, 0),
    tbs = derValue(outer.value, 0);
  if (outer.tag !== 0x30 || tbs.tag !== 0x30)
    fail("invalid provenance certificate");
  let extensions;
  for (let offset = 0; offset < tbs.value.length;) {
    const field = derValue(tbs.value, offset);
    if (field.tag === 0xa3) extensions = derValue(field.value, 0);
    offset = field.end;
  }
  if (extensions?.tag !== 0x30) fail("invalid provenance certificate");
  let issuer;
  for (let offset = 0; offset < extensions.value.length;) {
    const extension = derValue(extensions.value, offset);
    const oid = derValue(extension.value, 0);
    let value = derValue(extension.value, oid.end);
    if (value.tag === 0x01) value = derValue(extension.value, value.end);
    if (extension.tag !== 0x30 || oid.tag !== 0x06 || value.tag !== 0x04)
      fail("invalid provenance certificate");
    if (oid.value.toString("hex") === "2b0601040183bf300101") {
      if (issuer !== undefined) fail("invalid provenance certificate");
      issuer = value.value.toString("utf8");
    }
    offset = extension.end;
  }
  return issuer;
}
function certificateIdentity(bundle, tag) {
  const material = bundle?.verificationMaterial;
  const encoded =
    material?.certificate?.rawBytes ??
    material?.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (typeof encoded !== "string" || encoded.length > 64 * 1024)
    fail("invalid provenance certificate");
  const certificate = new X509Certificate(Buffer.from(encoded, "base64"));
  if (
    certificate.subjectAltName !==
      "URI:https://github.com/" +
        RELEASE_REPOSITORY +
        "/" +
        workflowPath +
        "@refs/tags/" +
        tag ||
    certificateIssuer(certificate) !==
      "https://token.actions.githubusercontent.com"
  )
    fail("authenticated certificate identity differs");
  return { validFrom: certificate.validFrom, validTo: certificate.validTo };
}
/** Only call with npm's genuine cryptographically verified audit output. */
export function verifyProvenanceAudit(audit, records, identity, policy) {
  if (
    !Array.isArray(audit?.invalid) ||
    audit.invalid.length ||
    !Array.isArray(audit.missing) ||
    audit.missing.length ||
    !Array.isArray(audit.verified)
  )
    fail("npm signatures or Sigstore verification failed");
  const facts = [];
  for (const record of records) {
    const entries = audit.verified.filter(
      (e) =>
        e.name === record.name &&
        e.version === record.version &&
        e.location === "node_modules/" + record.name &&
        e.registry === REGISTRY,
    );
    if (entries.length !== 1 || !Array.isArray(entries[0].attestationBundles))
      fail("verified registry root is missing");
    const bundles = entries[0].attestationBundles.filter(
      (e) => e.predicateType === provenanceType,
    );
    if (bundles.length !== 1)
      fail("verified SLSA bundle is missing or ambiguous");
    const origin = record.origin;
    if (!origin || !["registryReuse", "source"].includes(origin.kind))
      fail("provenance origin is invalid");
    const tag =
      origin.kind === "registryReuse" ? origin.sourceTag : identity.releaseTag;
    const commit =
      origin.kind === "registryReuse"
        ? origin.sourceCommit
        : identity.gitCommit;
    const certificate = certificateIdentity(bundles[0].bundle, tag);
    const envelope = bundles[0].bundle.dsseEnvelope;
    if (
      envelope?.payloadType !== "application/vnd.in-toto+json" ||
      typeof envelope.payload !== "string" ||
      envelope.payload.length > 1024 * 1024
    )
      fail("verified SLSA statement is invalid");
    const statement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8"),
    );
    const definition = statement.predicate?.buildDefinition,
      workflow = definition?.externalParameters?.workflow;
    const deps = definition?.resolvedDependencies;
    const invocation = statement.predicate?.runDetails?.metadata?.invocationId;
    const match =
      typeof invocation === "string" &&
      /^https:\/\/github\.com\/pegma-dev\/storage-core\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/u.exec(
        invocation,
      );
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== provenanceType ||
      !Array.isArray(statement.subject) ||
      statement.subject.length !== 1 ||
      statement.subject[0].name !==
        "pkg:npm/" +
          record.name.split("/").map(encodeURIComponent).join("/") +
          "@" +
          record.version ||
      !equal(
        statement.subject[0].digest?.sha512,
        Buffer.from(record.integrity.slice(7), "base64").toString("hex"),
      ) ||
      definition?.buildType !==
        "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1" ||
      workflow?.repository !== "https://github.com/" + RELEASE_REPOSITORY ||
      workflow.path !== workflowPath ||
      workflow.ref !== "refs/tags/" + tag ||
      definition.internalParameters?.github?.event_name !== "release" ||
      definition.internalParameters?.github?.repository_id !==
        policy.repositoryId ||
      definition.internalParameters?.github?.repository_owner_id !==
        policy.ownerId ||
      !Array.isArray(deps) ||
      deps.length !== 1 ||
      deps[0].uri !==
        "git+https://github.com/" + RELEASE_REPOSITORY + "@refs/tags/" + tag ||
      !equal(deps[0].digest?.gitCommit, commit) ||
      statement.predicate?.runDetails?.builder?.id !== policy.builder ||
      !match
    )
      fail("authenticated SLSA source identity differs");
    const runId = Number(match[1]),
      attempt = Number(match[2]);
    integer(runId);
    integer(attempt);
    if (origin.kind === "registryReuse") {
      if (
        runId !== origin.originalRunId ||
        attempt !== origin.originalRunAttempt
      )
        fail("authenticated original registry invocation differs");
    } else if (runId !== identity.runId || attempt > identity.runAttempt) {
      fail("authenticated publishing invocation differs");
    }
    facts.push({
      name: record.name,
      version: record.version,
      sourceCommit: commit,
      sourceTag: tag,
      runId,
      attempt,
      invocation,
      certificate,
    });
  }
  return facts;
}
async function githubJson(path, seams, output, filename) {
  const response = await request(
    "https://api.github.com/repos/" + RELEASE_REPOSITORY + "/" + path,
    seams.fetch,
  );
  if (response.status !== 200)
    fail("publishing workflow identity is unavailable");
  const bytes = await responseBytes(response, 4 * 1024 * 1024);
  if (output) await writeFile(join(output, filename), bytes, { flag: "wx" });
  return JSON.parse(bytes.toString("utf8"));
}
// These reviewed historical publishers predate the minimal schema 2 job.
// Future reuse entries still need genuine provenance and an actual modern
// publisher; adding another legacy workflow requires a reviewed binding here.
const historicalPublishers = [
  {
    sourceCommit: "647702464ec60ee688c8d16aea5922b0b1b600fc",
    sourceTag: "v0.4.0",
    runId: 30334062325,
    attempt: 1,
    jobId: 90195221537,
  },
  {
    sourceCommit: "68798f74d2f1a545a35a4e3fc3c2225543c9dcf7",
    sourceTag: "v0.4.1",
    runId: 30504107513,
    attempt: 1,
    jobId: 90750106220,
  },
];
/** Facts must already come from npm's genuine verified SLSA audit. */
export async function verifyPublishingJobs(facts, seams = {}, output) {
  if (!Array.isArray(facts) || facts.length > 4)
    fail("authenticated package set is invalid");
  const groups = new Map(),
    names = new Set();
  for (const fact of facts) {
    integer(fact.runId);
    integer(fact.attempt);
    if (
      !/^@pegma\/storage-(?:core|azure-tables|cloudflare-d1|dynamodb)$/u.test(
        fact.name,
      ) ||
      names.has(fact.name) ||
      !/^[a-f0-9]{40}$/u.test(fact.sourceCommit) ||
      !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(fact.sourceTag)
    )
      fail("authenticated package identity is invalid");
    names.add(fact.name);
    const key = JSON.stringify([
      fact.sourceCommit,
      fact.sourceTag,
      fact.runId,
      fact.attempt,
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fact);
  }
  const runs = new Map();
  const jobs = [];
  for (const group of groups.values()) {
    const { sourceCommit, sourceTag, runId, attempt } = group[0];
    if (!runs.has(runId))
      runs.set(
        runId,
        await githubJson(
          "actions/runs/" + runId,
          seams,
          output,
          "github-original-run-" + runId + ".json",
        ),
      );
    const run = runs.get(runId);
    if (
      run.id !== runId ||
      run.head_sha !== sourceCommit ||
      run.head_branch !== sourceTag ||
      run.event !== "release" ||
      run.path !== workflowPath ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < attempt ||
      String(run.repository?.id) !== "1312519623" ||
      String(run.repository?.owner?.id) !== "309286193"
    )
      fail("original publishing run does not match the approved source");
    const page = await githubJson(
      "actions/runs/" + runId + "/attempts/" + attempt + "/jobs?per_page=100",
      seams,
      output,
      "github-original-run-" + runId + "-attempt-" + attempt + "-jobs.json",
    );
    if (
      !Array.isArray(page.jobs) ||
      !Number.isSafeInteger(page.total_count) ||
      page.total_count !== page.jobs.length ||
      page.total_count > 100
    )
      fail("publisher job set is unavailable");
    const legacy = historicalPublishers.find((entry) => entry.runId === runId);
    if (
      legacy &&
      (legacy.sourceCommit !== sourceCommit ||
        legacy.sourceTag !== sourceTag ||
        legacy.attempt !== attempt)
    )
      fail("historical publisher binding differs");
    const stepName = legacy
      ? "Publish verified prepared tarballs"
      : "Verify and publish the prepared release";
    const matches = page.jobs.filter((job) => job.name === "publish");
    if (
      matches.length !== 1 ||
      matches[0].status !== "completed" ||
      !["success", "failure"].includes(matches[0].conclusion) ||
      matches[0].run_id !== runId ||
      matches[0].run_attempt !== attempt ||
      matches[0].head_sha !== sourceCommit ||
      matches[0].head_branch !== sourceTag ||
      (legacy && matches[0].id !== legacy.jobId) ||
      !Array.isArray(matches[0].steps) ||
      matches[0].steps.length > 1000
    )
      fail("original publisher job is unavailable or ambiguous");
    const job = matches[0];
    integer(job.id);
    const steps = job.steps.filter((step) =>
      [
        "Publish verified prepared tarballs",
        "Verify and publish the prepared release",
      ].includes(step.name),
    );
    if (
      steps.length !== 1 ||
      steps[0].name !== stepName ||
      steps[0].status !== "completed" ||
      !["success", "failure"].includes(steps[0].conclusion)
    )
      fail("original publishing step is unavailable or ambiguous");
    const step = steps[0],
      start = Date.parse(job.started_at),
      end = Date.parse(job.completed_at),
      stepStart = Date.parse(step.started_at),
      stepEnd = Date.parse(step.completed_at);
    if (
      ![start, end, stepStart, stepEnd].every(Number.isFinite) ||
      start > stepStart ||
      stepStart > stepEnd ||
      stepEnd > end
    )
      fail("original publisher time bounds are invalid");
    for (const fact of group) {
      const validFrom = Date.parse(fact.certificate?.validFrom),
        validTo = Date.parse(fact.certificate?.validTo);
      if (
        !Number.isFinite(validFrom) ||
        !Number.isFinite(validTo) ||
        validFrom > validTo ||
        validFrom > stepEnd ||
        validTo < stepStart
      )
        fail("authenticated certificate does not overlap the actual publisher");
    }
    jobs.push({
      id: job.id,
      runId,
      attempt,
      sourceCommit,
      sourceTag,
      packages: group.map((fact) => fact.name),
      stepName,
      conclusion: job.conclusion,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      stepStartedAt: step.started_at,
      stepCompletedAt: step.completed_at,
    });
  }
  return jobs;
}
async function freshProof(directory) {
  if (typeof directory !== "string" || directory.length === 0)
    fail("a fresh proof directory is required");
  const result = resolve(directory);
  await mkdir(result, { recursive: false });
  return result;
}
async function verifyRegistryRecords(records, identity, options, seams = {}) {
  const output = await freshProof(options.output);
  return temporary(async (directory) => {
    const context = await npmContext(directory, options, seams);
    const packageJson = {
      name: "storage-registry-proof",
      private: true,
      type: "module",
      dependencies: Object.fromEntries(records.map((r) => [r.name, r.version])),
    };
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify(packageJson) + "\n",
      { flag: "wx" },
    );
    await context.invoke([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      REGISTRY,
    ]);
    const lockBytes = await readFile(join(directory, "package-lock.json"));
    await writeFile(join(output, "package-lock.json"), lockBytes, {
      flag: "wx",
    });
    const lock = JSON.parse(lockBytes);
    for (const record of records) {
      const installed = lock.packages?.["node_modules/" + record.name];
      if (
        installed?.version !== record.version ||
        installed.link === true ||
        installed.resolved !== canonicalTarball(record) ||
        !equal(installed.integrity, record.integrity)
      )
        fail("registry consumer dependency identity differs");
    }
    const auditText = await context.invoke([
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--registry",
      REGISTRY,
    ]);
    await writeFile(join(output, "npm-audit-signatures.json"), auditText, {
      flag: "wx",
    });
    const audit = JSON.parse(auditText);
    const { policy, sha256: policySha256 } = await loadReusePolicy();
    const facts = verifyProvenanceAudit(audit, records, identity, policy);
    const jobs = await verifyPublishingJobs(facts, seams, output);
    await writeFile(
      join(output, "publishing-jobs.json"),
      JSON.stringify(jobs, null, 2) + "\n",
      { flag: "wx" },
    );
    const result = {
      status: "REGISTRY_BYTES_CRYPTO_SOURCE_PASS",
      repository: RELEASE_REPOSITORY,
      identity,
      policySha256,
      npmVersion: RELEASE_NPM_VERSION,
      npmArchiveSha256,
      lockSha256: hash(lockBytes),
      auditSha256: hash(Buffer.from(auditText)),
      packages: facts,
      publishingJobs: jobs,
    };
    await writeFile(
      join(output, "verification.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx" },
    );
    return result;
  });
}
export async function verifyReusedPackages(
  records,
  identity,
  options,
  seams = {},
) {
  return verifyRegistryRecords(
    records.filter((r) => r.origin.kind === "registryReuse"),
    identity,
    options,
    seams,
  );
}
function publicationIdentity(options, manifest) {
  const runId = Number(options.runId ?? process.env.GITHUB_RUN_ID);
  const runAttempt = Number(
    options.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT,
  );
  integer(runId);
  integer(runAttempt);
  if (manifest.releaseTag === null)
    fail("registry release qualification requires the exact stable tag");
  return {
    gitCommit: manifest.gitCommit,
    releaseTag: manifest.releaseTag,
    runId,
    runAttempt,
  };
}
export async function preflightRegistry(verified, options, seams = {}) {
  if (
    typeof options.manifest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(options.expectedManifestSha256 ?? "")
  )
    fail("preflight requires the original independently sealed manifest");
  const { verifyPreparedManifest } = await import("./release-packages.mjs");
  const original = await verifyPreparedManifest(options.manifest, options);
  if (JSON.stringify(original) !== JSON.stringify(verified))
    fail("preflight manifest differs from original bytes");
  const { policy } = await loadReusePolicy();
  const existing = [],
    decisions = [];
  for (const record of verified.packages) {
    const response = await request(
      REGISTRY + encodeURIComponent(record.name) + "/" + record.version,
      seams.fetch,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      if (record.origin.kind !== "source")
        fail("required original registry package is missing");
      decisions.push({
        name: record.name,
        version: record.version,
        action: "publish",
      });
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      fail("registry package availability is unknown");
    }
    await response.body?.cancel();
    await downloadRegistryArtifact(
      { ...record, tarballUrl: canonicalTarball(record) },
      seams,
    );
    if (record.origin.kind === "registryReuse") {
      const expected = policy.packages.find(
        (p) => p.name === record.name && p.version === record.version,
      );
      if (!expected || !equal(expected.integrity, record.integrity))
        fail("reuse policy differs");
    }
    existing.push(record);
    decisions.push({
      name: record.name,
      version: record.version,
      action: "skip",
    });
  }
  // Finish cryptographic verification of the entire existing set before a
  // caller receives even one publication decision.
  const identity = publicationIdentity(options, verified);
  const proof = await verifyRegistryRecords(existing, identity, options, seams);
  await verifyPreparedManifest(options.manifest, options);
  const result = {
    schemaVersion: 1,
    repository: RELEASE_REPOSITORY,
    gitCommit: verified.gitCommit,
    releaseTag: verified.releaseTag,
    manifestSha256: options.expectedManifestSha256,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    decisions,
    registryProof: proof,
  };
  await writeFile(
    join(resolve(options.output), "preflight.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  return result;
}
const publicConsumer = String.raw`import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMemoryStore, defineCollection, StorageError, ConcurrencyError } from "@pegma/storage-core";
import { conformanceCases } from "@pegma/storage-core/conformance";
import { createDynamoDbStore } from "@pegma/storage-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
assert.equal(import.meta.resolve("@pegma/storage-core"),
  import.meta.resolve("@pegma/storage-core", import.meta.resolve("@pegma/storage-dynamodb")));
for (const name of ["@pegma/storage-core","@pegma/storage-azure-tables","@pegma/storage-cloudflare-d1","@pegma/storage-dynamodb"]) await import(name);
const client = new DynamoDBClient({ region:"us-east-1", endpoint:"http://127.0.0.1:10103",
  credentials:{accessKeyId:"local",secretAccessKey:"local"} });
let ordinal=0;
const fresh = () => {
  const tableName="releasetest"+process.pid+"t"+(++ordinal);
  return () => createDynamoDbStore({client,tableName});
};
try {
  assert.ok(Array.isArray(conformanceCases) && conformanceCases.length > 0);
  for(const test of conformanceCases) await test.run(fresh());
  const definition=defineCollection({name:"release_identity",key:v=>({partition:v.partition,id:v.id}),
    codec:{encode:v=>({...v}),decode:v=>({...v})}});
  const collection=fresh()().collection(definition);
  await assert.rejects(collection.transact("one",[{action:"insert",value:{partition:"two",id:"a",label:"fictional"}}]), e=>e instanceof StorageError);
  const value={partition:"one",id:"a",label:"fictional"};
  await collection.put(value);
  await assert.rejects(collection.update({partition:"one",id:"a"},async()=>{await collection.put(value);return {action:"write",value};},{maxAttempts:1}),e=>e instanceof ConcurrencyError);
  const memory=createMemoryStore().collection(definition);
  await memory.put(value); assert.deepEqual(await memory.get({partition:"one",id:"a"}),value);
  process.stdout.write(JSON.stringify({status:"PUBLIC_REGISTRY_CORE040_DYNAMO_CONFORMANCE_PASS",
    conformanceCases:conformanceCases.length,storageErrorIdentity:true,concurrencyErrorIdentity:true,backend:"DynamoDB Local"})+"\n");
} finally { client.destroy(); }
`;
async function admitConsumerAwsSdk(options, seams) {
  const response = await request(
    REGISTRY +
      encodeURIComponent(consumerAwsSdk.name) +
      "/" +
      consumerAwsSdk.version,
    seams.fetch,
  );
  if (response.status !== 200) {
    await response.body?.cancel();
    fail("reviewed consumer AWS SDK metadata is unavailable");
  }
  const bytes = await responseBytes(response, 2 * 1024 * 1024);
  const metadata = JSON.parse(bytes.toString("utf8"));
  if (
    metadata.name !== consumerAwsSdk.name ||
    metadata.version !== consumerAwsSdk.version ||
    metadata.dist?.tarball !== consumerAwsSdk.tarballUrl ||
    !equal(metadata.dist?.integrity, consumerAwsSdk.integrity)
  )
    fail("reviewed consumer AWS SDK metadata differs");
  const archiveResponse = await request(consumerAwsSdk.tarballUrl, seams.fetch);
  if (archiveResponse.status !== 200) {
    await archiveResponse.body?.cancel();
    fail("reviewed consumer AWS SDK archive is unavailable");
  }
  const archive = await responseBytes(archiveResponse, maximumTarBytes);
  if (
    !equal(
      "sha512-" + hash(archive, "sha512", "base64"),
      consumerAwsSdk.integrity,
    )
  )
    fail("reviewed consumer AWS SDK archive differs");
  if (options.output) {
    const output = resolve(options.output);
    await writeFile(join(output, "consumer-aws-sdk-metadata.json"), bytes, {
      flag: "wx",
    });
    await writeFile(join(output, "consumer-aws-sdk.tgz"), archive, {
      flag: "wx",
    });
    await writeFile(
      join(output, "consumer-aws-sdk-admission.json"),
      JSON.stringify(
        {
          ...consumerAwsSdk,
          archiveSha256: hash(archive),
          archiveBytes: archive.length,
          metadataSha256: hash(bytes),
          scope:
            "Pinned direct consumer root only; no transitive or AWS provenance qualification",
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  }
}
export async function runPublicConsumer(manifest, options = {}, seams = {}) {
  return temporary(async (directory) => {
    const context = await npmContext(
      directory,
      { ...options, proofPrefix: "consumer-" },
      seams,
    );
    const packed = options.manifest !== undefined;
    const dependencies = Object.fromEntries(
      manifest.packages.map((r) => [
        r.name,
        packed && r.origin.kind === "source"
          ? "file:" + resolve(dirname(options.manifest), r.tarball)
          : r.version,
      ]),
    );
    const dynamo = manifest.packages.find(
      (r) => r.name === "@pegma/storage-dynamodb",
    );
    if (
      !dynamo ||
      dynamo.package.dependencies?.["@pegma/storage-core"] !== "0.4.0"
    )
      fail("Dynamo consumer requires the genuine released Core0.4.0");
    if (dynamo.package.dependencies?.[consumerAwsSdk.name] !== "^3.1097.0")
      fail(
        "Dynamo consumer AWS SDK declaration differs from the reviewed range",
      );
    dependencies[consumerAwsSdk.name] = consumerAwsSdk.version;
    await admitConsumerAwsSdk(options, seams);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "storage-public-consumer",
        private: true,
        type: "module",
        dependencies,
      }) + "\n",
      { flag: "wx" },
    );
    await context.invoke([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      REGISTRY,
    ]);
    const lock = JSON.parse(
      await readFile(join(directory, "package-lock.json"), "utf8"),
    );
    for (const record of manifest.packages) {
      const installed = lock.packages?.["node_modules/" + record.name];
      if (
        installed?.version !== record.version ||
        installed.link ||
        !equal(installed.integrity, record.integrity) ||
        ((!packed || record.origin.kind !== "source") &&
          installed.resolved !== canonicalTarball(record))
      )
        fail("public consumer resolved an unexpected package");
    }
    const sdkKey = "node_modules/" + consumerAwsSdk.name;
    if (!Object.hasOwn(lock.packages ?? {}, sdkKey))
      fail("public consumer AWS SDK root is missing");
    for (const [key, installed] of Object.entries(lock.packages)) {
      if (key !== sdkKey && !key.endsWith("/" + sdkKey)) continue;
      if (
        !key.startsWith("node_modules/") ||
        key.includes("\\") ||
        key.split("/").some((part) => ["", ".", ".."].includes(part)) ||
        installed?.version !== consumerAwsSdk.version ||
        installed.link ||
        !equal(installed.integrity, consumerAwsSdk.integrity) ||
        installed.resolved !== consumerAwsSdk.tarballUrl
      )
        fail("public consumer resolved an unexpected AWS SDK");
      const sdkDirectory = join(directory, key);
      const details = await lstat(sdkDirectory);
      const sdkManifest = join(sdkDirectory, "package.json");
      const metadata = await lstat(sdkManifest);
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        (await realpath(sdkDirectory)) !== resolve(sdkDirectory) ||
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 1024 * 1024 ||
        (await realpath(sdkManifest)) !== resolve(sdkManifest)
      )
        fail("public consumer AWS SDK files have an unexpected origin");
      const actual = JSON.parse(await readFile(sdkManifest, "utf8"));
      if (
        actual.name !== consumerAwsSdk.name ||
        actual.version !== consumerAwsSdk.version
      )
        fail("public consumer AWS SDK file identity differs");
    }
    await writeFile(join(directory, "consumer.mjs"), publicConsumer, {
      flag: "wx",
    });
    // Only the already reviewed local-backend harness is loaded from source.
    // All component runtime imports resolve inside the isolated consumer.
    const runner =
      "import {setup,teardown} from " +
      JSON.stringify(pathToFileURL(join(root, "test/dynamodb-local.ts")).href) +
      ";\n" +
      "try { await setup(); await import(" +
      JSON.stringify(pathToFileURL(join(directory, "consumer.mjs")).href) +
      "); } finally { await teardown(); }\n";
    await writeFile(join(directory, "run.mjs"), runner, { flag: "wx" });
    const result = await context.run(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-import-meta-resolve",
        join(directory, "run.mjs"),
      ],
      { cwd: directory, env: context.env },
    );
    if (!result || typeof result.stdout !== "string")
      fail("public consumer command returned no result");
    if (options.output) {
      await writeFile(
        join(resolve(options.output), "public-consumer.stdout"),
        result.stdout,
        { flag: "wx" },
      );
      await writeFile(
        join(resolve(options.output), "public-consumer.stderr"),
        result.stderr ?? "",
        { flag: "wx" },
      );
      await copyFile(
        join(directory, "package-lock.json"),
        join(resolve(options.output), "public-consumer-lock.json"),
      );
    }
    if (result?.status !== 0) fail("public DynamoDB consumer did not pass");
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  });
}
export async function verifyRegistryRelease(manifest, options, seams = {}) {
  const plan = await preflightRegistry(manifest, options, seams);
  if (plan.decisions.some((entry) => entry.action !== "skip"))
    fail("complete release is not visible");
  const consumer = await runPublicConsumer(
    manifest,
    { ...options, manifest: undefined },
    seams,
  );
  if (
    !equal(
      hash(
        await readFile(
          join(resolve(options.output), "npm-audit-signatures.json"),
        ),
      ),
      plan.registryProof.auditSha256,
    ) ||
    !equal(
      hash(await readFile(join(resolve(options.output), "package-lock.json"))),
      plan.registryProof.lockSha256,
    )
  )
    fail("retained cryptographic proof changed during public imports");
  const { verifyPreparedManifest } = await import("./release-packages.mjs");
  await verifyPreparedManifest(options.manifest, options);
  const result = {
    ...plan,
    status: "STORAGE_REGISTRY_CRYPTO_SOURCE_PUBLIC_CONSUMER_PASS",
    consumer,
  };
  await writeFile(
    join(resolve(options.output), "verification.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
function cliOptions(args) {
  const result = {},
    seen = new Set();
  const fields = {
    "--manifest": "manifest",
    "--expected-release-commit": "expectedReleaseCommit",
    "--expected-manifest-sha256": "expectedManifestSha256",
    "--output": "output",
    "--run-id": "runId",
    "--run-attempt": "runAttempt",
    "--npm-cli": "npmCli",
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = fields[args[index]],
      value = args[index + 1];
    if (!key || !value || value.startsWith("--") || seen.has(key))
      fail("invalid release verifier arguments");
    seen.add(key);
    result[key] = value;
  }
  return result;
}
async function main() {
  const [command, ...args] = process.argv.slice(2),
    options = cliOptions(args);
  if (
    !["preflight", "verify"].includes(command) ||
    !options.manifest ||
    !/^[0-9a-f]{40}$/u.test(options.expectedReleaseCommit ?? "") ||
    !/^[0-9a-f]{64}$/u.test(options.expectedManifestSha256 ?? "")
  )
    fail(
      "usage: release-registry-verify.mjs preflight|verify --manifest --expected-release-commit --expected-manifest-sha256 --output --run-id --run-attempt",
    );
  const { verifyPreparedManifest } = await import("./release-packages.mjs");
  const manifest = await verifyPreparedManifest(options.manifest, options);
  if (command === "preflight") await preflightRegistry(manifest, options);
  else await verifyRegistryRelease(manifest, options);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Finish module evaluation before main imports the producer/registry cycle.
  // An unsettled CLI stays failed; only completed verification may succeed.
  process.exitCode = 13;
  main()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error) => {
      process.exitCode = 1;
      console.error(error instanceof Error ? error.message : String(error));
    });
}
