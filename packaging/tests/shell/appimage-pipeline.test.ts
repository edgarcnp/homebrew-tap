// The sharun sidecar reconciliation stage. quick-sharun hardlinks sharun over
// every nested executable under bin/ whose basename also lands in shared/bin,
// and over lib/ executables deployed via ADD_DIR (e.g. webkit2gtk helpers).
// Only a wrapper directly under bin/ resolves shared/bin at runtime without
// the environment, so the stage re-points the rest at the bin/ wrapper.
// These tests drive the real shell stage against a synthetic AppDir: `-ef`
// only looks at the inode, so hardlinks are enough and no ELF is needed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";

const PIPELINE_LIB = path.join(REPO_ROOT, "packaging", "lib", "shell", "appimage-pipeline.sh");
const SHELL_COMMON = path.join(REPO_ROOT, "packaging", "lib", "shell", "shell-common.sh");
const STAGE = "pipeline_reconcile_sharun_sidecars";

// Every shell stage reads the descriptor through jq (which the pipeline
// requires anyway) but needs no build, so skip the tests when jq is missing.
const HAS_JQ = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

let appDir: string;
let workDir: string;

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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-work-"));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
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

  it("re-points a lib/ helper at the bin/ wrapper (webkit2gtk)", () => {
    makeSharun();
    wrap("bin/WebKitWebProcess");
    wrap("lib/webkit2gtk-4.1/WebKitWebProcess");
    writeExecutable("shared/bin/WebKitWebProcess");

    assert.equal(reconcile().status, 0);

    const sidecar = pathIn("lib/webkit2gtk-4.1/WebKitWebProcess");
    assert.equal(fs.lstatSync(sidecar).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(sidecar), "../../bin/WebKitWebProcess");
    assert.equal(fs.realpathSync(sidecar), fs.realpathSync(pathIn("bin/WebKitWebProcess")));

    // a resumed or re-run stage must stay clean
    assert.equal(reconcile().status, 0);
    assert.equal(fs.readlinkSync(sidecar), "../../bin/WebKitWebProcess");
  });

  it("scales the lib/ relative target with the nesting depth", () => {
    makeSharun();
    wrap("bin/helper");
    wrap("lib/a/b/helper");
    writeExecutable("shared/bin/helper");

    assert.equal(reconcile().status, 0);
    const sidecar = pathIn("lib/a/b/helper");
    assert.equal(fs.readlinkSync(sidecar), "../../../bin/helper");
    assert.equal(fs.realpathSync(sidecar), fs.realpathSync(pathIn("bin/helper")));
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
    // an unmappable lib/ wrapper: no bin/ wrapper exists for it
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

// Host helpers: files the app runs outside the mount (opencode-desktop staging
// bin/resources/opencode-cli to userData). The pipeline stashes the pristine
// payload files before quick-sharun wraps everything, then restores them and
// drops quick-sharun's auto-created wrappers. These tests drive both stages
// against a synthetic AppDir plus a scratch WORK_DIR.

function writeHelperFile(relative: string, content: string): void {
  fs.mkdirSync(path.dirname(pathIn(relative)), { recursive: true });
  fs.writeFileSync(pathIn(relative), content);
  fs.chmodSync(pathIn(relative), 0o755);
}

function sameInode(a: string, b: string): boolean {
  const statA = fs.statSync(a);
  const statB = fs.statSync(b);
  return statA.ino === statB.ino && statA.dev === statB.dev;
}

function runHelperStage(
  stage: string,
  appJson: Record<string, unknown>,
): { status: number | null; stderr: string } {
  const result = spawnSync(
    "bash",
    ["-c", `set -Eeuo pipefail; . "$PIPELINE_LIB"; APPDIR="$APP_DIR"; ${stage}`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PIPELINE_LIB,
        APP_DIR: appDir,
        WORK_DIR: workDir,
        APP_JSON: JSON.stringify(appJson),
      },
    },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

const HELPER_JSON = { hostHelpers: ["bin/resources/opencode-cli"] };

// What quick-sharun does to the helper: hardlink sharun over the nested file
// (_handle_nested_bins) and deploy a top-level wrapper plus the shared copy
// (the Electron resources scan).
function simulateQuickSharun(): void {
  fs.rmSync(pathIn("bin/resources/opencode-cli"));
  fs.linkSync(pathIn("sharun"), pathIn("bin/resources/opencode-cli"));
  fs.linkSync(pathIn("sharun"), pathIn("bin/opencode-cli"));
  writeHelperFile("shared/bin/opencode-cli", "patched-real");
}

describe("pipeline_stash_host_helpers", () => {
  it("stashes pristine helpers and records auto-created tops", { skip: !HAS_JQ }, () => {
    writeHelperFile("bin/resources/opencode-cli", "pristine-cli");

    assert.equal(runHelperStage("pipeline_stash_host_helpers", HELPER_JSON).status, 0);

    const stashed = path.join(workDir, "host-helpers", "bin", "resources", "opencode-cli");
    assert.equal(fs.readFileSync(stashed, "utf8"), "pristine-cli");
    assert.equal(
      fs.readFileSync(path.join(workDir, "host-helpers", ".auto-tops"), "utf8"),
      "opencode-cli\n",
    );
  });

  it("does not mark a pre-existing top-level file as auto-created", { skip: !HAS_JQ }, () => {
    writeHelperFile("bin/opencode-cli", "top-real");
    writeHelperFile("bin/resources/opencode-cli", "pristine-cli");

    assert.equal(runHelperStage("pipeline_stash_host_helpers", HELPER_JSON).status, 0);
    assert.equal(fs.existsSync(path.join(workDir, "host-helpers", ".auto-tops")), false);
  });

  it("fails when a helper is missing from the payload", { skip: !HAS_JQ }, () => {
    const { status, stderr } = runHelperStage("pipeline_stash_host_helpers", HELPER_JSON);
    assert.equal(status, 1);
    assert.match(stderr, /host helper bin\/resources\/opencode-cli/);
  });

  it("is a no-op without hostHelpers", { skip: !HAS_JQ }, () => {
    writeHelperFile("bin/resources/opencode-cli", "pristine-cli");

    assert.equal(runHelperStage("pipeline_stash_host_helpers", {}).status, 0);
    assert.equal(fs.existsSync(path.join(workDir, "host-helpers")), false);
  });
});

describe("pipeline_restore_host_helpers", () => {
  it("restores the pristine helper and drops auto-created wrappers", { skip: !HAS_JQ }, () => {
    makeSharun();
    writeHelperFile("bin/resources/opencode-cli", "pristine-cli");
    assert.equal(runHelperStage("pipeline_stash_host_helpers", HELPER_JSON).status, 0);
    simulateQuickSharun();

    assert.equal(runHelperStage("pipeline_restore_host_helpers", HELPER_JSON).status, 0);

    const dest = pathIn("bin/resources/opencode-cli");
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(dest, "utf8"), "pristine-cli");
    assert.ok((fs.statSync(dest).mode & 0o111) !== 0, "restored helper must be executable");
    assert.equal(sameInode(dest, pathIn("sharun")), false);
    assert.equal(fs.existsSync(pathIn("bin/opencode-cli")), false);
    assert.equal(fs.existsSync(pathIn("shared/bin/opencode-cli")), false);
  });

  it("restores over the reconcile symlink instead of following it", { skip: !HAS_JQ }, () => {
    makeSharun();
    writeHelperFile("bin/resources/opencode-cli", "pristine-cli");
    assert.equal(runHelperStage("pipeline_stash_host_helpers", HELPER_JSON).status, 0);
    simulateQuickSharun();
    // pipeline_reconcile_sharun_sidecars re-points the nested hardlink here;
    // a plain cp -a would follow this symlink and clobber the top wrapper.
    fs.rmSync(pathIn("bin/resources/opencode-cli"));
    fs.symlinkSync("../opencode-cli", pathIn("bin/resources/opencode-cli"));

    assert.equal(runHelperStage("pipeline_restore_host_helpers", HELPER_JSON).status, 0);

    assert.equal(fs.readFileSync(pathIn("bin/resources/opencode-cli"), "utf8"), "pristine-cli");
    assert.equal(fs.existsSync(pathIn("bin/opencode-cli")), false);
    assert.equal(fs.existsSync(pathIn("shared/bin/opencode-cli")), false);
  });

  it("keeps a pre-existing top-level binary and its shared copy", { skip: !HAS_JQ }, () => {
    makeSharun();
    writeHelperFile("bin/opencode-cli", "top-real");
    writeHelperFile("bin/resources/opencode-cli", "pristine-cli");
    assert.equal(runHelperStage("pipeline_stash_host_helpers", HELPER_JSON).status, 0);
    // quick-sharun wraps the pre-existing top-level file too.
    fs.rmSync(pathIn("bin/opencode-cli"));
    fs.linkSync(pathIn("sharun"), pathIn("bin/opencode-cli"));
    fs.rmSync(pathIn("bin/resources/opencode-cli"));
    fs.linkSync(pathIn("sharun"), pathIn("bin/resources/opencode-cli"));
    writeHelperFile("shared/bin/opencode-cli", "patched-real");

    assert.equal(runHelperStage("pipeline_restore_host_helpers", HELPER_JSON).status, 0);

    assert.equal(fs.readFileSync(pathIn("bin/resources/opencode-cli"), "utf8"), "pristine-cli");
    assert.equal(sameInode(pathIn("bin/opencode-cli"), pathIn("sharun")), true);
    assert.equal(fs.existsSync(pathIn("shared/bin/opencode-cli")), true);
  });

  it("refuses to delete a non-sharun top-level file", { skip: !HAS_JQ }, () => {
    makeSharun();
    writeHelperFile("bin/resources/opencode-cli", "pristine-cli");
    assert.equal(runHelperStage("pipeline_stash_host_helpers", HELPER_JSON).status, 0);
    fs.rmSync(pathIn("bin/resources/opencode-cli"));
    fs.linkSync(pathIn("sharun"), pathIn("bin/resources/opencode-cli"));
    // Something unexpected owns the top-level name: keep hands off, fail loud.
    writeHelperFile("bin/opencode-cli", "not-a-wrapper");
    writeHelperFile("shared/bin/opencode-cli", "patched-real");

    const { status, stderr } = runHelperStage("pipeline_restore_host_helpers", HELPER_JSON);
    assert.equal(status, 1);
    assert.match(stderr, /Refusing to remove non-sharun top-level file/);
  });

  it("is a no-op without a stash", { skip: !HAS_JQ }, () => {
    writeHelperFile("bin/resources/opencode-cli", "pristine-cli");

    assert.equal(runHelperStage("pipeline_restore_host_helpers", {}).status, 0);
    assert.equal(fs.readFileSync(pathIn("bin/resources/opencode-cli"), "utf8"), "pristine-cli");
  });
});

const EXPORTED_NAMES = ["ADD_HOOKS", "DEPLOY_OPENGL", "DEPLOY_VULKAN"];

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
          env: { DEPLOY_OPENGL: "1", DEPLOY_VULKAN: "1" },
        },
      }),
    );
    assert.equal(status, 0);
    assert.equal(env["ADD_HOOKS"], "fix-namespaces.hook");
    assert.equal(env["DEPLOY_OPENGL"], "1");
    assert.equal(env["DEPLOY_VULKAN"], "1");
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

