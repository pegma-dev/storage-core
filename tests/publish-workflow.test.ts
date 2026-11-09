import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
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

function shellStep(job: string, name: string): string {
  const step = workflowStep(workflowJob(job), name);
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  if (start === -1) throw new Error(`Shell body for ${name} was not found.`);
  const lines = step
    .slice(start + marker.length)
    .trimEnd()
    .split("\n");
  if (lines.some((line) => line.length > 0 && !line.startsWith("          ")))
    throw new Error(`Unexpected shell indentation in ${name}.`);
  return lines.map((line) => line.replace(/^ {10}/u, "")).join("\n");
}

function gitBashFromExecPath(output: string): string {
  const execPath = output.trim();
  if (!win32.isAbsolute(execPath) || /[\r\n]/u.test(execPath))
    throw new Error(
      "Git for Windows returned an invalid executable directory.",
    );
  return win32.resolve(execPath, "..", "..", "..", "bin", "bash.exe");
}

async function bootstrapBash(): Promise<string> {
  if (process.platform !== "win32") return "/bin/bash";
  let output: string;
  try {
    output = execFileSync("git.exe", ["--exec-path"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
  } catch {
    throw new Error(
      "Git for Windows is required to run the workflow shell tests.",
    );
  }
  const path = gitBashFromExecPath(output);
  if (!(await stat(path).catch(() => undefined))?.isFile())
    throw new Error(`Git Bash was not found beside Git for Windows: ${path}`);
  return path;
}

function bashPath(path: string): string {
  if (process.platform !== "win32") return path;
  return path
    .replace(/\\/gu, "/")
    .replace(
      /^([a-z]):\//iu,
      (_match, drive: string) => `/${drive.toLowerCase()}/`,
    );
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

const bootstrapJobs = ["prepare", "publish"] as const;
const probeArguments = [
  "--fixture-probe",
  "argument with spaces",
  "single'and\"double",
  "$(must-not-execute)",
  "semicolon;literal",
];
type BootstrapMode =
  | "success"
  | "download"
  | "digest"
  | "extract"
  | "missing-cli"
  | "relative-node";
interface BootstrapTrace {
  readonly kind: string;
  readonly args?: readonly string[];
}

async function runReviewedNpmBootstrap(job: string, mode: BootstrapMode) {
  const root = await mkdtemp(join(tmpdir(), "storage-reviewed-npm-"));
  const runner = join(root, "runner with spaces");
  const fixture = join(root, "synthetic archive with spaces");
  const hostBin = join(root, "host bin");
  const githubPath = join(root, "github-path");
  const tracePath = join(root, "trace.jsonl");
  const digestInput = join(root, "digest-input");
  try {
    await Promise.all([
      mkdir(runner),
      mkdir(join(fixture, "package", "bin"), { recursive: true }),
      mkdir(hostBin),
      mkdir(join(root, "relative")),
    ]);
    const hostNpm = `#!/bin/bash
printf '%s\\n' '{"kind":"host"}' >> "$TEST_TRACE"
printf '%s\\n' '11.16.0'
`;
    const stockNpm = hostNpm.replace('"host"', '"stock-wrapper"');
    await Promise.all([
      writeFile(join(hostBin, "npm"), hostNpm),
      writeFile(join(root, "relative", "node"), "#!/bin/bash\nexit 0\n"),
      writeFile(join(fixture, "package", "bin", "npm"), stockNpm),
      writeFile(join(fixture, "package", "package.json"), '{"type":"module"}'),
      writeFile(githubPath, ""),
      writeFile(tracePath, ""),
      writeFile(digestInput, ""),
    ]);
    await Promise.all([
      chmod(join(hostBin, "npm"), 0o700),
      chmod(join(root, "relative", "node"), 0o700),
      chmod(join(fixture, "package", "bin", "npm"), 0o700),
    ]);
    if (mode !== "missing-cli")
      await writeFile(
        join(fixture, "package", "bin", "npm-cli.js"),
        `import {appendFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(process.env.TEST_TRACE_NATIVE,JSON.stringify({kind:"owned",args})+"\\n");
process.stdout.write(args.length===1&&args[0]==="--version"?"11.18.0\\n":JSON.stringify(args)+"\\n");
`,
      );

    // Only shell control flow and actual launcher selection are under test.
    // Download, digest verification and extraction are explicitly controlled
    // external ports; these synthetic bytes are NOT a real npm/crypto proof.
    const controlledTools = `
command() {
  if [[ "$TEST_MODE" == 'relative-node' && "$#" == 2 && "$1" == '-v' && "$2" == 'node' ]]; then
    printf '%s\\n' 'relative/node'
    return 0
  fi
  builtin command "$@"
}
curl() {
  printf '%s\\n' '{"kind":"download"}' >> "$TEST_TRACE"
  local output='' url='' proto='' proxy='unset' max_time='' max_size=''
  local disabled=false fail=false silent=false show_error=false
  [[ "$1" == '--disable' ]] || return 91
  while (( $# )); do
    case "$1" in
      --disable) disabled=true; shift ;;
      --fail) fail=true; shift ;;
      --silent) silent=true; shift ;;
      --show-error) show_error=true; shift ;;
      --proto) proto="$2"; shift 2 ;;
      --proxy) proxy="$2"; shift 2 ;;
      --max-time) max_time="$2"; shift 2 ;;
      --max-filesize) max_size="$2"; shift 2 ;;
      --output) output="$2"; shift 2 ;;
      https://*) url="$1"; shift ;;
      *) return 91 ;;
    esac
  done
  [[ "$disabled" == true && "$fail" == true && "$silent" == true && "$show_error" == true ]] || return 91
  [[ "$proto" == '=https' && "$proxy" == '' && "$max_time" == 60 && "$max_size" == 16777216 ]] || return 91
  [[ "$url" == 'https://registry.npmjs.org/npm/-/npm-11.18.0.tgz' && -n "$output" ]] || return 91
  if [[ "$TEST_MODE" == 'download' ]]; then return 31; fi
  printf '%s' 'synthetic archive bytes, not real npm' > "$output"
}
sha256sum() {
  printf '%s\\n' '{"kind":"digest"}' >> "$TEST_TRACE"
  local checksum
  IFS= read -r checksum
  printf '%s\\n' "$checksum" > "$TEST_DIGEST_INPUT"
  [[ "$#" == 2 && "$1" == '--check' && "$2" == '--status' ]] || return 92
  [[ "$checksum" == '73f6155215ebabf4ed96dca1f567c2372cc713c33af2e5b9b62fde4e92373e2e  '* ]] || return 93
  if [[ "$TEST_MODE" == 'digest' ]]; then return 32; fi
}
tar() {
  printf '%s\\n' '{"kind":"extract"}' >> "$TEST_TRACE"
  local archive='' destination=''
  local extract=false gzip=false no_owner=false no_permissions=false
  while (( $# )); do
    case "$1" in
      --extract) extract=true; shift ;;
      --gzip) gzip=true; shift ;;
      --file) archive="$2"; shift 2 ;;
      --directory) destination="$2"; shift 2 ;;
      --no-same-owner) no_owner=true; shift ;;
      --no-same-permissions) no_permissions=true; shift ;;
      *) return 94 ;;
    esac
  done
  [[ "$extract" == true && "$gzip" == true && "$no_owner" == true && "$no_permissions" == true ]] || return 94
  [[ -s "$archive" && -n "$destination" ]] || return 94
  if [[ "$TEST_MODE" == 'extract' ]]; then return 33; fi
  cp -R -- "$TEST_ARCHIVE_FIXTURE/package" "$destination/package"
}
`;
    const version = /^  REVIEWED_NPM_VERSION: "([^"]+)"$/mu.exec(workflow)?.[1];
    if (version === undefined)
      throw new Error("Reviewed npm version was not found.");
    const script = `set -euo pipefail
${controlledTools}
printf 'HOST_VERSION='
npm --version
if [[ "$TEST_MODE" == 'relative-node' ]]; then
  [[ -f relative/node && -x relative/node ]] || exit 95
fi
${shellStep(job, "Bootstrap the reviewed npm CLI")}
IFS= read -r reviewed_bin < "$GITHUB_PATH"
export PATH="$reviewed_bin:$PATH"
hash -r
${shellStep(job, "Check the npm version")}
printf 'OWNED_ARGUMENTS='
npm ${probeArguments.map(shellQuote).join(" ")}
`;
    const result = spawnSync(
      await bootstrapBash(),
      ["--noprofile", "--norc", "-c", script],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        env: {
          PATH: `${bashPath(hostBin)}:${bashPath(dirname(process.execPath))}:/usr/bin:/bin`,
          HOME: bashPath(root),
          RUNNER_TEMP: bashPath(runner),
          GITHUB_PATH: bashPath(githubPath),
          REVIEWED_NPM_VERSION: version,
          TEST_MODE: mode,
          TEST_TRACE: bashPath(tracePath),
          TEST_TRACE_NATIVE: tracePath,
          TEST_DIGEST_INPUT: bashPath(digestInput),
          TEST_ARCHIVE_FIXTURE: bashPath(fixture),
          SystemRoot: process.env.SystemRoot,
          TEMP: root,
          TMP: root,
        },
      },
    );
    const trace = (await readFile(tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BootstrapTrace);
    return {
      result,
      trace,
      path: await readFile(githubPath, "utf8"),
      digestInput: await readFile(digestInput, "utf8"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("publish workflow", () => {
  it.each([
    {
      execPath: String.raw`C:\Program Files\Git\mingw64\libexec\git-core`,
      bash: String.raw`C:\Program Files\Git\bin\bash.exe`,
    },
    {
      execPath: String.raw`D:\developer tools\Git\mingw64\libexec\git-core`,
      bash: String.raw`D:\developer tools\Git\bin\bash.exe`,
    },
    {
      execPath: "E:/scoop/apps/git/current/mingw64/libexec/git-core\n",
      bash: String.raw`E:\scoop\apps\git\current\bin\bash.exe`,
    },
  ])(
    "resolves Git Bash beside the actual Git installation: $execPath",
    ({ execPath, bash }) => {
      expect(gitBashFromExecPath(execPath)).toBe(bash);
    },
  );

  it("keeps the actual preparation and publishing bootstrap shell bodies identical", () => {
    expect(shellStep("prepare", "Bootstrap the reviewed npm CLI")).toBe(
      shellStep("publish", "Bootstrap the reviewed npm CLI"),
    );
  });

  it.each(bootstrapJobs)(
    "%s bootstraps reviewed npm after Node setup and before version checks or consumers",
    (name) => {
      const job = workflowJob(name);
      const setup = job.indexOf("      - name: Set up Node.js\n");
      const bootstrap = job.indexOf(
        "      - name: Bootstrap the reviewed npm CLI\n",
      );
      const check = job.indexOf("      - name: Check the npm version\n");
      const consumer = job.indexOf(
        name === "prepare"
          ? "      - name: Pack the release files\n"
          : "      - name: Verify and publish the prepared release\n",
      );
      expect(setup).toBeGreaterThanOrEqual(0);
      expect(bootstrap).toBeGreaterThan(setup);
      expect(check).toBeGreaterThan(bootstrap);
      expect(consumer).toBeGreaterThan(check);
    },
  );

  it.each(bootstrapJobs)(
    "%s actual shell selects the owned reviewed CLI over host npm 11.16 and preserves literal arguments",
    async (job) => {
      const f = await runReviewedNpmBootstrap(job, "success");
      expect(f.result.error).toBeUndefined();
      expect(f.result.signal).toBeNull();
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(f.result.stdout).toContain("HOST_VERSION=11.16.0\n");
      expect(f.result.stdout).toContain(
        "OWNED_ARGUMENTS=" + JSON.stringify(probeArguments) + "\n",
      );
      expect(f.trace.map((entry) => entry.kind)).toEqual([
        "host",
        "download",
        "digest",
        "extract",
        "owned",
        "owned",
      ]);
      expect(
        f.trace
          .filter((entry) => entry.kind === "owned")
          .map((entry) => entry.args),
      ).toEqual([["--version"], probeArguments]);
      expect(f.path.trim().split("\n")).toHaveLength(1);
      expect(f.path.trim()).toMatch(/\/reviewed-npm\.[^/]+\/bin$/u);
      expect(f.path).not.toContain("/package/bin");
      expect(f.digestInput).toMatch(
        /^73f6155215ebabf4ed96dca1f567c2372cc713c33af2e5b9b62fde4e92373e2e  .+\/npm-11\.18\.0\.tgz\n$/u,
      );
    },
  );

  it.each(
    bootstrapJobs.flatMap((job) => [
      {
        job,
        mode: "download" as const,
        status: 31,
        calls: ["host", "download"],
      },
      {
        job,
        mode: "digest" as const,
        status: 32,
        calls: ["host", "download", "digest"],
      },
      {
        job,
        mode: "extract" as const,
        status: 33,
        calls: ["host", "download", "digest", "extract"],
      },
      {
        job,
        mode: "missing-cli" as const,
        status: 1,
        calls: ["host", "download", "digest", "extract"],
      },
      {
        job,
        mode: "relative-node" as const,
        status: 1,
        calls: ["host"],
      },
    ]),
  )(
    "$job actual bootstrap stops on $mode failure without publishing PATH or falling back to host npm",
    async ({ job, mode, status, calls }) => {
      const f = await runReviewedNpmBootstrap(job, mode);
      expect(f.result.error).toBeUndefined();
      expect(f.result.signal).toBeNull();
      expect(f.result.status, f.result.stderr).toBe(status);
      expect(f.result.stdout).toContain("HOST_VERSION=11.16.0\n");
      expect(f.result.stdout).not.toContain("OWNED_ARGUMENTS=");
      expect(f.trace.map((entry) => entry.kind)).toEqual(calls);
      expect(f.path).toBe("");
    },
  );

  it.each([
    { outcome: "success", reuseRequired: "false", upload: false },
    { outcome: "success", reuseRequired: "true", upload: true },
    { outcome: "success", reuseRequired: undefined, upload: true },
    { outcome: "success", reuseRequired: "unknown", upload: true },
    { outcome: "failure", reuseRequired: "false", upload: true },
    { outcome: "skipped", reuseRequired: undefined, upload: true },
  ])(
    "retains reuse proof for seal=$outcome, reuse_required=$reuseRequired: $upload",
    ({ outcome, reuseRequired, upload }) => {
      const step = workflowStep(
        workflowJob("prepare"),
        "Retain genuine registry reuse proof",
      );
      const condition = /^\s+if: \$\{\{ (.+) \}\}$/mu.exec(step)?.[1];
      if (condition === undefined)
        throw new Error("Actual reuse-proof upload condition was not found.");
      // The actual seal emits canonical boolean strings; do not use this JS
      // evaluator to claim GitHub's string case-comparison semantics.
      // Evaluate the actual condition with its two GitHub contexts supplied.
      // This does not pretend to execute upload-artifact or its file globbing.
      const evaluate = new Function(
        "always",
        "steps",
        `return (${condition});`,
      ) as (
        always: () => boolean,
        steps: {
          seal: { outcome: string; outputs: { reuse_required?: string } };
        },
      ) => boolean;
      expect(
        evaluate(() => true, {
          seal: {
            outcome,
            outputs:
              reuseRequired === undefined
                ? {}
                : { reuse_required: reuseRequired },
          },
        }),
      ).toBe(upload);
      expect(step).toContain("if-no-files-found: error");
      expect(step).toContain("overwrite: false");
      expect(step).toContain(
        "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4",
      );
    },
  );

  it("resolves runner paths only in the consuming step context", () => {
    for (const name of [
      "identity",
      "validate",
      "prepare",
      "smoke",
      "preflight",
      "publish",
      "verify",
    ]) {
      const job = workflowJob(name);
      expect(job.slice(0, job.indexOf("\n    steps:"))).not.toMatch(
        /\$\{\{\s*runner\./u,
      );
    }
    for (const [job, step, directory] of [
      ["smoke", "Smoke-test the prepared release copy", "storage-smoke"],
      ["preflight", "Verify registry preflight", "storage-preflight-input"],
      ["publish", "Verify and publish the prepared release", "storage-publish"],
      [
        "verify",
        "Verify registry bytes provenance and consumer",
        "storage-final-input",
      ],
    ]) {
      expect(workflowStep(workflowJob(job!), step!)).toContain(
        "RELEASE_DIRECTORY: ${{ runner.temp }}/" + directory,
      );
    }
    expect(
      workflowStep(
        workflowJob("publish"),
        "Verify and publish the prepared release",
      ),
    ).toContain(
      "PREFLIGHT_DIRECTORY: ${{ runner.temp }}/storage-publish-preflight",
    );
  });

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
