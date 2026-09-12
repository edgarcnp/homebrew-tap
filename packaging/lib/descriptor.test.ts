import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { descriptorLines, listApps, loadDescriptor, validateDescriptor } from "./descriptor.ts";
import { descriptorPath } from "./paths.ts";

const APPS = ["commandcode", "gitbutler", "opencode", "vscode"];

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

  it("keeps commandcode's versioned-asset oracle, deb staging and required feed removal", () => {
    const descriptor = loadDescriptor("commandcode");
    assert.equal(descriptor.oracle.kind, "github-release");
    assert.equal(
      descriptor.oracle.kind === "github-release" ? descriptor.oracle.assetNameTemplate : "",
      "CommandCode-{version}-{arch}.deb",
    );
    assert.equal(
      descriptor.oracle.kind === "github-release" ? descriptor.oracle.tagPrefix : "",
      "v",
    );
    assert.equal(
      descriptor.oracle.kind === "github-release" ? descriptor.oracle.packageName : "",
      "command-code",
    );
    assert.deepEqual(descriptor.architectures, ["amd64"]);
    assert.equal(descriptor.payload.kind, "deb-tree");
    assert.equal(descriptor.payload.kind === "deb-tree" ? descriptor.payload.tree : "", "opt/Command Code");
    assert.equal(descriptor.icon.size, "512x512");
    assert.equal(descriptor.updater.removeFeed?.required, true);
    assert.deepEqual(descriptor.updater.env, { CC_DISABLE_AUTO_UPDATE: "1" });
    assert.equal(descriptor.updater.residualScan?.severity, "error");
  });
});

describe("release watch", () => {
  it("loads each app's watch block", () => {
    assert.deepEqual(loadDescriptor("vscode").watch, {
      feedUrl: "https://github.com/microsoft/vscode/releases.atom",
      versionPattern: "^(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      repo: "microsoft/vscode",
    });
    assert.deepEqual(loadDescriptor("opencode").watch, {
      feedUrl: "https://github.com/anomalyco/opencode/releases.atom",
      versionPattern: "^v(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      skipPattern: "^v2\\.",
      repo: "anomalyco/opencode",
    });
    assert.deepEqual(loadDescriptor("gitbutler").watch, {
      feedUrl: "https://github.com/gitbutlerapp/gitbutler/releases.atom",
      versionPattern: "^release\\/(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      skipPattern: "^nightly\\/",
      repo: "gitbutlerapp/gitbutler",
    });
    assert.deepEqual(loadDescriptor("commandcode").watch, {
      feedUrl: "https://github.com/CommandCodeAI/desktop/releases.atom",
      versionPattern: "(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      repo: "CommandCodeAI/desktop",
    });
  });

  it("captures the version from a real feed title", () => {
    // Feed titles are release names, not tags (e.g. "Command Code 0.1.29").
    const titles: Record<string, [string, string]> = {
      vscode: ["1.137.0", "1.137.0"],
      opencode: ["v1.18.30", "1.18.30"],
      gitbutler: ["release/0.22.3", "0.22.3"],
      commandcode: ["Command Code 0.1.29", "0.1.29"],
    };
    for (const app of APPS) {
      const watch = loadDescriptor(app).watch;
      assert.ok(watch !== undefined, `${app} must declare a watch block`);
      const [title, version] = titles[app] ?? ["", ""];
      assert.equal(new RegExp(watch.versionPattern).exec(title)?.[1], version);
    }
  });

  it("skips the pre-release lines each pattern excludes", () => {
    // opencode's 2.x line is a GitHub pre-release with no linux desktop
    // assets, so the watch tracks the buildable 1.x line the oracle resolves.
    const opencode = loadDescriptor("opencode").watch;
    assert.ok(opencode?.skipPattern !== undefined);
    assert.equal(new RegExp(opencode.skipPattern).test("v2.0.2"), true);

    const gitbutler = loadDescriptor("gitbutler").watch;
    assert.ok(gitbutler?.skipPattern !== undefined);
    assert.equal(new RegExp(gitbutler.skipPattern).test("nightly/0.5.2194"), true);
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
          mutated("commandcode", (copy) => {
            nested(copy, "updater")["env"] = { "bad key": "1" };
          }),
          "commandcode",
        ),
      /not a valid name/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("commandcode", (copy) => {
            nested(copy, "updater")["env"] = { OK: "value\ninjected" };
          }),
          "commandcode",
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

  it("defaults to dual-arch and rejects bad architecture lists", () => {
    const without = mutated("vscode", (copy) => { delete copy["architectures"]; });
    assert.deepEqual(validateDescriptor(without, "vscode").architectures, ["amd64", "arm64"]);
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["architectures"] = []; }), "vscode"),
      /non-empty array/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["architectures"] = ["riscv"]; }), "vscode"),
      /must be one of/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["architectures"] = ["amd64", "amd64"]; }), "vscode"),
      /duplicates/,
    );
  });

  it("requires the versioned-asset oracle fields together and exclusively", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("commandcode", (copy) => { delete nested(copy, "oracle")["tagPrefix"]; }),
          "commandcode",
        ),
      /must be set together/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("commandcode", (copy) => { nested(copy, "oracle")["assetPrefix"] = "x"; }),
          "commandcode",
        ),
      /mutually exclusive/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("commandcode", (copy) => { nested(copy, "oracle")["assetNameTemplate"] = "no-version-here.deb"; }),
          "commandcode",
        ),
      /must contain \{version\}/,
    );
  });

  it("rejects malformed watch blocks and treats the block as optional", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { delete nested(copy, "watch")["feedUrl"]; }),
          "vscode",
        ),
      /watch\.feedUrl must be a non-empty string/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { nested(copy, "watch")["versionPattern"] = "("; }),
          "vscode",
        ),
      /watch\.versionPattern must be a valid regular expression/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("gitbutler", (copy) => { nested(copy, "watch")["skipPattern"] = "["; }),
          "gitbutler",
        ),
      /watch\.skipPattern must be a valid regular expression/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("gitbutler", (copy) => { nested(copy, "watch")["skipPattern"] = ""; }),
          "gitbutler",
        ),
      /watch\.skipPattern must be a non-empty string/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { copy["watch"] = "https://example.com/releases.atom"; }),
          "vscode",
        ),
      /watch must be an object/,
    );

    const withoutWatch = mutated("vscode", (copy) => { delete copy["watch"]; });
    assert.equal(validateDescriptor(withoutWatch, "vscode").watch, undefined);
    const minimal = mutated("vscode", (copy) => {
      copy["watch"] = { feedUrl: "https://example.com/releases.atom", versionPattern: "^(\\d+)$" };
    });
    assert.deepEqual(validateDescriptor(minimal, "vscode").watch, {
      feedUrl: "https://example.com/releases.atom",
      versionPattern: "^(\\d+)$",
    });
  });
});

