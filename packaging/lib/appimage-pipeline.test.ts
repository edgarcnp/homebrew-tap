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

  it("fails on a sharun hardlink outside the legal slots", () => {
    makeSharun();
    wrap("bin/command-code");
    // a lib/gstreamer-* style wrapper: nothing resolves it from that location
    wrap("lib/gstreamer-1.0/gst-plugin-scanner");
    writeExecutable("shared/bin/gst-plugin-scanner");

    const { status, stderr } = reconcile();
    assert.equal(status, 1);
    assert.match(
      stderr,
      /sharun hardlink outside the legal slots \(lib\/gstreamer-1\.0\/gst-plugin-scanner\)/,
    );
  });

  it("no-ops when the app was not built with sharun", () => {
    writeExecutable("bin/resources/opencode-cli");

    assert.equal(reconcile().status, 0);
    assert.equal(fs.lstatSync(pathIn("bin/resources/opencode-cli")).isSymbolicLink(), false);
  });
});

// The stage exports the descriptor's quick-sharun knobs, so it needs jq (which
// the pipeline requires anyway) but no build.
const HAS_JQ = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;
const EXPORTED_NAMES = ["ADD_HOOKS", "OPTIMIZE_LAUNCH", "DEPLOY_OPENGL"];

function exportQuickSharun(
  appJson: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; env: Record<string, string> } {
  const script = [
    "set -Eeuo pipefail",
    '. "$PIPELINE_LIB"',
    "pipeline_export_quick_sharun_env",
    `for name in ${EXPORTED_NAMES.join(" ")}; do`,
    '  eval "value=\\${$name:-}"',
    '  printf "%s=%s\\n" "$name" "$value"',
    "done",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PIPELINE_LIB, APP_JSON: appJson, ...extraEnv },
  });
  const env: Record<string, string> = {};
  for (const line of (result.stdout ?? "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return { status: result.status, env };
}

describe("pipeline_export_quick_sharun_env", () => {
  it("exports the descriptor's hooks and environment variables", { skip: !HAS_JQ }, () => {
    const { status, env } = exportQuickSharun(
      JSON.stringify({
        quickSharun: {
          hooks: ["fix-namespaces.hook"],
          env: { OPTIMIZE_LAUNCH: "1", DEPLOY_OPENGL: "1" },
        },
      }),
    );
    assert.equal(status, 0);
    assert.equal(env["ADD_HOOKS"], "fix-namespaces.hook");
    assert.equal(env["OPTIMIZE_LAUNCH"], "1");
    assert.equal(env["DEPLOY_OPENGL"], "1");
  });

  it("appends to hook lists already in the environment", { skip: !HAS_JQ }, () => {
    const { env } = exportQuickSharun(
      JSON.stringify({ quickSharun: { hooks: ["fix-namespaces.hook"] } }),
      { ADD_HOOKS: "vulkan-check.hook" },
    );
    assert.equal(env["ADD_HOOKS"], "vulkan-check.hook:fix-namespaces.hook");
  });

  it("is a no-op without a quickSharun block", { skip: !HAS_JQ }, () => {
    const { status, env } = exportQuickSharun("{}");
    assert.equal(status, 0);
    for (const name of EXPORTED_NAMES) assert.equal(env[name], "");
  });
});

