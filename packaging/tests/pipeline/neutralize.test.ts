import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { finalizeApp, isElf, neutralizeUpdater } from "../../lib/pipeline/neutralize.ts";
import { APPS_DIR, PACKAGING_DIR } from "../../lib/core/paths.ts";
import type { AppDescriptor } from "../../lib/descriptor/app.ts";
import type { UpdaterConfig } from "../../lib/descriptor/updater.ts";

const ENDPOINT = "update.code.visualstudio.com";
const BINARY_REPLACEMENT = "update.invalidupdate.invalid";
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

let appDir: string;

function descriptorWith(updater: UpdaterConfig, id = "vscode"): AppDescriptor {
  return {
    id,
    appName: "Visual Studio Code",
    displayName: "Visual Studio Code",
    comment: "Code Editing. Redefined.",
    cask: "vscode",
    assetPrefix: "vscode",
    tagPrefix: "vscode-v",
    sourceRepo: "edgarcnp/homebrew-tap",
    sourceOwner: "edgarcnp",
    sourceDir: "packaging/apps/vscode",
    buildCommand: "./build.sh",
    debloatArgs: "--add-common",
    buildPackages: [],
    architectures: ["amd64", "arm64"],
    binaryTargets: ["code"],
    artifact: {
      kind: "github-release",
      repository: "https://api.github.com/repos/x/y",
      assetNameTemplate: "z-{version}.tar.gz",
      tagPrefix: "v",
      packageName: "z",
    },
    payload: { kind: "tarball-tree", target: "bin" },
    icon: { source: "resources/app/resources/linux/code.png", size: "1024x1024" },
    desktopTemplate: "templates/vscode.desktop",
    updater,
    quickSharun: {},
    // The Wayland-only hook is the tap's rule rather than this fixture's
    // subject: the tests that exercise it turn it back on explicitly.
    waylandOnly: false,
  };
}

function write(file: string, contents: Buffer | string): void {
  const full = path.join(appDir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function elfWith(endpoint: string): Buffer {
  // A minimal stand-in for an ELF-started binary that embeds the endpoint.
  return Buffer.concat([ELF_MAGIC, Buffer.from(`padding ${endpoint} padding`, "utf8")]);
}

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-neutralize-"));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe("isElf", () => {
  it("detects the ELF magic by offset, not by NUL bytes", () => {
    assert.equal(isElf(elfWith(ENDPOINT)), true);
    assert.equal(isElf(Buffer.from(`\u0000\u0000${ENDPOINT}`)), false);
    assert.equal(isElf(Buffer.from("plain text")), false);
    assert.equal(isElf(Buffer.from([0x7f, 0x45])), false);
  });
});

