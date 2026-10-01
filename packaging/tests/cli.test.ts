import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { listApps } from "../lib/pipeline/descriptor.ts";
import { REPO_ROOT } from "../lib/core/paths.ts";

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

function vscodeCaskVersion(): string {
  const result = fbr(["cask", "--action", "read", "--app", "vscode"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { version?: unknown };
  assert.equal(typeof parsed.version, "string");
  return parsed.version as string;
}

describe("fbr CLI contract", () => {
  it("lists apps as newline-separated ids and as a JSON array", () => {
    const expected = listApps();

    const plain = fbr(["list-apps"]);
    assert.equal(plain.status, 0);
    assert.deepEqual(plain.stdout.trim().split("\n"), expected);

    const json = fbr(["list-apps", "--json"]);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), expected);
  });

  it("resolves an app name the way the build plan calls it", () => {
    const hyphenated = fbr(["resolve-app", "--name", "opencode-desktop"]);
    assert.equal(hyphenated.status, 0, hyphenated.stderr);
    assert.equal(hyphenated.stdout.trim(), "opencode-desktop");

    const plain = fbr(["resolve-app", "--name", "vscode"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout.trim(), "vscode");

    const unknown = fbr(["resolve-app", "--name", "nope"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown app 'nope'/);

    const missingFlag = fbr(["resolve-app"]);
    assert.equal(missingFlag.status, 2);
    assert.match(missingFlag.stderr, /--name/);
  });

  it("accepts the gate flags exactly as the workflow passes them", () => {
    const base = ["gate", "--app", "vscode", "--upstream-version", vscodeCaskVersion(), "--release-exists"];

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
      vscodeCaskVersion(),
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

  it("rejects a duplicated flag instead of letting the last value win", () => {
    const duplicated = fbr(["descriptor", "--app", "vscode", "--app", "opencode-desktop"]);
    assert.equal(duplicated.status, 2);
    assert.match(duplicated.stderr, /--app was given more than once/);
  });

  it("rejects malformed or duplicate --upstream specs", () => {
    const base = ["release-notes", "--app", "vscode", "--asset-dir", "unused"];

    const badSha = fbr([...base, "--upstream", "amd64=zzz=https://example.com/a.deb"]);
    assert.equal(badSha.status, 2);
    assert.match(badSha.stderr, /64 hex/);

    const insecure = fbr([
      ...base,
      "--upstream",
      `amd64=${"a".repeat(64)}=http://example.com/a.deb`,
    ]);
    assert.equal(insecure.status, 2);
    assert.match(insecure.stderr, /must be https/);

    const duplicate = fbr([
      ...base,
      "--upstream",
      `amd64=${"a".repeat(64)}=https://example.com/a.deb`,
      "--upstream",
      `amd64=${"b".repeat(64)}=https://example.com/b.deb`,
    ]);
    assert.equal(duplicate.status, 2);
    assert.match(duplicate.stderr, /more than once/);
  });

  it("sorts a release-tag version list the way the retention step calls it", () => {
    // The workflow runs exactly this shape: --sort then the stripped versions.
    const sorted = fbr([
      "version-compare",
      "--sort",
      "1.137.0",
      "1.0.109a",
      "1.0.109-1",
      "1.9.0",
    ]);
    assert.equal(sorted.status, 0, sorted.stderr);
    assert.deepEqual(sorted.stdout.trim().split("\n"), [
      "1.0.109-1",
      "1.0.109a",
      "1.9.0",
      "1.137.0",
    ]);

    const empty = fbr(["version-compare", "--sort"]);
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /needs at least one version/);
  });

  it("compares versions and validates app names", () => {
    const older = fbr(["version-compare", "1.0+", "1.0a"]);
    assert.equal(older.status, 0);
    assert.equal(older.stdout.trim(), "1");

    const unknownApp = fbr(["descriptor", "--app", "nope"]);
    assert.equal(unknownApp.status, 1);
    assert.match(unknownApp.stderr, /Unknown app/);
  });

  it("exposes the feed cross-check only as an advisory feed-version read", () => {
    // The run no longer waits on the feed, so the hold flag and the command
    // that printed it are gone: the workflow calls this exact shape.
    const removed = fbr(["feed-hold", "--app", "vscode"]);
    assert.equal(removed.status, 2);
    assert.match(removed.stderr, /Unknown command: feed-hold/);

    const staleFlag = fbr(["feed-version", "--app", "vscode", "--upstream-version", "1.0.0"]);
    assert.equal(staleFlag.status, 2);
    assert.match(staleFlag.stderr, /Unknown option '--upstream-version'/);

    const missingApp = fbr(["feed-version"]);
    assert.equal(missingApp.status, 2);
    assert.match(missingApp.stderr, /--app/);
  });

  it("classifies a permanent failure and writes the fragment the workflow uploads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-cli-"));
    try {
      // vscode's descriptor scans for its patched endpoint and fails when one
      // survives; node_modules is never patched, so a copy there survives.
      fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "node_modules", "pkg", "index.js"),
        'const url = "update.code.visualstudio.com";\n',
      );
      const fragment = path.join(dir, "report-code.json");

      const classified = fbr([
        "neutralize",
        "--app",
        "vscode",
        "--appdir",
        dir,
        "--failure-out",
        fragment,
      ]);
      assert.equal(classified.status, 6, classified.stderr);
      const parsed = JSON.parse(fs.readFileSync(fragment, "utf8")) as Record<string, unknown>;
      assert.equal(parsed["code"], "UPDATER_RESIDUAL");
      assert.match(String(parsed["message"]), /neutralization incomplete/);
      assert.equal(String(parsed["message"]).includes("\n"), false);

      // An unclassified failure keeps exit 1 and writes nothing: UNCLASSIFIED
      // is the record job's verdict, not something a failure site may invent.
      const unclassified = fbr([
        "neutralize",
        "--app",
        "vscode",
        "--appdir",
        path.join(dir, "absent"),
        "--failure-out",
        path.join(dir, "never.json"),
      ]);
      assert.equal(unclassified.status, 1, unclassified.stderr);
      assert.equal(fs.existsSync(path.join(dir, "never.json")), false);

      // Nor may a usage error write one.
      const usage = fbr(["neutralize", "--app", "vscode"]);
      assert.equal(usage.status, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