// The quick-sharun deploy targets: the staged payload binaries plus the
// libraries the descriptor names for a runtime dlopen. quick-sharun only
// bundles what it is given directly or what ldd reaches, so a dlopened
// library missing from this list never lands in the AppImage.
function collectTargets(appJson: string): { status: number | null; targets: string[]; stderr: string } {
  const result = spawnSync(
    "bash",
    [
      "-c",
      'set -Eeuo pipefail; . "$PIPELINE_LIB"; APPDIR="$APP_DIR"; pipeline_collect_targets; printf "%s\\n" "${TARGETS[@]}"',
    ],
    { encoding: "utf8", env: { ...process.env, PIPELINE_LIB, APP_DIR: appDir, APP_JSON: appJson } },
  );
  const targets = (result.stdout ?? "").split("\n").filter((line) => line.length > 0);
  return { status: result.status, targets, stderr: result.stderr };
}

describe("pipeline_collect_targets", () => {
  let library: string;

  beforeEach(() => {
    library = path.join(workDir, "libtray.so.1");
    fs.writeFileSync(library, "");
  });

  it("appends a declared library after the staged payload files", { skip: !HAS_JQ }, () => {
    const { status, targets } = collectTargets(
      JSON.stringify({
        payload: { kind: "deb-files", files: ["usr/bin/app", "usr/bin/helper"] },
        quickSharun: { libraries: [library] },
      }),
    );
    assert.equal(status, 0);
    assert.deepEqual(targets, [pathIn("bin/app"), pathIn("bin/helper"), library]);
  });

  it("lists only the payload files when no library is declared", { skip: !HAS_JQ }, () => {
    const { status, targets } = collectTargets(
      JSON.stringify({ payload: { kind: "deb-files", files: ["usr/bin/app"] } }),
    );
    assert.equal(status, 0);
    assert.deepEqual(targets, [pathIn("bin/app")]);
  });

  it("globs the staged bin/ for a tree payload", { skip: !HAS_JQ }, () => {
    writeExecutable("bin/electron-app");
    const { status, targets } = collectTargets(JSON.stringify({ payload: { kind: "appimage-tree" } }));
    assert.equal(status, 0);
    assert.deepEqual(targets, [pathIn("bin/electron-app")]);
  });

  it("fails when a tree payload staged nothing", { skip: !HAS_JQ }, () => {
    const { status, stderr } = collectTargets(JSON.stringify({ payload: { kind: "appimage-tree" } }));
    assert.equal(status, 1);
    assert.match(stderr, /No staged binaries/);
  });

  it("fails when a declared library is not in the build environment", { skip: !HAS_JQ }, () => {
    const { status, stderr } = collectTargets(
      JSON.stringify({
        payload: { kind: "deb-files", files: ["usr/bin/app"] },
        quickSharun: { libraries: ["/does/not/exist/libtray.so.1"] },
      }),
    );
    assert.equal(status, 1);
    assert.match(stderr, /Missing quick-sharun library/);
  });
});

