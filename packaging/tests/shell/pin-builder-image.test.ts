// The builder-image pin updater: it rewrites exactly the two container refs in
// build-appimage.yml and fails closed on anything unexpected. Driven from the
// builder workflow's pin job; the real workflow file is the fixture, so a
// structural edit that breaks the anchors fails here, not in CI.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";

const SCRIPT = path.join(REPO_ROOT, "packaging", "scripts", "pin-builder-image.sh");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "build-appimage.yml");
const BASE = `ghcr.io/edgarcnp/fbr-builder-base:2026.10.01.7@sha256:${"a".repeat(64)}`;
const WEBKIT = `ghcr.io/edgarcnp/fbr-builder-webkit:2026.10.01.7@sha256:${"b".repeat(64)}`;

let dir: string;
let file: string;

function run(baseRef = BASE, webkitRef = WEBKIT): { status: number | null; stderr: string } {
  const result = spawnSync("bash", [SCRIPT, file, baseRef, webkitRef], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

function withoutRefs(text: string): string[] {
  return text.split("\n").filter((line) => !line.includes("fbr-builder-"));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-pin-"));
  file = path.join(dir, "build-appimage.yml");
  fs.copyFileSync(WORKFLOW, file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("pin-builder-image.sh", () => {
  it("rewrites both refs in the real workflow and nothing else", () => {
    const before = fs.readFileSync(file, "utf8");
    assert.equal(run().status, 0);
    const after = fs.readFileSync(file, "utf8");
    assert.equal((after.match(/fbr-builder-base:/g) ?? []).length, 1);
    assert.equal((after.match(/fbr-builder-webkit:/g) ?? []).length, 1);
    assert.ok(after.includes(BASE));
    assert.ok(after.includes(WEBKIT));
    assert.deepEqual(withoutRefs(after), withoutRefs(before));
  });

  it("is idempotent", () => {
    assert.equal(run().status, 0);
    const once = fs.readFileSync(file, "utf8");
    assert.equal(run().status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), once);
  });

  it("rejects a malformed ref before writing", () => {
    const before = fs.readFileSync(file, "utf8");
    const result = run("ghcr.io/edgarcnp/fbr-builder-base:latest", WEBKIT);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a pinned fbr-builder-base reference/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("fails closed without partial writes when a variant is missing", () => {
    fs.writeFileSync(file, `image: ghcr.io/edgarcnp/fbr-builder-base:2026.10.01.7@sha256:${"a".repeat(64)}\n`);
    const before = fs.readFileSync(file, "utf8");
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected exactly one webkit reference/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});
