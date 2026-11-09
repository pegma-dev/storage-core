import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const workflow = (
  await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  )
).replace(/\r\n/gu, "\n");

function workflowJob(name: string): string {
  const jobsMarker = "\njobs:\n";
  const jobsStart = workflow.indexOf(jobsMarker);
  if (jobsStart === -1) throw new Error("Workflow jobs were not found.");
  const jobsSection = workflow.slice(jobsStart + jobsMarker.length);
  const jobs = Array.from(jobsSection.matchAll(/^  ([a-z][\w-]*):$/gmu));
  const index = jobs.findIndex((match) => match[1] === name);
  if (index === -1) throw new Error(`Workflow job ${name} was not found.`);

  const start = jobs[index]!.index;
  const end = jobs[index + 1]?.index ?? jobsSection.length;
  return jobsSection.slice(start, end);
}

function workflowStep(job: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  if (start === -1) throw new Error(`Workflow step ${name} was not found.`);
  const end = job.indexOf("\n      - name:", start + marker.length);
  return job.slice(start, end === -1 ? undefined : end);
}

function inlinePublisher(): string {
  const step = workflowStep(
    workflowJob("publish"),
    "Verify and publish the prepared release",
  );
  const match = /<<'NODE'\n([^]*?)\n          NODE/u.exec(step);
  if (!match)
    throw new Error("Actual workflow publisher heredoc was not found.");
  return match[1]!
    .split("\n")
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
}