// The shell half of the failure contract: a pipeline site that knows why it
// failed hands the workflow a fragment, and a site that does not stays silent
// so the record job's UNCLASSIFIED fallback is the only guess in play.
describe("classify_failure", () => {
  function classify(
    script: string,
    env: Record<string, string>,
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, COMMON: SHELL_COMMON, ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("writes a one-line fragment when the workflow asked for one", () => {
    const fragment = path.join(workDir, "report-code.json");
    const result = classify(
      `set -Eeuo pipefail; . "$COMMON"; classify_failure SMOKE_FAILED "$(printf 'a\\n"b"')"`,
      { FBR_FAILURE_OUT: fragment },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(fs.readFileSync(fragment, "utf8")) as Record<string, unknown>;
    assert.equal(parsed["code"], "SMOKE_FAILED");
    // Newlines flattened and quotes dropped, so the fragment stays valid JSON
    // for the report job's jq.
    assert.equal(parsed["message"], "a b");
  });

  it("is a no-op outside the workflow", () => {
    const fragment = path.join(workDir, "report-code.json");
    const result = classify(
      `set -Eeuo pipefail; . "$COMMON"; classify_failure SMOKE_FAILED boom; echo no-fragment`,
      {},
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no-fragment/);
    assert.equal(fs.existsSync(fragment), false);
  });
});

describe("pipeline_neutralize", () => {
  function neutralize(env: Record<string, string>): { status: number | null; args: string } {
    const log = path.join(workDir, "fbr-args.txt");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail; . "$PIPELINE_LIB"; APP_ID=vscode; APPDIR=/tmp/appdir; fbr() { printf '%s\\n' "$*" >> "$ARGS_LOG"; }; pipeline_neutralize`,
      ],
      { encoding: "utf8", env: { ...process.env, PIPELINE_LIB, ARGS_LOG: log, ...env } },
    );
    return {
      status: result.status,
      args: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
    };
  }

  it("hands the workflow's fragment path to fbr", () => {
    const result = neutralize({ FBR_FAILURE_OUT: "/tmp/failure-fragment.json" });
    assert.equal(result.status, 0);
    assert.match(result.args, /neutralize --app vscode --appdir \/tmp\/appdir/);
    assert.match(result.args, /--failure-out \/tmp\/failure-fragment\.json/);
  });

  it("keeps the local invocation clean when no fragment path is set", () => {
    const result = neutralize({});
    assert.equal(result.status, 0);
    assert.equal(result.args.includes("--failure-out"), false);
  });
});

describe("pipeline_resolve", () => {
  function resolve(env: Record<string, string>): {
    status: number | null;
    args: string;
    stderr: string;
  } {
    const log = path.join(workDir, "fbr-args.txt");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail; . "$PIPELINE_LIB"; APP_ID=vscode; DEB_ARCH=amd64; WORK_DIR="$WORK"; fbr() { if [ "$1" = "resolve" ]; then printf '%s\\n' "$*" >> "$ARGS_LOG"; printf '%s\\n' "/work/payload.AppImage"; else printf '1.2.3\\n'; fi; }; pipeline_resolve`,
      ],
      { encoding: "utf8", env: { ...process.env, PIPELINE_LIB, ARGS_LOG: log, WORK: workDir, ...env } },
    );
    return {
      status: result.status,
      args: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
      stderr: result.stderr,
    };
  }

  it("hands the workflow's fragment path to fbr", () => {
    const result = resolve({ FBR_FAILURE_OUT: "/tmp/failure-fragment.json" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.args, /resolve --app vscode --arch amd64/);
    assert.match(result.args, /--failure-out \/tmp\/failure-fragment\.json/);
  });

  it("keeps the local invocation clean when no fragment path is set", () => {
    const result = resolve({});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.args.includes("--failure-out"), false);
  });
});