describe("descriptor env and output lines", () => {
  it("emits the workflow variables", () => {
    const env = new Map(
      descriptorLines(loadDescriptor("commandcode"), "env").map((line) => {
        const [key = "", ...rest] = line.split("=");
        return [key, rest.join("=")] as [string, string];
      }),
    );
    assert.equal(env.get("APP_ID"), "commandcode");
    assert.equal(env.get("APP_CASK"), "commandcode-desktop");
    assert.equal(env.get("WATCH"), JSON.stringify(loadDescriptor("commandcode").watch));
    assert.equal(env.get("TAG_PREFIX"), "commandcode-desktop-v");
    assert.equal(env.get("SOURCE_DIR"), "packaging/apps/commandcode");
    assert.equal(env.get("BUILD_COMMAND"), "./build.sh");
    assert.equal(env.get("NEEDS_WEBKIT"), "false");
    assert.equal(env.get("DEBLOAT_ARGS"), "--add-common --prefer-nano ffmpeg-mini");
    assert.equal(env.get("APP_ARCHITECTURES"), '["amd64"]');
  });

  it("emits lowercase keys for job outputs", () => {
    const gitbutler = loadDescriptor("gitbutler");
    const lines = descriptorLines(gitbutler, "output");
    assert.ok(lines.includes("id=gitbutler"));
    assert.ok(lines.includes("cask=gitbutler"));
    assert.ok(lines.includes(`watch=${JSON.stringify(gitbutler.watch)}`));
    assert.ok(lines.includes("asset_prefix=gitbutler"));
    assert.ok(lines.includes("needs_webkit=true"));
    assert.ok(lines.every((line) => /^[a-z_]+=/.test(line)));
  });
});