describe("publish workflow", () => {
  it("requires actual Node22 and Node24 full gates before preparation", () => {
    const validation = workflowJob("validate"),
      prepare = workflowJob("prepare");
    expect(validation).toContain("matrix.node-version");
    const matrix = /node-version:\s*\[([^\]]+)\]/u.exec(validation)?.[1];
    expect(matrix).toMatch(/\b22(?:\.|\b)/u);
    expect(matrix).toMatch(/\b24(?:\.|\b)/u);
    for (const command of [
      "pnpm run format:check",
      "pnpm run check",
      "pnpm test",
    ])
      expect(validation).toContain(command);
    expect(validation).toContain('java-version: "21"');
    expect(validation).not.toContain("id-token: write");
    expect(prepare).toMatch(/needs:.*validate/u);
    const jobHeader = prepare.slice(0, prepare.indexOf("\n    steps:"));
    expect(jobHeader).not.toContain("always()");
    // Failure-only proof retention may legitimately run after a failed step;
    // it cannot make the prepare job bypass the required validation dependency.
  });

  it("runs the actual YAML environment filter through a real child process", () => {
    const publisher = inlinePublisher();
    expect(publisher).toMatch(/env:\s*npmEnvironment\(\)/u);
    const filter = /function npmEnvironment\(\)\s*\{[^]*?\n\}/u.exec(
      publisher,
    )?.[0];
    if (!filter)
      throw new Error("Actual publisher npmEnvironment was not found.");
    const poisons = {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW_REF:
        "pegma-dev/storage-core/.github/workflows/publish.yml@refs/tags/v0.4.3",
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://fictional.actions.githubusercontent.com/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fictional-oidc-value",
      RUNNER_ENVIRONMENT: "github-hosted",
      NPM_TOKEN: "poison",
      NODE_AUTH_TOKEN: "poison",
      NODE_OPTIONS: "poison",
      NODE_EXTRA_CA_CERTS: "poison",
      HTTPS_PROXY: "poison",
      npm_config_registry: "https://evil.invalid",
    };
    const script = `import {spawnSync} from "node:child_process";
const userConfig="/fixture/empty-user",globalConfig="/fixture/empty-global",registry="https://registry.npmjs.org/";
${filter}
Object.assign(process.env,${JSON.stringify(poisons)});
const result=spawnSync(process.execPath,["--input-type=module","-e","process.stdout.write(JSON.stringify(process.env))"],{env:npmEnvironment(),encoding:"utf8"});
if(result.status!==0)throw new Error("Filtered child failed");
process.stdout.write(result.stdout);`;
    const result = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: tmpdir(),
          TMP: tmpdir(),
        },
      }),
    ) as Record<string, string>;
    expect(result.RUNNER_ENVIRONMENT).toBe("github-hosted");
    expect(result.GITHUB_SHA).toBe(poisons.GITHUB_SHA);
    expect(result.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
      poisons.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    );
    for (const key of [
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "HTTPS_PROXY",
      "npm_config_registry",
    ])
      expect(result).not.toHaveProperty(key);
    expect(result.NPM_CONFIG_USERCONFIG).toBe("/fixture/empty-user");
    expect(result.NPM_CONFIG_GLOBALCONFIG).toBe("/fixture/empty-global");
  });

  it("requires github-hosted authority before the actual version probe and physical publish", () => {
    const publisher = inlinePublisher();
    const guard = /RUNNER_ENVIRONMENT\s*!==\s*"github-hosted"/u.exec(
      publisher,
    )?.index;
    const version = /npm\(\s*\[\s*"--version"/u.exec(publisher)?.index;
    const upload = /npm\(\s*\[\s*"publish"/u.exec(publisher)?.index;
    expect(guard).toBeDefined();
    expect(version).toBeDefined();
    expect(upload).toBeDefined();
    expect(guard!).toBeLessThan(version!);
    expect(guard!).toBeLessThan(upload!);
  });

  it("pins real artifact actions to the original immutable preparation ID", () => {
    const prepare = workflowJob("prepare");
    const upload = workflowStep(prepare, "Upload the prepared release");
    expect(upload).toContain(
      "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4",
    );
    expect(upload).toContain("storage-prepared");
    expect(upload).toContain("include-hidden-files: false");
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).toContain("overwrite: false");
    expect(upload).toContain("github.run_attempt");
    expect(prepare).toContain("artifact-id:");
    for (const name of ["smoke", "preflight", "publish", "verify"]) {
      const job = workflowJob(name);
      expect(job).toContain(
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      );
      expect(job).toMatch(/artifact-ids:.*needs\.prepare\.outputs/u);
      expect(job).not.toMatch(/^\s+name: storage-release-/mu);
    }
    // Executing this pinned upload action and inspecting its exact ZIP is a
    // separate mandatory release acceptance gate, not a readdir/glob imitation.
  });
  it("verifies the tag before checkout and seals before smoke", () => {
    const prepare = workflowJob("prepare");
    const identity = workflowJob("identity");
    expect(identity).not.toContain("actions/checkout");
    expect(identity).toContain("git init --bare");
    expect(identity).toContain("fetch --no-tags origin");
    expect(prepare).toMatch(/needs:.*identity/u);
    expect(prepare).toContain("Configure checkout tag verification");
    expect(prepare).toContain("git config --local gpg.format ssh");
    expect(workflow).toContain('REVIEWED_NPM_VERSION: "11.18.0"');
    expect(prepare).toContain("--skip-smoke");
    expect(prepare).toContain("include-hidden-files: false");
    expect(prepare).toContain("manifest-digest:");
    expect(prepare).toContain("artifact-digest:");
    for (const job of [identity, workflowJob("publish")]) {
      const identity = workflowStep(job, "Verify the release tag");
      expect(identity).toContain("verify-tag");
      expect(identity).toContain("merge-base --is-ancestor");
      expect(identity).toContain("RELEASE_COMMIT");
    }
  });

  it("pins the embedded publisher invariants", () => {
    const publish = workflowJob("publish");
    expect(publish).toMatch(/manifest\.schemaVersion\s*!==\s*2/u);
    expect(publish).toContain("registryPolicySha256");
    expect(publish).toContain("registryReuse");
    expect(publish).toContain("originalRunId");
    expect(publish).toContain("sourceCommit");
    expect(publish).toContain("origin");
    expect(publish).toContain('"GITHUB_WORKFLOW_REF"');
    expect(publish).toContain('"ACTIONS_ID_TOKEN_REQUEST_TOKEN"');
    expect(publish).toMatch(/await chmod\(configDirectory,\s*0o700\)/u);
  });

  it("keeps smoke unprivileged and publish independent of a checkout", () => {
    const smoke = workflowJob("smoke");
    const publish = workflowJob("publish");

    expect(workflow.slice(0, workflow.indexOf("\njobs:\n"))).toContain(
      "permissions:\n  contents: read",
    );
    expect(smoke).not.toContain("id-token: write");
    expect(smoke).toContain("release-packages.mjs smoke");
    expect(smoke.indexOf("actions/checkout")).toBeLessThan(
      smoke.indexOf("actions/download-artifact"),
    );
    expect(publish).toMatch(/needs:.*preflight/u);
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("scripts/release-packages.mjs");
    expect(publish).toContain('"--ignore-scripts"');
    expect(publish).toContain('"--provenance"');
    const preflight = workflowJob("preflight"),
      verify = workflowJob("verify");
    expect(preflight).not.toContain("id-token: write");
    expect(preflight).toContain("release-registry-verify.mjs preflight");
    expect(preflight).toContain("--expected-manifest-sha256");
    expect(verify).not.toContain("id-token: write");
    expect(verify).toContain("release-registry-verify.mjs verify");
    expect(verify).toContain("--run-id");
  });

  it("passes release event values through job environments", () => {
    expect(
      workflow.match(
        /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/gu,
      ),
    ).not.toBeNull();
    expect(
      workflow.match(
        /RELEASE_PRERELEASE: \$\{\{ github\.event\.release\.prerelease \}\}/gu,
      ),
    ).not.toBeNull();

    const lines = workflow.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^(\s+)run:\s*(.*)$/u.exec(lines[index]!);
      if (match === null) continue;
      expect(match[2]).not.toContain("${{ github.event");
      expect(match[2]).not.toContain("${{ github.sha");
      if (match[2] !== "|" && match[2] !== ">-") continue;

      const indentation = match[1]!.length;
      const body: string[] = [];
      for (index += 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        const current = /^\s*/u.exec(line)![0].length;
        if (line.trim().length > 0 && current <= indentation) {
          index -= 1;
          break;
        }
        body.push(line);
      }
      expect(body.join("\n")).not.toContain("${{ github.event");
      expect(body.join("\n")).not.toContain("${{ github.sha");
    }
  });
});
