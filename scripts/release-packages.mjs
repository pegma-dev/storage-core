import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  constants,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadRegistryArtifact,
  inspectReleaseTarball,
  loadReusePolicy,
  registryReuseOrigin,
  runPublicConsumer,
  verifyReusedPackages,
} from "./release-registry-verify.mjs";

const REPOSITORY_URL = "git+https://github.com/pegma-dev/storage-core.git";
const NODE_RANGE = ">=22";
const REVIEWED_PNPM_VERSION = "10.34.5";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const RELEASE_TAG_PATTERN = /^v(0\.[1-9][0-9]*|[1-9][0-9]*\.[0-9]+)\.[0-9]+$/u;
const EXACT_PIN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const CARET_RANGE = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u;
const TILDE_RANGE = /^~(\d+\.\d+\.\d+)$/u;
// pnpm importers record these three. peerDependencies stay on the
// manifest; ProjectSnapshot does not write an importer.peerDependencies map.
const IMPORTER_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

export const RELEASE_PACKAGES = [
  {
    directory: "storage-core",
    name: "@pegma/storage-core",
  },
  {
    directory: "storage-azure-tables",
    name: "@pegma/storage-azure-tables",
  },
  {
    directory: "storage-cloudflare-d1",
    name: "@pegma/storage-cloudflare-d1",
  },
  {
    directory: "storage-dynamodb",
    name: "@pegma/storage-dynamodb",
  },
];

const RELEASE_NAMES = new Set(RELEASE_PACKAGES.map(({ name }) => name));

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

export function isolatedNpmEnvironment(
  source,
  userConfigPath,
  globalConfigPath,
) {
  const environment = {};
  const exact = new Set([
    "PATH",
    "HOME",
    "CI",
    "SYSTEMROOT",
    "RUNNER_TEMP",
    "RUNNER_TOOL_CACHE",
    "RUNNER_ENVIRONMENT",
    "TEMP",
    "TMP",
    "TMPDIR",
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
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ]);
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (exact.has(upper)) {
      environment[key] = value;
    }
  }
  environment.NPM_CONFIG_USERCONFIG = userConfigPath;
  environment.NPM_CONFIG_GLOBALCONFIG = globalConfigPath;
  return environment;
}

function runNpm(arguments_, options = {}) {
  // Always invoke npm itself. `pnpm run` sets npm_execpath to pnpm, and
  // trusted publishing plus `npm pack --json` are npm-registry operations.
  const configDirectory = mkdtempSync(join(tmpdir(), "pegma-npm-config-"));
  chmodSync(configDirectory, 0o700);
  const userConfigPath = join(configDirectory, "userconfig");
  const globalConfigPath = join(configDirectory, "globalconfig");
  try {
    writeFileSync(userConfigPath, "", { mode: 0o600 });
    writeFileSync(globalConfigPath, "", { mode: 0o600 });
    chmodSync(userConfigPath, 0o600);
    chmodSync(globalConfigPath, 0o600);
    return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, {
      ...options,
      env: isolatedNpmEnvironment(
        options.env ?? process.env,
        userConfigPath,
        globalConfigPath,
      ),
      shell: process.platform === "win32",
    });
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
}

function decodeYamlScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Reads pnpm-lock.yaml importers without a YAML dependency. */
export function parsePnpmLockfileImporters(text) {
  const importers = {};
  let inImporters = false;
  let currentImporter = null;
  let currentSection = null;
  let currentDep = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!inImporters) {
      if (line === "importers:") {
        inImporters = true;
      }
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ") && line.endsWith(":")) {
      break;
    }
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const importerMatch = /^ {2}(\S+):(?: \{\})?$/u.exec(line);
    if (importerMatch !== null) {
      currentImporter = decodeYamlScalar(importerMatch[1]);
      importers[currentImporter] = {};
      currentSection = null;
      currentDep = null;
      continue;
    }
    const sectionMatch =
      /^ {4}(dependencies|devDependencies|optionalDependencies|peerDependencies):$/u.exec(
        line,
      );
    if (sectionMatch !== null && currentImporter !== null) {
      currentSection = sectionMatch[1];
      importers[currentImporter][currentSection] = {};
      currentDep = null;
      continue;
    }
    const depMatch = /^ {6}(\S+):$/u.exec(line);
    if (
      depMatch !== null &&
      currentImporter !== null &&
      currentSection !== null
    ) {
      currentDep = decodeYamlScalar(depMatch[1]);
      importers[currentImporter][currentSection][currentDep] = {};
      continue;
    }
    const fieldMatch = /^ {8}(specifier|version): (.+)$/u.exec(line);
    if (
      fieldMatch !== null &&
      currentImporter !== null &&
      currentSection !== null &&
      currentDep !== null
    ) {
      importers[currentImporter][currentSection][currentDep][fieldMatch[1]] =
        decodeYamlScalar(fieldMatch[2]);
    }
  }
  if (!inImporters) {
    fail("pnpm-lock.yaml is missing an importers section");
  }
  return importers;
}

function lockResolvedVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    return undefined;
  }
  if (version.startsWith("link:")) {
    return version;
  }
  const peerSuffix = version.indexOf("(");
  return peerSuffix === -1 ? version : version.slice(0, peerSuffix);
}

