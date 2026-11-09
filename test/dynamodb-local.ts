import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs Amazon's DynamoDB Local for the duration of the test run, so the
 * DynamoDB adapter is verified against a real implementation of the
 * protocol rather than a hand-written fake. A fake would only prove the
 * adapter agrees with its author's assumptions.
 *
 * The port is deliberately not DynamoDB Local's default, so a developer
 * already running it for something else does not collide with this. The
 * tarball is pinned by URL and SHA-256 computed from that official Amazon
 * archive (`dynamodb_local_2025-04-14.tar.gz`), not from a version
 * nickname. setup() refuses to extract until the digest matches. The
 * suite stages the verified tarball in a private process directory and
 * extracts a fresh copy per run. This harness is only the DynamoDB
 * vitest run; a pin or download failure does not take down memory or
 * Azure tests.
 */
export const DYNAMODB_PORT = 10103;

const TARBALL_NAME = "dynamodb_local_2025-04-14.tar.gz";
const TARBALL_URL = `https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/${TARBALL_NAME}`;
export const DYNAMODB_LOCAL_TARBALL_SHA256 =
  "9a8e6c1b1d4f5c1030c00a5a7eaee1a9ab2b8f1bbde7b700d5505898a3948fff";
const TARBALL_SHA256 = DYNAMODB_LOCAL_TARBALL_SHA256;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const TARBALL_PATH_ENV = "PEGMA_DYNAMODB_LOCAL_TARBALL_PATH";

let child: ChildProcess | undefined;
let childClosed: Promise<Error | undefined> | undefined;
let distribution: string | undefined;
let privateArchiveDirectory: string | undefined;
let verifiedTarball: string | undefined;

function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const settle = (accepting: boolean) => {
      socket.destroy();
      resolve(accepting);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1000, () => settle(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portAccepting(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `DynamoDB Local did not start listening on port ${port} within ${timeoutMs}ms.`,
  );
}

export function dynamoDbLocalTarballPath(): string {
  const tarball = process.env[TARBALL_PATH_ENV] ?? verifiedTarball;
  if (tarball === undefined) {
    throw new Error("DynamoDB Local archive has not been staged yet.");
  }
  return tarball;
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertRegularFile(path: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("DynamoDB Local archive must be a regular file.");
  }
}

async function assertTarballHash(path: string): Promise<void> {
  await assertRegularFile(path);
  const digest = await sha256File(path);
  if (digest !== TARBALL_SHA256) {
    throw new Error(
      `DynamoDB Local tarball hash mismatch: expected ${TARBALL_SHA256}, got ${digest}.`,
    );
  }
}

async function downloadTarball(dest: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(TARBALL_URL, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `Failed to download DynamoDB Local from ${TARBALL_URL}: ${String(response.status)} ${response.statusText}.`,
        );
      }
      await writeFile(dest, Buffer.from(await response.arrayBuffer()), {
        flag: "wx",
        mode: 0o600,
      });
      return;
    } catch (error) {
      lastError = error;
      await rm(dest, { force: true });
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Could not download DynamoDB Local from ${TARBALL_URL}: ${detail}`,
  );
}

async function ensureVerifiedTarball(): Promise<string> {
  if (verifiedTarball !== undefined) {
    await assertTarballHash(verifiedTarball);
    return verifiedTarball;
  }

  const archiveDirectory = await mkdtemp(
    join(tmpdir(), "pegma-dynamodb-local-archive-"),
  );
  await chmod(archiveDirectory, 0o700);
  privateArchiveDirectory = archiveDirectory;
  const tarball = join(archiveDirectory, TARBALL_NAME);

  const part = join(
    archiveDirectory,
    `${TARBALL_NAME}.${process.pid}.${randomBytes(8).toString("hex")}.part`,
  );
  try {
    await downloadTarball(part);
    await assertTarballHash(part);
    await rename(part, tarball);
  } finally {
    await rm(part, { force: true });
  }
  await assertTarballHash(tarball);
  verifiedTarball = tarball;
  process.env[TARBALL_PATH_ENV] = tarball;
  return tarball;
}

async function extractDistribution(tarball: string): Promise<string> {
  // Recheck the private staged file immediately before passing that same path
  // to tar.
  await assertTarballHash(tarball);
  const root = await mkdtemp(join(tmpdir(), "pegma-dynamodb-local-"));
  await execFileAsync("tar", ["-xzf", tarball, "-C", root]);
  const jar = join(root, "DynamoDBLocal.jar");
  const lib = join(root, "DynamoDBLocal_lib");
  if (!existsSync(jar) || !existsSync(lib)) {
    await rm(root, { recursive: true, force: true });
    throw new Error(
      `DynamoDB Local tarball extracted without DynamoDBLocal.jar under ${root}.`,
    );
  }
  return root;
}

async function assertJava(): Promise<void> {
  try {
    await execFileAsync("java", ["-version"]);
  } catch {
    throw new Error(
      "Could not find `java` on PATH. DynamoDB Local needs a JDK (CI uses Temurin 21).",
    );
  }
}

export async function setup(): Promise<void> {
  const tarball = await ensureVerifiedTarball();
  if (await portAccepting(DYNAMODB_PORT)) {
    return;
  }

  await assertJava();
  distribution = await extractDistribution(tarball);
  child = spawn(
    "java",
    [
      `-Djava.library.path=${join(distribution, "DynamoDBLocal_lib")}`,
      "-jar",
      join(distribution, "DynamoDBLocal.jar"),
      "-inMemory",
      "-sharedDb",
      "-port",
      String(DYNAMODB_PORT),
    ],
    {
      cwd: distribution,
      stdio: "ignore",
    },
  );

  const ownedChild = child;
  // Observe close now, including a child that exits before teardown starts.
  // Store errors as outcomes so they cannot reject before teardown awaits them.
  childClosed = new Promise((resolve) => {
    ownedChild.once("close", () => resolve(undefined));
    ownedChild.once("error", (error) => resolve(error));
  });

  await waitForPort(DYNAMODB_PORT, 30_000);
}

export async function teardown(): Promise<void> {
  if (child !== undefined) {
    const ownedChild = child;
    if (childClosed === undefined) {
      throw new Error("DynamoDB Local child close observation is missing.");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("DynamoDB Local did not close within 10000ms."));
        }, 10_000);
      });
      if (ownedChild.exitCode === null && ownedChild.signalCode === null) {
        ownedChild.kill();
      }
      const error = await Promise.race([childClosed, expired]);
      if (error !== undefined) throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    // Only a confirmed close releases ownership and permits directory removal.
    child = undefined;
    childClosed = undefined;
  }
  if (distribution !== undefined) {
    await rm(distribution, { recursive: true, force: true });
    distribution = undefined;
  }
  if (privateArchiveDirectory !== undefined) {
    await rm(privateArchiveDirectory, { recursive: true, force: true });
    privateArchiveDirectory = undefined;
    verifiedTarball = undefined;
    delete process.env[TARBALL_PATH_ENV];
  }
}
