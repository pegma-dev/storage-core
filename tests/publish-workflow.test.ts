import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);

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

describe("publish workflow", () => {
  it("verifies the tag before checkout and seals before smoke", () => {
    const prepare = workflowJob("prepare");
    expect(prepare.indexOf("- name: Verify the release tag")).toBeLessThan(
      prepare.indexOf("- name: Check out the exact release commit"),
    );
    expect(prepare).toContain("git init --bare");
    expect(prepare).toContain("fetch --no-tags origin");
    expect(prepare).toContain("Configure checkout tag verification");
    expect(prepare).toContain("git config --local gpg.format ssh");
    expect(prepare).toContain('REVIEWED_NPM_VERSION: "11.18.0"');
    expect(prepare).toContain("--skip-smoke");
    expect(prepare).toContain("include-hidden-files: false");
    expect(prepare).toContain("manifest-digest:");
    expect(prepare).toContain("artifact-digest:");
  });

  it("pins the embedded publisher invariants", () => {
    const publish = workflowJob("publish");
    const environment = /const exact = new Set\(\[(.*?)\]\);/su.exec(publish);
    expect(environment).not.toBeNull();
    expect(
      Array.from(
        environment![1]!.matchAll(/"([A-Z_]+)"/gu),
        (match) => match[1],
      ),
    ).toEqual([
      "PATH",
      "HOME",
      "CI",
      "SYSTEMROOT",
      "RUNNER_TEMP",
      "RUNNER_TOOL_CACHE",
      "TEMP",
      "TMP",
      "TMPDIR",
    ]);
    expect(publish).toContain(
      'JSON.stringify(["gitCommit", "packages", "releaseTag", "schemaVersion"])',
    );
    expect(publish).toContain(
      'JSON.stringify(["directory", "files", "integrity", "name", "package", "publish", "sha256", "shasum", "tarball", "version"])',
    );
    expect(publish).toContain('upper.startsWith("GITHUB_")');
    expect(publish).toContain('upper.startsWith("ACTIONS_ID_TOKEN_")');
  });

  it("keeps smoke unprivileged and publish independent of a checkout", () => {
    const smoke = workflowJob("smoke");
    const publish = workflowJob("publish");

    expect(smoke).toContain("permissions:\n      contents: read");
    expect(smoke).not.toContain("id-token: write");
    expect(smoke).toContain("release-packages.mjs smoke");
    expect(smoke.indexOf("actions/checkout")).toBeLessThan(
      smoke.indexOf("actions/download-artifact"),
    );
    expect(publish).toContain("needs: [prepare, smoke]");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("scripts/release-packages.mjs");
    expect(publish).toContain('"--ignore-scripts"');
    expect(publish).toContain('"--provenance"');
  });

  it("passes release event values through job environments", () => {
    expect(
      workflow.match(
        /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/gu,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /RELEASE_PRERELEASE: \$\{\{ github\.event\.release\.prerelease \}\}/gu,
      ),
    ).toHaveLength(2);

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