function parseStableSemver(version) {
  const match = STABLE_SEMVER.exec(version);
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left, right) {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

function satisfiesCaret(specifier, parsed) {
  const caret = CARET_RANGE.exec(specifier);
  if (caret === null) {
    return undefined;
  }
  const major = Number(caret[1]);
  const hasMinor = caret[2] !== undefined;
  const hasPatch = caret[3] !== undefined;
  const minor = hasMinor ? Number(caret[2]) : 0;
  const patch = hasPatch ? Number(caret[3]) : 0;
  const minimum = { major, minor, patch };
  if (compareSemver(parsed, minimum) < 0) {
    return false;
  }
  if (!hasMinor) {
    // ^1 := >=1.0.0 <2.0.0-0; ^0 := >=0.0.0 <1.0.0-0
    return parsed.major === major;
  }
  if (!hasPatch) {
    // ^1.2 := >=1.2.0 <2.0.0-0
    // ^0.2 := >=0.2.0 <0.3.0-0
    // ^0.0 := >=0.0.0 <0.1.0-0
    return major === 0
      ? parsed.major === 0 && parsed.minor === minor
      : parsed.major === major;
  }
  if (major === 0 && minor === 0) {
    // ^0.0.3 := >=0.0.3 <0.0.4-0 — not a tilde that allows 0.0.4
    return compareSemver(parsed, minimum) === 0;
  }
  if (major === 0) {
    return parsed.major === 0 && parsed.minor === minor;
  }
  return parsed.major === major;
}

export function lockVersionSatisfiesSpecifier(specifier, version) {
  const resolved = lockResolvedVersion(version);
  if (resolved === undefined || resolved.length === 0) {
    return false;
  }
  if (resolved.startsWith("link:")) {
    return true;
  }
  if (EXACT_PIN.test(specifier)) {
    return resolved === specifier;
  }
  const parsed = parseStableSemver(resolved);
  if (parsed === null) {
    return false;
  }
  const caret = satisfiesCaret(specifier, parsed);
  if (caret !== undefined) {
    return caret;
  }
  const tilde = TILDE_RANGE.exec(specifier);
  if (tilde !== null) {
    const minimum = parseStableSemver(tilde[1]);
    return (
      minimum !== null &&
      parsed.major === minimum.major &&
      parsed.minor === minimum.minor &&
      compareSemver(parsed, minimum) >= 0
    );
  }
  return true;
}

export function validateLockImporter(importer, manifest, location) {
  for (const section of IMPORTER_SECTIONS) {
    const declared = manifest[section] ?? {};
    const locked = importer?.[section] ?? {};
    const names = new Set([...Object.keys(declared), ...Object.keys(locked)]);
    for (const name of names) {
      const specifier = declared[name];
      const entry = locked[name];
      if (specifier === undefined) {
        fail(
          `${location} ${section}.${name} is not declared in the package manifest`,
        );
      }
      if (
        entry?.specifier !== specifier ||
        typeof entry.version !== "string" ||
        entry.version.length === 0 ||
        !lockVersionSatisfiesSpecifier(specifier, entry.version)
      ) {
        fail(
          `${location} ${section}.${name} must match its own specifier and resolved version`,
        );
      }
    }
  }
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function hashTarball(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function exportTargets(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

async function validatePackage(root, definition, lockfile) {
  const packageDirectory = join(root, "packages", definition.directory);
  const manifest = await readJson(join(packageDirectory, "package.json"));
  if (manifest.name !== definition.name) {
    fail(`expected ${definition.name} in packages/${definition.directory}`);
  }
  if (!STABLE_SEMVER.test(manifest.version)) {
    fail(`${definition.name} must use a stable semantic version`);
  }
  if (
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.engines?.node !== NODE_RANGE ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== `packages/${definition.directory}`
  ) {
    fail(`${definition.name} has invalid public package metadata`);
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => !entry.startsWith("dist/"))
  ) {
    fail(`${definition.name} must publish only its dist allowlist`);
  }
  if (
    typeof manifest.scripts?.prepack !== "string" ||
    !manifest.scripts.prepack.includes("build")
  ) {
    fail(`${definition.name} must build during prepack`);
  }
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail(`${definition.name} exports must point into dist`);
  }
  await stat(join(packageDirectory, "README.md"));
  await stat(join(packageDirectory, "LICENSE"));

  const lockEntry = lockfile[`packages/${definition.directory}`];
  if (lockEntry === undefined || typeof lockEntry !== "object") {
    fail(`${definition.name} is not synchronized with pnpm-lock.yaml`);
  }
  validateLockImporter(
    lockEntry,
    manifest,
    `pnpm-lock.yaml importers[packages/${definition.directory}]`,
  );
  for (const section of IMPORTER_SECTIONS) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!RELEASE_NAMES.has(name)) {
        continue;
      }
      const dependency = RELEASE_PACKAGES.find((entry) => entry.name === name);
      const dependencyManifest = await readJson(
        join(root, "packages", dependency.directory, "package.json"),
      );
      const lockDependency = lockEntry[section]?.[name];
      if (
        version !== dependencyManifest.version ||
        lockDependency?.specifier !== version ||
        typeof lockDependency?.version !== "string" ||
        !lockDependency.version.startsWith("link:")
      ) {
        fail(
          `${definition.name} must pin ${name} to its exact workspace version`,
        );
      }
    }
  }
  for (const [name, version] of Object.entries(
    manifest.peerDependencies ?? {},
  )) {
    if (!RELEASE_NAMES.has(name)) {
      continue;
    }
    const dependency = RELEASE_PACKAGES.find((entry) => entry.name === name);
    const dependencyManifest = await readJson(
      join(root, "packages", dependency.directory, "package.json"),
    );
    if (version !== dependencyManifest.version) {
      fail(
        `${definition.name} must pin ${name} to its exact workspace version`,
      );
    }
  }
  return { definition, manifest, packageDirectory };
}

async function publicWorkspaceInventory(root) {
  const directories = await readdir(join(root, "packages"), {
    withFileTypes: true,
  });
  const names = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) {
      continue;
    }
    const manifestPath = join(root, "packages", directory.name, "package.json");
    try {
      const manifest = await readJson(manifestPath);
      if (manifest.private !== true) {
        names.push(manifest.name);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return names.sort();
}

async function removeTsBuildInfo(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") {
        await removeTsBuildInfo(path);
      }
    } else if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
      await rm(path, { force: true });
    }
  }
}

