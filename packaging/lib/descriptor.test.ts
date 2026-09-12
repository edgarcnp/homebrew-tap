import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { descriptorLines, listApps, loadDescriptor, validateDescriptor } from "./descriptor.ts";
import { descriptorPath } from "./paths.ts";

const APPS = ["freebuff", "gitbutler", "opencode", "vscode"];

function rawDescriptor(app: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(descriptorPath(app), "utf8")) as Record<string, unknown>;
}

function mutated(app: string, mutate: (copy: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = structuredClone(rawDescriptor(app));
  mutate(copy);
  return copy;
}

function nested(source: Record<string, unknown>, key: string): Record<string, unknown> {
  return source[key] as Record<string, unknown>;
}

describe("descriptor loading", () => {
  it("lists every app that has a descriptor", () => {
    assert.deepEqual(listApps(), APPS);
  });

  it("loads every app descriptor", () => {
    for (const app of APPS) {
      const descriptor = loadDescriptor(app);
      assert.equal(descriptor.id, app);
      assert.ok(descriptor.binaryTargets.length > 0);
      assert.ok(descriptor.sourceDir.endsWith(`/apps/${app}`));
    }
  });

  it("rejects unknown apps and missing descriptors", () => {
    assert.throws(() => loadDescriptor("nope"), /Unknown app/);
    assert.throws(() => loadDescriptor("../etc"), /Invalid app name/);
  });
});

describe("descriptor contents (regression against the previous per-app scripts)", () => {
  it("keeps vscode's apt pin, staging and updater neutralization", () => {
    const descriptor = loadDescriptor("vscode");
    assert.equal(descriptor.oracle.kind, "apt");
    assert.equal(descriptor.payload.kind, "deb-tree");
    assert.equal(descriptor.payload.tree, "usr/share/code");
    assert.equal(descriptor.icon.size, "256x256");
    assert.equal(descriptor.needsWebkit, false);
    assert.equal(descriptor.updater.removeJsonKeys?.keys.join(","), "updateUrl,checksums");
    assert.equal(descriptor.updater.patchEndpoint?.from, "update.code.visualstudio.com");
    assert.equal(descriptor.updater.patchEndpoint?.targets, "all");
    assert.equal(descriptor.updater.patchEndpoint?.binaryReplacement.length, 28);
    assert.equal(descriptor.updater.residualScan?.severity, "error");
  });

  it("keeps opencode's release assets and update flags", () => {
    const descriptor = loadDescriptor("opencode");
    assert.equal(descriptor.oracle.kind, "github-release");
    assert.equal(descriptor.oracle.kind === "github-release" ? descriptor.oracle.assetPrefix : "", "opencode-desktop-linux");
    assert.equal(descriptor.payload.tree, "opt/OpenCode");
    assert.equal(descriptor.updater.removeFeed?.required, false);
    assert.deepEqual(descriptor.updater.env, { OPENCODE_DISABLE_AUTOUPDATE: "1" });
  });

  it("keeps gitbutler's webkit dependency, file list and warning-level scan", () => {
    const descriptor = loadDescriptor("gitbutler");
    assert.equal(descriptor.oracle.kind, "cdn-redirect");
    assert.equal(descriptor.needsWebkit, true);
    assert.equal(descriptor.debloatArgs, "--add-mesa --prefer-nano");
    assert.deepEqual(descriptor.payload.files, [
      "usr/bin/gitbutler-tauri",
      "usr/bin/gitbutler-git-askpass",
      "usr/bin/but",
    ]);
    assert.equal(descriptor.updater.hook, "templates/prevent-autoupdate.hook");
    // Warning, not error: a legitimately unpatched copy must not fail the build.
    assert.equal(descriptor.updater.residualScan?.severity, "warning");
  });

  it("keeps freebuff's feed oracle, AppImage staging and required feed removal", () => {
    const descriptor = loadDescriptor("freebuff");
    assert.equal(descriptor.oracle.kind, "electron-feed");
    assert.equal(
      descriptor.oracle.kind === "electron-feed" ? descriptor.oracle.assetNameTemplate : "",
      "Freebuff-{version}-linux-{arch}.AppImage",
    );
    assert.equal(descriptor.payload.kind, "appimage-tree");
    assert.deepEqual(descriptor.payload.rename, {
      "@codebufffreebuff-desktop": "freebuff-desktop",
    });
    assert.equal(descriptor.payload.moveUsrToRoot, true);
    assert.equal(descriptor.updater.removeFeed?.required, true);
    assert.deepEqual(descriptor.updater.env, { FREEBUFF_DISABLE_UPDATE_CHECK: "1" });
  });
});

describe("descriptor validation", () => {
  it("rejects an id that does not match the directory", () => {
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["id"] = "code"; }), "vscode"),
      /does not match directory/,
    );
  });

  it("rejects missing, empty and unsafe fields", () => {
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { delete copy["appName"]; }), "vscode"),
      /appName must be a non-empty string/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["sourceDir"] = "/etc"; }), "vscode"),
      /must be a repository-relative path/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["sourceDir"] = "../../etc"; }), "vscode"),
      /must be a repository-relative path/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["needsWebkit"] = "yes"; }), "vscode"),
      /needsWebkit must be a boolean/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["binaryTargets"] = []; }), "vscode"),
      /binaryTargets must not be empty/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["tagPrefix"] = "bad prefix"; }), "vscode"),
      /not a safe name/,
    );
  });

  it("requires assetPrefix to equal the cask token", () => {
    // The pipeline names the artifact after the cask token while CI looks up
    // release assets by assetPrefix; a mismatch makes the build unfindable.
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { copy["assetPrefix"] = "code"; }),
          "vscode",
        ),
      /assetPrefix \(code\) must equal cask \(vscode\)/,
    );
    for (const app of APPS) {
      const descriptor = loadDescriptor(app);
      assert.equal(descriptor.assetPrefix, descriptor.cask);
    }
  });

  it("rejects unknown oracle and payload kinds", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { nested(copy, "oracle")["kind"] = "ftp"; }),
          "vscode",
        ),
      /Unknown resolver kind/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { nested(copy, "payload")["kind"] = "tar"; }),
          "vscode",
        ),
      /Unknown payload kind/,
    );
  });

  it("enforces the ELF same-length invariant at load time", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "updater").patchEndpoint = {
              from: "update.code.visualstudio.com",
              textReplacement: "update.invalid",
              binaryReplacement: "short",
              targets: "all",
            };
          }),
          "vscode",
        ),
      /patch length mismatch/,
    );
  });

  it("rejects unsafe updater configuration", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("freebuff", (copy) => {
            nested(copy, "updater")["env"] = { "bad key": "1" };
          }),
          "freebuff",
        ),
      /not a valid name/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("freebuff", (copy) => {
            nested(copy, "updater")["env"] = { OK: "value\ninjected" };
          }),
          "freebuff",
        ),
      /newlines or NUL/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "updater")["residualScan"] = { patterns: [], severity: "error" };
          }),
          "vscode",
        ),
      /patterns must not be empty/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "updater")["residualScan"] = { patterns: ["x"], severity: "loud" };
          }),
          "vscode",
        ),
      /severity must be/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("gitbutler", (copy) => { nested(copy, "oracle")["redirectHosts"] = []; }),
          "gitbutler",
        ),
      /redirectHosts must not be empty/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("gitbutler", (copy) => { nested(copy, "icon")["size"] = "big"; }),
          "gitbutler",
        ),
      /size must look like/,
    );
  });
});

