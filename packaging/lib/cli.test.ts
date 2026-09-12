import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "./paths.ts";

// The workflows call fbr with exact flag shapes; these tests run the real
// entry point so a flag contract change cannot ship without CI noticing.
const FBR = path.join(REPO_ROOT, "packaging", "bin", "fbr.ts");

function fbr(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [FBR, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("fbr CLI contract", () => {
  it("lists apps as newline-separated ids and as a JSON array", () => {
    const plain = fbr(["list-apps"]);
    assert.equal(plain.status, 0);
    assert.deepEqual(plain.stdout.trim().split("\n"), ["freebuff", "gitbutler", "opencode", "vscode"]);

    const json = fbr(["list-apps", "--json"]);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), ["freebuff", "gitbutler", "opencode", "vscode"]);
  });

  it("accepts the gate flags exactly as the workflow passes them", () => {
    const base = ["gate", "--app", "vscode", "--upstream-version", "1.137.0", "--release-exists"];

    const matching = fbr([...base, "--release-matches-cask", "true"]);
    assert.equal(matching.status, 0, matching.stderr);
    assert.match(matching.stdout, /^skipped=true$/m);

    const differing = fbr([...base, "--release-matches-cask", "false"]);
    assert.equal(differing.status, 0, differing.stderr);
    assert.match(differing.stdout, /^repair_cask=true$/m);
    assert.match(differing.stdout, /assets differ/);

    // Omitted flag: the comparison could not run.
    const unknown = fbr(base);
    assert.equal(unknown.status, 0, unknown.stderr);
    assert.match(unknown.stdout, /^repair_cask=true$/m);
    assert.match(unknown.stdout, /could not be compared/);
  });

  it("rejects an unparseable release match instead of guessing", () => {
    const result = fbr([
      "gate",
      "--app",
      "vscode",
      "--upstream-version",
      "1.137.0",
      "--release-matches-cask",
      "maybe",
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must be "true" or "false"/);
  });

  it("rejects unknown flags and stray positionals", () => {
    const unknownFlag = fbr(["gate", "--app", "vscode", "--nope", "1"]);
    assert.equal(unknownFlag.status, 2);
    assert.match(unknownFlag.stderr, /Unknown option '--nope'/);

    const positional = fbr(["descriptor", "--app", "vscode", "extra"]);
    assert.equal(positional.status, 2);
    assert.match(positional.stderr, /positional/);
  });

  it("compares versions and validates app names", () => {
    const older = fbr(["version-compare", "1.0+", "1.0a"]);
    assert.equal(older.status, 0);
    assert.equal(older.stdout.trim(), "1");

    const unknownApp = fbr(["descriptor", "--app", "nope"]);
    assert.equal(unknownApp.status, 1);
    assert.match(unknownApp.stderr, /Unknown app/);
  });
});