async function cleanWorkspaceBuildArtifacts(root) {
  for (const { directory } of RELEASE_PACKAGES) {
    const packageDirectory = join(root, "packages", directory);
    await rm(join(packageDirectory, "dist"), { recursive: true, force: true });
    await removeTsBuildInfo(packageDirectory);
  }
}

export function validateReleaseTag(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag === undefined || !RELEASE_TAG_PATTERN.test(releaseTag)) {
    fail("a stable vX.Y.Z release tag at v0.1.0 or later is required");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40}$/u.test(expectedReleaseCommit)
  ) {
    fail("an exact release event commit is required");
  }

  const tagRef = `refs/tags/${releaseTag}`;
  const objectType = run(gitCommand(), ["cat-file", "-t", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (objectType.status !== 0 || objectType.stdout.trim() !== "tag") {
    fail("the release ref must be an annotated tag object");
  }
  const headCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const tagCommit = run(gitCommand(), ["rev-parse", `${tagRef}^{commit}`], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(headCommit, tagCommit) ||
    !safeEqual(headCommit, expectedReleaseCommit)
  ) {
    fail(
      "the release checkout, signed tag target, and release event commit must match",
    );
  }
  const signature = run(gitCommand(), ["verify-tag", "--raw", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("the release tag signature is not valid for an approved signer");
  }
  const onMain = run(
    gitCommand(),
    ["merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"],
    { cwd: root, capture: true, allowFailure: true },
  );
  if (onMain.status !== 0) {
    fail("the release tag commit must be contained in origin/main");
  }
  return { headCommit, releaseTag };
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const rootManifest = await readJson(join(root, "package.json"));
  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== `pnpm@${REVIEWED_PNPM_VERSION}`
  ) {
    fail(`the private root must pin pnpm@${REVIEWED_PNPM_VERSION}`);
  }
  const expectedInventory = RELEASE_PACKAGES.map(({ name }) => name).sort();
  const actualInventory = await publicWorkspaceInventory(root);
  if (!sameJson(actualInventory, expectedInventory)) {
    fail("public workspace inventory does not match the reviewed release list");
  }
  const lockfile = parsePnpmLockfileImporters(
    await readFile(join(root, "pnpm-lock.yaml"), "utf8"),
  );
  const packages = [];
  for (const definition of RELEASE_PACKAGES) {
    packages.push(await validatePackage(root, definition, lockfile));
  }

  if (options.requireClean) {
    const status = run(gitCommand(), ["status", "--porcelain"], {
      cwd: root,
      capture: true,
    }).stdout;
    if (status.trim() !== "") {
      fail("release preparation requires a clean checkout");
    }
  }
  if (options.requireMainAncestor) {
    const head = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    const onMain = run(
      gitCommand(),
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, capture: true, allowFailure: true },
    );
    if (onMain.status !== 0) {
      fail("release commit must be contained in origin/main");
    }
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined) {
    if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
      fail("release tag must be a stable vX.Y.Z tag at v0.1.0 or later");
    }
    const version = releaseTag.slice(1);
    if (!packages.some(({ manifest }) => manifest.version === version)) {
      fail(
        `release tag ${releaseTag} does not match any public package version`,
      );
    }
    const prerelease =
      options.releasePrerelease ?? process.env.RELEASE_PRERELEASE ?? false;
    if (prerelease === true || prerelease === "true") {
      fail("prereleases cannot publish packages");
    }
  }
  if (options.requireReleaseTag) {
    validateReleaseTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  return { root, packages, releaseTag };
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required)) {
      fail(`${manifest.name} tarball is missing ${required}`);
    }
  }
  if (
    paths.some(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !path.startsWith("dist/"),
    )
  ) {
    fail(
      `${manifest.name} tarball contains a file outside the reviewed allowlist`,
    );
  }
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//u, "");
    if (!paths.includes(path)) {
      fail(`${manifest.name} tarball is missing exported file ${path}`);
    }
  }
}

