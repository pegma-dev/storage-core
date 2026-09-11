import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
 * tarball is pinned by URL and SHA-256; the suite downloads it once into
 * the process temp directory.
 */
export const DYNAMODB_PORT = 10103;

const TARBALL_URL =
  "https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_2025-04-14.tar.gz";
const TARBALL_SHA256 =
  "9a8e6c1b1d4f5c1030c00a5a7eaee1a9ab2b8f1bbde7b700d5505898a3948fff";

let child: ChildProcess | undefined;

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

function cacheDirectory(): string {
  return join(tmpdir(), "pegma-dynamodb-local-2.6.1");
}

async function ensureLocalDistribution(): Promise<string> {
  const root = cacheDirectory();
  const jar = join(root, "DynamoDBLocal.jar");
  const lib = join(root, "DynamoDBLocal_lib");
  if (existsSync(jar) && existsSync(lib)) {
    return root;
  }

  await mkdir(root, { recursive: true });
  const tarball = join(root, "dynamodb_local_2025-04-14.tar.gz");
  if (!existsSync(tarball)) {
    const response = await fetch(TARBALL_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to download DynamoDB Local from ${TARBALL_URL}: ${String(response.status)} ${response.statusText}.`,
      );
    }
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  }

  const bytes = await readFile(tarball);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== TARBALL_SHA256) {
    await rm(tarball, { force: true });
    throw new Error(
      `DynamoDB Local tarball hash mismatch: expected ${TARBALL_SHA256}, got ${digest}.`,
    );
  }

  await execFileAsync("tar", ["-xzf", tarball, "-C", root]);
  if (!existsSync(jar) || !existsSync(lib)) {
    throw new Error(
      `DynamoDB Local tarball extracted without DynamoDBLocal.jar under ${root}.`,
    );
  }
  return root;
}

export async function setup(): Promise<void> {
  if (await portAccepting(DYNAMODB_PORT)) {
    return;
  }

  const distribution = await ensureLocalDistribution();
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

  child.once("error", (error) => {
    throw error;
  });

  await waitForPort(DYNAMODB_PORT, 30_000);
}

export async function teardown(): Promise<void> {
  child?.kill();
  child = undefined;
}
