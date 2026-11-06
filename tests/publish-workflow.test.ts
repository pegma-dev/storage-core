import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);

describe("publish workflow", () => {
  it("verifies the tag before checkout and seals before smoke", () => {
    const prepare = workflow.split("\n  smoke:")[0]!;
    expect(prepare.indexOf("- name: Verify the release tag")).toBeLessThan(
      prepare.indexOf("- name: Check out the exact release commit"),
    );
    expect(prepare).toContain("git init --bare");
    expect(prepare).toContain("fetch --no-tags origin");
    expect(prepare).toContain("--skip-smoke");
    expect(prepare).toContain("include-hidden-files: false");
    expect(prepare).toContain("manifest-digest:");
    expect(prepare).toContain("artifact-digest:");
  });

  it("keeps smoke unprivileged and publish independent of a checkout", () => {
    const smoke = workflow.split("\n  smoke:")[1]!.split("\n  publish:")[0]!;
    const publish = workflow.split("\n  publish:")[1]!;

    expect(smoke).toContain("permissions:\n      contents: read");
    expect(smoke).not.toContain("id-token: write");
    expect(smoke).toContain("release-packages.mjs smoke");
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
      const match = /^(\s+)run: (?:\||>-)$/.exec(lines[index]!);
      if (match === null) continue;
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