export function decidePublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === null) {
    return "publish";
  }
  if (safeEqual(localIntegrity, registryIntegrity)) {
    return "skip";
  }
  fail("the registry version exists with different tarball integrity");
}

export async function verifyReleaseInventory(manifestPath, suppliedManifest) {
  const directory = resolve(dirname(manifestPath));
  const manifest = suppliedManifest ?? (await readJson(manifestPath));
  if (!Array.isArray(manifest.packages)) {
    fail("prepared package manifest has no package inventory");
  }
  const expected = [
    "package-manifest.json",
    ...manifest.packages.map(({ tarball }) => tarball),
  ].sort();
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = entries.map(({ name }) => name).sort();
  if (!sameJson(actual, expected)) {
    fail("release output inventory does not match the package manifest");
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (
      entry.name.startsWith(".") ||
      !entry.isFile() ||
      details.isSymbolicLink()
    ) {
      fail("release output may contain only expected regular files");
    }
  }
  return manifest;
}

async function assertArtifactOutputAvailable(output) {
  let metadata;
  try {
    metadata = await lstat(output);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    fail(
      `release output must be an empty regular directory: ${output}; preserve existing evidence and choose a fresh --output`,
    );
  if ((await readdir(output)).length !== 0)
    fail(
      `release output directory must be empty: ${output}; preserve existing evidence and choose a fresh --output`,
    );
}

async function assertProofOutputAbsent(output) {
  try {
    await lstat(output);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(
    `release proof output already exists: ${output}; preserve existing evidence and choose a fresh --output`,
  );
}

export async function prepareRelease(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const output = resolve(root, options.output ?? ".release");
  const reuseOutput = output + "-reuse-verification";
  const consumerOutput = output + "-consumer-verification";
  // Check one fresh evidence namespace without deleting or modifying any
  // earlier result. Refuse before repository/tool/network/build work, even if
  // this invocation skips one of the later proof-producing steps.
  await assertArtifactOutputAvailable(output);
  await assertProofOutputAbsent(reuseOutput);
  await assertProofOutputAbsent(consumerOutput);
  const { packages, releaseTag } = await validateRepository({
    ...options,
    root,
  });
  const gitCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(gitCommit))
    fail("git returned an invalid source commit");
  const assertSource = () => {
    const current = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    if (!safeEqual(current, gitCommit))
      fail("release source changed during preparation");
    if (
      options.requireClean &&
      run(gitCommand(), ["status", "--porcelain"], {
        cwd: root,
        capture: true,
      }).stdout.trim()
    )
      fail("release working source changed during preparation");
  };
  await mkdir(output, { recursive: true });
  await assertArtifactOutputAvailable(output);
  const { policy, sha256: registryPolicySha256 } = await loadReusePolicy();
  // Development preparation selects the highest candidate version. Only a
  // protected signed release tag can authorize actual publication.
  const selectedVersion =
    releaseTag?.slice(1) ??
    packages
      .map(({ manifest }) => manifest.version)
      .sort((a, b) =>
        compareSemver(parseStableSemver(b), parseStableSemver(a)),
      )[0];
  const selected = packages.filter(
    ({ manifest }) => manifest.version === selectedVersion,
  );
  const unselected = packages.filter(
    ({ manifest }) => manifest.version !== selectedVersion,
  );
  // Admit the complete reuse subset before any archive download or write.
  if (
    unselected.some(
      ({ manifest }) =>
        !policy.packages.some(
          (entry) =>
            entry.name === manifest.name && entry.version === manifest.version,
        ),
    )
  )
    fail("unselected workspace has no approved registry reuse policy");
  const records = [];
  for (const { definition, manifest } of packages) {
    if (manifest.version === selectedVersion) continue;
    const entry = policy.packages.find(
      (item) =>
        item.name === manifest.name && item.version === manifest.version,
    );
    if (entry === undefined)
      fail("unselected workspace has no approved registry reuse policy");
    const downloaded = await downloadRegistryArtifact(entry);
    const tarball =
      entry.name.slice(1).replace("/", "-") + "-" + entry.version + ".tgz";
    await writeFile(join(output, tarball), downloaded.bytes, { flag: "wx" });
    records.push({
      name: entry.name,
      version: entry.version,
      directory: definition.directory,
      tarball,
      size: downloaded.bytes.length,
      shasum: entry.shasum,
      sha256: entry.sha256,
      integrity: entry.integrity,
      publish: false,
      files: downloaded.files,
      package: downloaded.package,
      origin: registryReuseOrigin(entry),
    });
  }
  if (records.length) {
    await verifyReusedPackages(
      records,
      { gitCommit, releaseTag: releaseTag ?? null },
      { output: reuseOutput },
    );
  }
  assertSource();
  // Workspace builds are type/conformance preparation only. Unselected compiled
  // output is never packed or substituted for the original registry archives.
  await cleanWorkspaceBuildArtifacts(root);
  runNpm(["run", "build"], { cwd: root });
  for (const { definition, manifest } of selected) {
    const result = runNpm(
      [
        "pack",
        join(root, "packages", definition.directory),
        "--json",
        "--pack-destination",
        output,
      ],
      { cwd: root, capture: true },
    );
    const [packed] = JSON.parse(result.stdout);
    if (
      packed?.name !== definition.name ||
      packed.version !== manifest.version ||
      typeof packed.filename !== "string"
    )
      fail("npm pack returned invalid source metadata");
    const tarball = basename(packed.filename),
      bytes = await readFile(join(output, tarball));
    const hashes = hashTarball(bytes),
      inspected = inspectReleaseTarball(bytes);
    if (
      !safeEqual(hashes.integrity, packed.integrity) ||
      !safeEqual(hashes.shasum, packed.shasum) ||
      !sameJson(inspected.package, manifest)
    )
      fail("source tarball differs from its reviewed metadata");
    verifyPackedFiles(manifest, inspected.files);
    records.push({
      name: manifest.name,
      version: manifest.version,
      directory: definition.directory,
      tarball,
      size: bytes.length,
      ...hashes,
      publish: true,
      files: inspected.files,
      package: inspected.package,
      origin: {
        kind: "source",
        repository: "pegma-dev/storage-core",
        gitCommit,
        releaseTag: releaseTag ?? null,
        directory: definition.directory,
      },
    });
  }
  records.sort(
    (a, b) =>
      RELEASE_PACKAGES.findIndex((p) => p.name === a.name) -
      RELEASE_PACKAGES.findIndex((p) => p.name === b.name),
  );
  assertSource();
  const manifest = {
    schemaVersion: 2,
    repository: "pegma-dev/storage-core",
    gitCommit,
    releaseTag: releaseTag ?? null,
    registryPolicySha256,
    packages: records,
  };
  const manifestPath = join(output, "package-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  await verifyPreparedManifest(manifestPath, {
    root,
    expectedReleaseCommit: gitCommit,
  });
  if (!options.skipSmoke) {
    await mkdir(consumerOutput);
    await runPublicConsumer(manifest, {
      manifest: manifestPath,
      output: consumerOutput,
    });
    assertSource();
    await verifyPreparedManifest(manifestPath, {
      root,
      expectedReleaseCommit: gitCommit,
    });
  }
  return { manifestPath, manifest };
}

