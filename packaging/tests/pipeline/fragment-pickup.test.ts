// The run record prefers the failure code a failing job wrote for itself over
// the report job's stage heuristic, so the fragment has to survive the trip:
// the failing job uploads report-code.json, the report job downloads it under
// report-codes/, and the record step reads whatever landed. The artifact action
// decides the extraction depth — one directory per artifact, or flat when the
// download merges them — so the pickup must not assume either. A fragment that
// lands one level too shallow turns a terminal BUILD_FAILED into a retryable
// UNCLASSIFIED, spends the retry budget, and hands a human a ticket that cannot
// say what broke.
//
// These tests drive the workflow step's own pickup line against both layouts,
// so the shape of the extraction is pinned by behaviour rather than by guess.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";

const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "build-appimage.yml");

// A workflow step's body: from `- name:` to the next less-indented line, the
// same extraction the record contract tests use.
function stepBody(name: string): string {
  const lines = fs.readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes(`- name: ${name}`));
  assert.ok(start >= 0, `build-appimage.yml has no "${name}" step`);
  const body: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index < start) continue;
    if (index > start && /^ {0,6}\S/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

// The one line of the record step that selects the downloaded fragments.
function pickupLine(): string {
  const body = stepBody("Write the run record");
  const line = body
    .split("\n")
    .find((entry) => entry.includes("report-code.json") && entry.includes("find"));
  assert.ok(
    line,
    "the record step has no find-based fragment pickup: a fixed-depth glob misses a fragment the artifact action extracts flat",
  );
  return line.trim();
}

// Where the artifact action can put a single report-code.json download.
const LAYOUTS = [
  ["per-artifact", path.join("report-codes", "report-code-opencode-desktop-build-amd64", "report-code.json")],
  ["flat", path.join("report-codes", "report-code.json")],
] as const;

describe("failure-fragment pickup", () => {
  for (const [layout, relative] of LAYOUTS) {
    it(`finds the fragment a ${layout} download leaves in report-codes/`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-fragments-"));
      try {
        const target = path.join(dir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '{"code":"BUILD_FAILED","message":"boom","stage":"build"}\n');
        const script = [
          "set -eo pipefail",
          "fragments=()",
          pickupLine(),
          'printf "%s\\n" ${fragments[@]+"${fragments[@]}"}',
        ].join("\n");
        const result = spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          result.stdout.split("\n").filter((entry) => entry.length > 0),
          [relative],
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("flags a build failure whose fragment never arrived", () => {
    // The build step writes its own BUILD_FAILED fragment, so a build job that
    // failed and left nothing behind lost it in transit: say so in the log
    // instead of passing in silence and letting the record claim the stage
    // heuristic is all there was.
    const inspect = stepBody("Inspect the failure codes");
    assert.match(inspect, /BUILD_RESULT: \$\{\{ needs\.build\.result \}\}/);
    assert.match(inspect, /::error::.*no failure code arrived/);
  });
});
