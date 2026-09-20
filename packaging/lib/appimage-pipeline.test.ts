// The sharun sidecar reconciliation stage. quick-sharun hardlinks sharun over
// every nested executable under bin/ whose basename also lands in shared/bin,
// and sharun cannot map such a nested wrapper back to shared/bin at runtime.
// These tests drive the real shell stage against a synthetic AppDir: `-ef`
// only looks at the inode, so hardlinks are enough and no ELF is needed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { REPO_ROOT } from "./paths.ts";

const PIPELINE_LIB = path.join(REPO_ROOT, "packaging", "lib", "appimage-pipeline.sh");
const STAGE = "pipeline_reconcile_sharun_sidecars";

let appDir: string;

function pathIn(relative: string): string {
  return path.join(appDir, relative);
}

function makeSharun(): void {
  fs.writeFileSync(pathIn("sharun"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(pathIn("sharun"), 0o755);
}

// What quick-sharun does to a wrapped binary: replace it with a sharun hardlink.
function wrap(relative: string): void {
  fs.mkdirSync(path.dirname(pathIn(relative)), { recursive: true });
  fs.linkSync(pathIn("sharun"), pathIn(relative));
}

function writeExecutable(relative: string): void {
  fs.mkdirSync(path.dirname(pathIn(relative)), { recursive: true });
  fs.writeFileSync(pathIn(relative), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(pathIn(relative), 0o755);
}

function reconcile(): { status: number | null; stderr: string } {
  const result = spawnSync(
    "bash",
    ["-c", `set -Eeuo pipefail; . "$PIPELINE_LIB"; APPDIR="$APP_DIR"; ${STAGE}`],
    { encoding: "utf8", env: { ...process.env, PIPELINE_LIB, APP_DIR: appDir } },
  );
  return { status: result.status, stderr: result.stderr };
}

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-sharun-"));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe(STAGE, () => {
  it("re-points an Electron sidecar at the sibling bin/ wrapper", () => {
    makeSharun();
    wrap("bin/opencode-cli");
    wrap("bin/resources/opencode-cli");
    writeExecutable("shared/bin/opencode-cli");

    assert.equal(reconcile().status, 0);

    const sidecar = pathIn("bin/resources/opencode-cli");
    assert.equal(fs.lstatSync(sidecar).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(sidecar), "../opencode-cli");
    assert.equal(fs.realpathSync(sidecar), fs.realpathSync(pathIn("bin/opencode-cli")));

    // a resumed or re-run stage must stay clean
    assert.equal(reconcile().status, 0);
    assert.equal(fs.readlinkSync(sidecar), "../opencode-cli");
  });

  it("scales the relative target with the nesting depth", () => {
    makeSharun();
    wrap("bin/nested");
    wrap("bin/resources/app/nested");
    writeExecutable("shared/bin/nested");

    assert.equal(reconcile().status, 0);
    const sidecar = pathIn("bin/resources/app/nested");
    assert.equal(fs.readlinkSync(sidecar), "../../nested");
    assert.equal(fs.realpathSync(sidecar), fs.realpathSync(pathIn("bin/nested")));
  });

  it("leaves a real (non-sharun) nested binary untouched", () => {
    makeSharun();
    wrap("bin/command-code");
    writeExecutable("bin/resources/command-code");
    writeExecutable("shared/bin/command-code");

    assert.equal(reconcile().status, 0);
    assert.equal(fs.lstatSync(pathIn("bin/resources/command-code")).isSymbolicLink(), false);
  });

  it("fails the build when a nested wrapper cannot be mapped", () => {
    makeSharun();
    wrap("bin/resources/orphan");
    writeExecutable("shared/bin/orphan");

    const { status, stderr } = reconcile();
    assert.equal(status, 1);
    assert.match(stderr, /Nested sharun wrapper bin\/resources\/orphan has no bin\/orphan wrapper/);
  });

  it("no-ops when the app was not built with sharun", () => {
    writeExecutable("bin/resources/opencode-cli");

    assert.equal(reconcile().status, 0);
    assert.equal(fs.lstatSync(pathIn("bin/resources/opencode-cli")).isSymbolicLink(), false);
  });
});