async function readPreparedFile(path, maximum) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximum ||
    (await realpath(path)) !== resolve(path)
  )
    fail("prepared file is outside its regular-file bound");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    )
      fail("prepared file changed while opening");
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== metadata.size) fail("prepared file changed while reading");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function verifyPreparedManifest(manifestPath, options = {}) {
  manifestPath = resolve(manifestPath);
  const manifestBytes = await readPreparedFile(manifestPath, 1024 * 1024);
  if (
    options.expectedManifestSha256 !== undefined &&
    (!/^[a-f0-9]{64}$/u.test(options.expectedManifestSha256) ||
      !safeEqual(
        createHash("sha256").update(manifestBytes).digest("hex"),
        options.expectedManifestSha256,
      ))
  )
    fail("prepared manifest independent digest differs");
  const manifest = await verifyReleaseInventory(
    manifestPath,
    JSON.parse(manifestBytes),
  );
  if (
    !sameJson(Object.keys(manifest).sort(), [
      "gitCommit",
      "packages",
      "registryPolicySha256",
      "releaseTag",
      "repository",
      "schemaVersion",
    ]) ||
    manifest.schemaVersion !== 2 ||
    manifest.repository !== "pegma-dev/storage-core" ||
    !/^[a-f0-9]{40}$/u.test(manifest.gitCommit) ||
    (manifest.releaseTag !== null &&
      !RELEASE_TAG_PATTERN.test(manifest.releaseTag)) ||
    !Array.isArray(manifest.packages) ||
    !sameJson(
      manifest.packages.map(({ name }) => name),
      RELEASE_PACKAGES.map(({ name }) => name),
    )
  )
    fail("prepared schema2 manifest identity or inventory is invalid");
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: options.root ?? defaultRoot(),
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(currentCommit, manifest.gitCommit) ||
    (options.expectedReleaseCommit !== undefined &&
      !safeEqual(options.expectedReleaseCommit, manifest.gitCommit))
  )
    fail("prepared manifest does not match the current approved checkout");
  const { policy, sha256 } = await loadReusePolicy();
  if (!safeEqual(sha256, manifest.registryPolicySha256))
    fail("registry reuse policy digest differs");
  if (!manifest.packages.some((record) => record.publish))
    fail("prepared release has no source candidates");
  const versions = new Map(manifest.packages.map((r) => [r.name, r.version]));
  for (const [index, record] of manifest.packages.entries()) {
    const definition = RELEASE_PACKAGES[index];
    if (
      !sameJson(Object.keys(record).sort(), [
        "directory",
        "files",
        "integrity",
        "name",
        "origin",
        "package",
        "publish",
        "sha256",
        "shasum",
        "size",
        "tarball",
        "version",
      ]) ||
      record.name !== definition.name ||
      record.directory !== definition.directory ||
      !STABLE_SEMVER.test(record.version) ||
      record.tarball !==
        record.name.slice(1).replace("/", "-") +
          "-" +
          record.version +
          ".tgz" ||
      basename(record.tarball) !== record.tarball ||
      !Number.isSafeInteger(record.size) ||
      record.size < 1 ||
      record.size > 4 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      !/^[a-f0-9]{40}$/u.test(record.shasum) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(record.integrity) ||
      typeof record.publish !== "boolean" ||
      record.package?.name !== record.name ||
      record.package.version !== record.version ||
      record.package.license !== "MIT" ||
      record.package.type !== "module" ||
      record.package.engines?.node !== NODE_RANGE ||
      record.package.publishConfig?.access !== "public" ||
      record.package.repository?.url !== REPOSITORY_URL ||
      record.package.repository?.directory !== "packages/" + record.directory
    )
      fail("prepared artifact metadata is invalid");
    if (record.publish) {
      if (
        !sameJson(record.origin, {
          kind: "source",
          repository: manifest.repository,
          gitCommit: manifest.gitCommit,
          releaseTag: manifest.releaseTag,
          directory: record.directory,
        }) ||
        (manifest.releaseTag !== null &&
          record.version !== manifest.releaseTag.slice(1))
      )
        fail("selected source origin differs from the release");
      const source = await readJson(
        join(
          options.root ?? defaultRoot(),
          "packages",
          record.directory,
          "package.json",
        ),
      );
      if (!sameJson(record.package, source))
        fail("selected package metadata differs from source");
    } else {
      const entry = policy.packages.find(
        (p) => p.name === record.name && p.version === record.version,
      );
      if (
        !entry ||
        !sameJson(record.origin, registryReuseOrigin(entry)) ||
        !safeEqual(record.sha256, entry.sha256) ||
        !safeEqual(record.integrity, entry.integrity) ||
        !safeEqual(record.shasum, entry.shasum) ||
        record.size !== entry.size ||
        (manifest.releaseTag !== null &&
          record.version === manifest.releaseTag.slice(1))
      )
        fail("registry reuse origin differs from independent policy");
    }
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, version] of Object.entries(
        record.package[section] ?? {},
      ))
        if (versions.has(name) && version !== versions.get(name))
          fail("prepared internal dependency pin differs");
    }
    const tarball = join(dirname(manifestPath), record.tarball),
      details = await lstat(tarball);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size !== record.size
    )
      fail("prepared artifact is not the original regular file");
    const bytes = await readPreparedFile(tarball, 4 * 1024 * 1024),
      hashes = hashTarball(bytes),
      inspected = inspectReleaseTarball(bytes);
    if (
      !safeEqual(hashes.sha256, record.sha256) ||
      !safeEqual(hashes.integrity, record.integrity) ||
      !safeEqual(hashes.shasum, record.shasum) ||
      !sameJson(inspected.files, record.files) ||
      !sameJson(inspected.package, record.package)
    )
      fail("prepared artifact bytes or contents differ");
    verifyPackedFiles(record.package, record.files);
  }
  return manifest;
}