describe("neutralizeUpdater", () => {
  const patch = {
    from: ENDPOINT,
    textReplacement: "update.invalid",
    binaryReplacement: BINARY_REPLACEMENT,
    targets: "all" as const,
  };

  it("patches text and ELF files differently without resizing the ELF", () => {
    write("bin/resources/app/out/main.js", `const u = "${ENDPOINT}";`);
    write("bin/code-tunnel", elfWith(ENDPOINT));
    const elfSize = fs.statSync(path.join(appDir, "bin/code-tunnel")).size;

    const report = neutralizeUpdater(
      descriptorWith({ patchEndpoint: patch, residualScan: { patterns: [ENDPOINT], severity: "error" } }),
      appDir,
    );

    assert.equal(report.patchedFiles.length, 2);
    assert.equal(
      fs.readFileSync(path.join(appDir, "bin/resources/app/out/main.js"), "utf8"),
      'const u = "update.invalid";',
    );
    assert.equal(fs.statSync(path.join(appDir, "bin/code-tunnel")).size, elfSize);
    assert.equal(fs.readFileSync(path.join(appDir, "bin/code-tunnel")).includes(ENDPOINT), false);
    assert.ok(
      fs.readFileSync(path.join(appDir, "bin/code-tunnel")).toString("latin1").includes("update.invalid"),
    );
    assert.deepEqual(report.survivors, []);
  });

  it("skips node_modules while patching but still reports survivors", () => {
    write("node_modules/dep/index.js", ENDPOINT);
    write("bin/readme.txt", ENDPOINT);
    assert.throws(
      () =>
        neutralizeUpdater(
          descriptorWith({ patchEndpoint: patch, residualScan: { patterns: [ENDPOINT], severity: "error" } }),
          appDir,
        ),
      /neutralization incomplete/,
    );
    // The vendored copy was left untouched, and the scan found it.
    assert.equal(fs.readFileSync(path.join(appDir, "node_modules/dep/index.js"), "utf8"), ENDPOINT);
  });

  it("warns instead of failing at warning severity", () => {
    write("bin/leftover", ENDPOINT);
    const report = neutralizeUpdater(
      descriptorWith({ residualScan: { patterns: [ENDPOINT], severity: "warning" } }),
      appDir,
    );
    assert.equal(report.warnings.length, 1);
    assert.equal(report.survivors.length, 1);
  });

  it("warns when a declared JSON file is missing", () => {
    const report = neutralizeUpdater(
      descriptorWith({ removeJsonKeys: { file: "resources/app/product.json", keys: ["update"] } }),
      appDir,
    );
    assert.match(report.warnings.join("\n"), /not found/);
  });

  it("refuses a length-changing ELF patch", () => {
    write("bin/app", elfWith(ENDPOINT));
    assert.throws(
      () =>
        neutralizeUpdater(
          descriptorWith({
            patchEndpoint: { ...patch, targets: ["bin/app"], binaryReplacement: "short" },
          }),
          appDir,
        ),
      /length mismatch/,
    );
  });

  it("fails when an explicit patch target is missing", () => {
    assert.throws(
      () =>
        neutralizeUpdater(
          descriptorWith({ patchEndpoint: { ...patch, targets: ["bin/absent"] } }),
          appDir,
        ),
      /does not exist/,
    );
  });

  it("removes product.json update keys", () => {
    write(
      "bin/resources/app/product.json",
      JSON.stringify({ nameShort: "Code", updateUrl: "https://x", checksums: { a: 1 } }),
    );
    const report = neutralizeUpdater(
      descriptorWith({
        removeJsonKeys: { file: "bin/resources/app/product.json", keys: ["updateUrl", "checksums"] },
      }),
      appDir,
    );
    assert.deepEqual(report.removedJsonKeys.sort(), ["checksums", "updateUrl"]);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(appDir, "bin/resources/app/product.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(parsed, { nameShort: "Code" });
    assert.match(fs.readFileSync(path.join(appDir, "bin/resources/app/product.json"), "utf8"), /\n$/);
  });

  it("enforces the required/optional feed removal", () => {
    write("bin/resources/app-update.yml", "provider: generic\n");
    const report = neutralizeUpdater(
      descriptorWith({ removeFeed: { paths: ["bin/resources/app-update.yml"], required: true } }),
      appDir,
    );
    assert.equal(report.removedFeedFiles.length, 1);

    assert.throws(
      () =>
        neutralizeUpdater(
          descriptorWith({ removeFeed: { paths: ["bin/resources/app-update.yml"], required: true } }),
          appDir,
        ),
      /expected upstream update feed is missing/,
    );
    const optional = neutralizeUpdater(
      descriptorWith({ removeFeed: { paths: ["bin/resources/app-update.yml"], required: false } }),
      appDir,
    );
    assert.deepEqual(optional.removedFeedFiles, []);
  });
});

describe("finalizeApp", () => {
  // finalizeApp reads the hook template from appDir(descriptor.id), i.e. from
  // packaging/apps/<id>. No shipped app carries one since GitButler left, so
  // point the id at this test's own temp directory and stage the fixture there.
  function fixtureDescriptor(
    updater: UpdaterConfig,
    extraFiles?: AppDescriptor["extraFiles"],
  ): AppDescriptor {
    const descriptor = descriptorWith(updater, path.relative(APPS_DIR, appDir));
    if (extraFiles !== undefined) descriptor.extraFiles = extraFiles;
    return descriptor;
  }

  it("appends .env entries once and installs the hook", () => {
    write("bin/app", "binary");
    write("templates/prevent-autoupdate.hook", "#!/bin/sh\n");
    const descriptor = fixtureDescriptor({
      env: { CC_DISABLE_AUTO_UPDATE: "1" },
      hook: "templates/prevent-autoupdate.hook",
    });

    const first = finalizeApp(descriptor, appDir);
    const second = finalizeApp(descriptor, appDir);

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(
      fs.readFileSync(path.join(appDir, ".env"), "utf8"),
      "CC_DISABLE_AUTO_UPDATE=1\n",
    );
    const hook = path.join(appDir, "bin/prevent-autoupdate.hook");
    assert.equal(fs.existsSync(hook), true);
    assert.equal(fs.statSync(hook).mode & 0o111, 0o111);
  });

  it("installs the Wayland-only hook unless the app opts out", () => {
    write("bin/app", "binary");
    const descriptor = { ...fixtureDescriptor({}) };
    delete descriptor.waylandOnly;

    const notes = finalizeApp(descriptor, appDir);

    const installed = path.join(appDir, "bin/00-wayland-only.hook");
    assert.equal(fs.statSync(installed).mode & 0o111, 0o111);
    assert.equal(
      fs.readFileSync(installed, "utf8"),
      fs.readFileSync(path.join(PACKAGING_DIR, "lib/shell/wayland-only.hook"), "utf8"),
    );
    assert.match(notes.join("\n"), /Wayland-only hook/);
  });

  // One value per toolkit family, each carrying only its own switches: the
  // record in neutralize.ts is exhaustive over the same union.
  for (const [backend, lines] of [
    ["gdk", ["export GDK_BACKEND=wayland"]],
    [
      "electron",
      ["export XDG_SESSION_TYPE=wayland", "export ELECTRON_OZONE_PLATFORM_HINT=wayland"],
    ],
    ["moz", ["export MOZ_ENABLE_WAYLAND=1"]],
  ] as const)
  {
    it(`adds only the ${backend} switches the app declares`, () => {
      write("bin/app", "binary");
      const descriptor = { ...fixtureDescriptor({}), waylandBackend: backend };
      delete descriptor.waylandOnly;

      finalizeApp(descriptor, appDir);

      const hook = fs.readFileSync(path.join(appDir, "bin/00-wayland-only.hook"), "utf8");
      const exports = hook.split("\n").filter((entry) => entry.startsWith("export "));
      assert.deepEqual(exports, [...lines]);
      // The guard still comes first, so a host without Wayland never reaches the
      // export.
      assert.ok(hook.indexOf("WAYLAND_DISPLAY is unset") < hook.indexOf("export "));
    });
  }

  it("refuses to start when PATH has no compositor", () => {
    write("bin/app", "binary");
    const descriptor = { ...fixtureDescriptor({}) };
    delete descriptor.waylandOnly;
    finalizeApp(descriptor, appDir);
    const hook = path.join(appDir, "bin/00-wayland-only.hook");
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: ":1" };
    delete env.WAYLAND_DISPLAY;

    // AppRun sources the hook, so the guard's `exit` ends the launcher.
    const refused = spawnSync("sh", ["-c", '. "$1"', "sh", hook], { env, encoding: "utf8" });

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /needs a Wayland session/);
    assert.match(refused.stderr, /WAYLAND_DISPLAY is unset/);
  });

  it("keeps DISPLAY for the subsystems that need it on a compositor host", () => {
    write("bin/app", "binary");
    const descriptor = { ...fixtureDescriptor({}), waylandBackend: "gdk" as const };
    delete descriptor.waylandOnly;
    finalizeApp(descriptor, appDir);

    const sourced = spawnSync(
      "sh",
      ["-c", '. "$1"; printf "%s|%s" "${DISPLAY:-}" "${GDK_BACKEND:-}"', "sh", path.join(appDir, "bin/00-wayland-only.hook")],
      { env: { ...process.env, WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":1" }, encoding: "utf8" },
    );

    assert.equal(sourced.status, 0);
    assert.equal(sourced.stdout, ":1|wayland");
  });

  it("replaces a symlink at the hook path instead of writing through it", () => {
    write("bin/app", "binary");
    write("bin/payload-file", "payload bytes\n");
    fs.symlinkSync(path.join(appDir, "bin/payload-file"), path.join(appDir, "bin/00-wayland-only.hook"));
    const descriptor = { ...fixtureDescriptor({}) };
    delete descriptor.waylandOnly;

    finalizeApp(descriptor, appDir);

    assert.equal(fs.readFileSync(path.join(appDir, "bin/payload-file"), "utf8"), "payload bytes\n");
    assert.equal(fs.lstatSync(path.join(appDir, "bin/00-wayland-only.hook")).isFile(), true);
  });

  it("leaves an app that cannot draw on Wayland alone", () => {
    write("bin/app", "binary");

    const notes = finalizeApp(fixtureDescriptor({}), appDir);

    assert.deepEqual(notes, []);
    assert.equal(fs.existsSync(path.join(appDir, "bin/00-wayland-only.hook")), false);
  });

  it("fails when the hook template is missing", () => {
    assert.throws(
      () => finalizeApp(fixtureDescriptor({ hook: "templates/absent.hook" }), appDir),
      /Missing runtime hook/,
    );
  });

  it("copies extra files and is idempotent", () => {
    write("templates/vaapi-defaults.js", 'pref("a", true);\n');
    const descriptor = fixtureDescriptor({}, [
      {
        source: "templates/vaapi-defaults.js",
        target: "bin/defaults/pref/vaapi-defaults.js",
      },
    ]);

    const first = finalizeApp(descriptor, appDir);
    const second = finalizeApp(descriptor, appDir);

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    const installed = path.join(appDir, "bin/defaults/pref/vaapi-defaults.js");
    assert.equal(fs.readFileSync(installed, "utf8"), 'pref("a", true);\n');
    assert.equal(fs.statSync(installed).mode & 0o777, 0o644);
  });

  it("fails when an extra file source is missing", () => {
    assert.throws(
      () =>
        finalizeApp(
          fixtureDescriptor({}, [{ source: "templates/absent.js", target: "bin/prefs.js" }]),
          appDir,
        ),
      /Missing extra file/,
    );
  });

  it("refuses to overwrite payload bytes with a different extra file", () => {
    write("bin/defaults/pref/channel-prefs.js", "payload\n");
    write("templates/vaapi-defaults.js", "different\n");
    assert.throws(
      () =>
        finalizeApp(
          fixtureDescriptor({}, [
            {
              source: "templates/vaapi-defaults.js",
              target: "bin/defaults/pref/channel-prefs.js",
            },
          ]),
          appDir,
        ),
      /Refusing to overwrite existing file/,
    );
  });
});