describe("resolve_appdir_override", () => {
  const repoDir = "/repo";
  const distDir = "/repo/dist";

  function resolveAppdir(override: string | undefined): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(
      "bash",
      ["-c", `set -Eeuo pipefail; . "$COMMON"; resolve_appdir_override "$REPO" "$DIST"`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COMMON: SHELL_COMMON,
          REPO: repoDir,
          DIST: distDir,
          ...(override === undefined ? {} : { APPIMAGE_APPDIR_OVERRIDE: override }),
        },
      },
    );
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
  }

  it("accepts a normalized override inside DIST_DIR", () => {
    const result = resolveAppdir(`${distDir}/build/../appdir`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${distDir}/appdir`);
  });

  it("rejects an override that escapes DIST_DIR through ..", () => {
    const result = resolveAppdir(`${distDir}/../outside`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be inside DIST_DIR/);
  });

  it("defaults to DIST_DIR/appimage.AppDir", () => {
    const result = resolveAppdir(undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${distDir}/appimage.AppDir`);
  });
});

describe("validate_absolute_override", () => {
  function validate(value: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      "bash",
      ["-c", `set -Eeuo pipefail; . "$COMMON"; validate_absolute_override "$VALUE" TEST`],
      { encoding: "utf8", env: { ...process.env, COMMON: SHELL_COMMON, VALUE: value } },
    );
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
  }

  it("normalizes a path and refuses the filesystem root", () => {
    assert.equal(validate("/tmp/../tmp").stdout, "/tmp");
    const root = validate("/tmp/..");
    assert.equal(root.status, 1);
    assert.match(root.stderr, /refusing TEST/);
  });
});

describe("assert_bin_elf_arch", () => {
  function elfFile(relative: string, machine: number): void {
    const target = pathIn(relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const header = Buffer.alloc(19);
    header.write("\x7fELF", 0, "binary");
    header.writeUInt8(machine, 18);
    fs.writeFileSync(target, header);
  }

  function check(appimageArch: string): { status: number | null; stderr: string } {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail; . "$PIPELINE_LIB"; APPDIR="$APP_DIR"; APPIMAGE_ARCH="${appimageArch}"; assert_bin_elf_arch`,
      ],
      { encoding: "utf8", env: { ...process.env, PIPELINE_LIB, APP_DIR: appDir } },
    );
    return { status: result.status, stderr: result.stderr };
  }

  it("accepts matching ELF machines and skips non-ELF entries", () => {
    elfFile("bin/app", 62);
    fs.writeFileSync(pathIn("bin/wrapper"), "#!/bin/sh\nexit 0\n");
    assert.equal(check("x86_64").status, 0);
    assert.equal(check("aarch64").status, 1);
  });

  it("fails a payload built for another architecture", () => {
    elfFile("bin/app", 183);
    const result = check("x86_64");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not x86_64/);
  });
});