export async function smokePreparedRelease(options = {}) {
  const output = options.output ? resolve(options.output) : undefined;
  if (output !== undefined) await assertProofOutputAbsent(output);
  const manifestPath = resolve(
    options.manifest ?? ".release/package-manifest.json",
  );
  const manifest = await verifyPreparedManifest(manifestPath, options);
  if (output !== undefined) await mkdir(output);
  const consumer = await runPublicConsumer(manifest, {
    ...options,
    manifest: manifestPath,
  });
  await verifyPreparedManifest(manifestPath, options);
  if (output !== undefined)
    await writeFile(
      join(output, "verification.json"),
      JSON.stringify(
        {
          status: "PREPARED_PUBLIC_CONSUMER_PASS",
          gitCommit: manifest.gitCommit,
          releaseTag: manifest.releaseTag,
          manifestSha256: options.expectedManifestSha256,
          consumer,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
}

/** Publication is exclusively workflow-owned; retained as a refusing compatibility export. */
export async function publishPreparedRelease() {
  fail(
    "release:publish is disabled; use the protected GitHub release workflow",
  );
}

export function parseArguments(arguments_) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (seen.has(argument)) fail(`duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === "--require-main-ancestor") {
      options.requireMainAncestor = true;
      continue;
    }
    if (argument === "--require-clean") {
      options.requireClean = true;
      continue;
    }
    if (argument === "--require-release-tag") {
      options.requireReleaseTag = true;
      continue;
    }
    if (argument === "--skip-smoke") {
      options.skipSmoke = true;
      continue;
    }
    const key =
      argument === "--root"
        ? "root"
        : argument === "--output"
          ? "output"
          : argument === "--manifest"
            ? "manifest"
            : argument === "--expected-release-commit"
              ? "expectedReleaseCommit"
              : argument === "--expected-manifest-sha256"
                ? "expectedManifestSha256"
                : argument === "--release-tag"
                  ? "releaseTag"
                  : null;
    if (
      key === null ||
      arguments_[index + 1] === undefined ||
      arguments_[index + 1].startsWith("--")
    ) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "check") {
    await validateRepository(options);
    process.stdout.write("Release metadata is valid.\n");
    return;
  }
  if (command === "pack") {
    const { manifestPath } = await prepareRelease(options);
    process.stdout.write(`Prepared release packages at ${manifestPath}.\n`);
    return;
  }
  if (command === "publish") {
    await publishPreparedRelease(options);
    return;
  }
  if (command === "smoke") {
    await smokePreparedRelease(options);
    process.stdout.write("Prepared release packages passed smoke checks.\n");
    return;
  }
  fail("usage: release-packages.mjs <check|pack|smoke|publish> [options]");
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
