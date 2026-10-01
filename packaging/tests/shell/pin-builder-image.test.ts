// The builder-image pin updater: it rewrites the single image ref in
// packaging/builder/pins.json (the file build-appimage.yml reads for its build
// container) and fails closed on anything unexpected. The real pins file is the
// fixture, so a structural edit that breaks the anchor fails here, not in CI.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";

const SCRIPT = path.join(REPO_ROOT, "packaging", "scripts", "pin-builder-image.sh");
const PINS = path.join(REPO_ROOT, "packaging", "builder", "pins.json");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "build-appimage.yml");
const IMAGE = `ghcr.io/edgarcnp/fbr-builder-base:2026.10.01.7@sha256:${"a".repeat(64)}`;

let dir: string;
let file: string;

function run(imageRef = IMAGE): { status: number | null; stderr: string } {
  const result = spawnSync("bash", [SCRIPT, file, imageRef], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

function withoutRefs(text: string): string[] {
  return text.split("\n").filter((line) => !line.includes("ghcr.io/edgarcnp/fbr-builder-base:"));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-pin-"));
  file = path.join(dir, "pins.json");
  fs.copyFileSync(PINS, file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("pin-builder-image.sh", () => {
  it("rewrites the ref in the real pins file and nothing else", () => {
    const before = fs.readFileSync(file, "utf8");
    assert.equal(run().status, 0);
    const after = fs.readFileSync(file, "utf8");
    assert.deepEqual(JSON.parse(after), { image: IMAGE });
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
    const result = run("ghcr.io/edgarcnp/fbr-builder-base:latest");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a pinned fbr-builder-base reference/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("fails closed without partial writes when the ref is missing", () => {
    fs.writeFileSync(file, "{}\n");
    const before = fs.readFileSync(file, "utf8");
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected exactly one image reference/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("keeps the image ref out of the workflow file", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    assert.ok(
      workflow.includes("needs.detect.outputs.builder_image"),
      "the build job should read its container image from the detect output",
    );
    assert.ok(
      !workflow.includes("ghcr.io/edgarcnp/fbr-builder-base"),
      "image refs belong in packaging/builder/pins.json, not the workflow",
    );
  });
});