describe("descriptor env and output lines", () => {
  it("emits the workflow variables", () => {
    const env = new Map(
      descriptorLines(loadDescriptor("freebuff"), "env").map((line) => {
        const [key = "", ...rest] = line.split("=");
        return [key, rest.join("=")] as [string, string];
      }),
    );
    assert.equal(env.get("APP_ID"), "freebuff");
    assert.equal(env.get("APP_CASK"), "freebuff-desktop");
    assert.equal(env.get("TAG_PREFIX"), "freebuff-desktop-v");
    assert.equal(env.get("SOURCE_DIR"), "packaging/apps/freebuff");
    assert.equal(env.get("BUILD_COMMAND"), "./build.sh");
    assert.equal(env.get("NEEDS_WEBKIT"), "false");
    assert.equal(env.get("DEBLOAT_ARGS"), "--add-common --prefer-nano ffmpeg-mini");
  });

  it("emits lowercase keys for job outputs", () => {
    const lines = descriptorLines(loadDescriptor("gitbutler"), "output");
    assert.ok(lines.includes("id=gitbutler"));
    assert.ok(lines.includes("cask=gitbutler"));
    assert.ok(lines.includes("asset_prefix=gitbutler"));
    assert.ok(lines.includes("needs_webkit=true"));
    assert.ok(lines.every((line) => /^[a-z_]+=/.test(line)));
  });
});
