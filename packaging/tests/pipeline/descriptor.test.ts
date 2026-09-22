import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { descriptorLines, listApps, loadDescriptor, resolveApp, validateDescriptor } from "../../lib/pipeline/descriptor.ts";
import { descriptorPath } from "../../lib/core/paths.ts";

const APPS = listApps();

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
    assert.ok(APPS.length > 0, "expected at least one app");
    assert.deepEqual(APPS, [...APPS].sort(), "app ids must be sorted");
  });

  it("resolves app ids, which are also the cask tokens", () => {
    // Dispatch names apps by id or cask token; validateDescriptor requires the
    // two to be the same string, so both forms resolve directly.
    assert.equal(resolveApp("commandcode-desktop"), "commandcode-desktop");
    assert.equal(resolveApp("opencode-desktop"), "opencode-desktop");
    assert.equal(resolveApp("gitbutler"), "gitbutler");
    assert.equal(resolveApp("vscode"), "vscode");
    // Every app's id, cask token and asset prefix are one name.
    for (const id of APPS) {
      const descriptor = loadDescriptor(id);
      assert.equal(descriptor.cask, id);
      assert.equal(descriptor.assetPrefix, id);
      assert.equal(resolveApp(descriptor.cask), id);
    }
    assert.equal(resolveApp("nope"), undefined);
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

  it("keeps opencode-desktop's update-manifest, required feed removal and warning-level scan", () => {
    const descriptor = loadDescriptor("opencode-desktop");
    assert.equal(descriptor.oracle.kind, "update-manifest");
    if (descriptor.oracle.kind === "update-manifest") {
      assert.equal(
        descriptor.oracle.repository,
        "https://opencode.ai/update/api/latest/desktop/opencode",
      );
      assert.equal(descriptor.oracle.assetTemplate, "opencode-desktop-linux-{arch}.deb");
      assert.deepEqual(descriptor.oracle.downloadHosts, ["opencode.ai"]);
    }
    assert.equal(descriptor.payload.tree, "opt/OpenCode");
    assert.equal(descriptor.updater.removeFeed?.required, true);
    assert.deepEqual(descriptor.updater.residualScan?.patterns, ["https://opencode.ai/update/api/"]);
    // Warning, not error: the endpoint is legitimately embedded in app.asar,
    // which cannot be same-length patched (see the app README).
    assert.equal(descriptor.updater.residualScan?.severity, "warning");
    assert.deepEqual(descriptor.updater.env, { OPENCODE_DISABLE_AUTOUPDATE: "1" });
    // The desktop copies bin/resources/opencode-cli to userData and spawns it
    // outside the mount, so it must stay host-runnable (not a sharun wrapper).
    assert.deepEqual(descriptor.hostHelpers, ["bin/resources/opencode-cli"]);
  });

  it("keeps gitbutler's webkit dependency, file list and warning-level scan", () => {
    const descriptor = loadDescriptor("gitbutler");
    assert.equal(descriptor.oracle.kind, "cdn-redirect");
    assert.equal(descriptor.needsWebkit, true);
    assert.equal(descriptor.debloatArgs, "--add-common --prefer-nano webkit2gtk-4.1-mini");
    assert.deepEqual(descriptor.payload.files, [
      "usr/bin/gitbutler-tauri",
      "usr/bin/gitbutler-git-askpass",
      "usr/bin/but",
    ]);
    assert.equal(descriptor.updater.hook, "templates/prevent-autoupdate.hook");
    // Upstream webkit2gtk demo flow: GTK WM_CLASS shim plus the shared hook.
    assert.deepEqual(descriptor.quickSharun, {
      hooks: ["fix-namespaces.hook"],
      env: { GTK_CLASS_FIX: "1" },
    });
    // Warning, not error: a legitimately unpatched copy must not fail the build.
    assert.equal(descriptor.updater.residualScan?.severity, "warning");
  });

  it("keeps commandcode-desktop's versioned-asset oracle, deb staging and required feed removal", () => {
    const descriptor = loadDescriptor("commandcode-desktop");
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

  it("keeps little-genius' avakot oracle, file list and error-level scan", () => {
    const descriptor = loadDescriptor("little-genius");
    assert.equal(descriptor.oracle.kind, "avakot");
    assert.deepEqual(descriptor.architectures, ["amd64"]);
    assert.deepEqual(descriptor.binaryTargets, ["little-genius", "lg-linux-compat"]);
    assert.equal(descriptor.payload.kind, "deb-files");
    assert.deepEqual(
      descriptor.payload.kind === "deb-files" ? descriptor.payload.files : [],
      ["usr/bin/little-genius", "usr/bin/lg-linux-compat"],
    );
    assert.equal(descriptor.icon.size, "512x512");
    assert.equal(descriptor.needsWebkit, true);
    assert.equal(descriptor.updater.patchEndpoint?.from, "https://api.avakot.org/lg/manifest.json");
    assert.equal(descriptor.updater.patchEndpoint?.binaryReplacement.length, 39);
    assert.equal(descriptor.updater.residualScan?.severity, "error");
  });

  it("keeps wfhelper's AppImage oracle, tree staging and required feed removal", () => {
    const descriptor = loadDescriptor("wfhelper");
    assert.equal(descriptor.oracle.kind, "github-release");
    assert.equal(
      descriptor.oracle.kind === "github-release" ? descriptor.oracle.assetNameTemplate : "",
      "WFHelper-{version}.AppImage",
    );
    assert.equal(
      descriptor.oracle.kind === "github-release" ? descriptor.oracle.tagPrefix : "",
      "v",
    );
    assert.equal(
      descriptor.oracle.kind === "github-release" ? descriptor.oracle.packageName : "",
      "wfhelper",
    );
    assert.deepEqual(descriptor.architectures, ["amd64"]);
    assert.equal(descriptor.payload.kind, "appimage-tree");
    assert.deepEqual(
      descriptor.payload.kind === "appimage-tree" ? descriptor.payload.exclude : [],
      ["AppRun", "wfhelper.desktop", "wfhelper.png", "usr"],
    );
    assert.equal(descriptor.icon.size, "974x974");
    assert.equal(descriptor.updater.removeFeed?.required, true);
    assert.deepEqual(descriptor.updater.env, { WF_DISABLE_AUTO_UPDATE: "1" });
    assert.equal(descriptor.updater.residualScan?.severity, "warning");
  });
});

describe("quick-sharun configuration", () => {
  it("deploys fix-namespaces for every app", () => {
    for (const app of APPS) {
      const quickSharun = loadDescriptor(app).quickSharun;
      assert.deepEqual(quickSharun.hooks, ["fix-namespaces.hook"]);
      if (app === "gitbutler") {
        assert.deepEqual(quickSharun.env, { GTK_CLASS_FIX: "1" });
      } else {
        assert.equal(quickSharun.env, undefined);
      }
    }
  });

  it("accepts verbatim environment variables", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        copy["quickSharun"] = {
          hooks: ["fix-namespaces.hook", "vulkan-check.hook"],
          env: { DEPLOY_VULKAN: "1" },
        };
      }),
      "vscode",
    );
    assert.deepEqual(descriptor.quickSharun, {
      hooks: ["fix-namespaces.hook", "vulkan-check.hook"],
      env: { DEPLOY_VULKAN: "1" },
    });
  });

  it("defaults to an empty configuration when the block is absent", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        delete copy["quickSharun"];
      }),
      "vscode",
    );
    assert.deepEqual(descriptor.quickSharun, {});
  });

  it("rejects a hook name that would split the ADD_HOOKS list", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["quickSharun"] = { hooks: ["fix-namespaces.hook:other"] };
          }),
          "vscode",
        ),
      /is not a hook name/,
    );
  });

  it("rejects an unsafe environment key", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["quickSharun"] = { env: { lower_case: "1" } };
          }),
          "vscode",
        ),
      /key is not a valid name/,
    );
  });
});

describe("host helpers", () => {
  it("omits the field when the block is absent", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        delete copy["hostHelpers"];
      }),
      "vscode",
    );
    assert.equal(descriptor.hostHelpers, undefined);
  });

  it("accepts AppDir paths under bin/", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        copy["hostHelpers"] = ["bin/resources/server", "bin/helper"];
      }),
      "vscode",
    );
    assert.deepEqual(descriptor.hostHelpers, ["bin/resources/server", "bin/helper"]);
  });

  it("rejects non-arrays, bad entries and paths outside bin/", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["hostHelpers"] = "bin/resources/server";
          }),
          "vscode",
        ),
      /hostHelpers must be an array/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["hostHelpers"] = [""];
          }),
          "vscode",
        ),
      /must be a non-empty string/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["hostHelpers"] = ["/bin/server"];
          }),
          "vscode",
        ),
      /must be an AppDir-relative path/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["hostHelpers"] = ["bin/../etc/passwd"];
          }),
          "vscode",
        ),
      /must be an AppDir-relative path/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["hostHelpers"] = ["share/server"];
          }),
          "vscode",
        ),
      /must be a file under bin\//,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["hostHelpers"] = ["bin/"];
          }),
          "vscode",
        ),
      /must be a file under bin\//,
    );
  });
});

describe("release watch", () => {
  it("loads each app's watch block", () => {
    assert.deepEqual(loadDescriptor("vscode").watch, {
      feedUrl: "https://github.com/microsoft/vscode/releases.atom",
      format: "atom",
      versionPattern: "^(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      repo: "microsoft/vscode",
    });
    assert.deepEqual(loadDescriptor("opencode-desktop").watch, {
      feedUrl: "https://github.com/anomalyco/opencode/releases.atom",
      format: "atom",
      versionPattern: "^v(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      repo: "anomalyco/opencode",
    });
    assert.deepEqual(loadDescriptor("gitbutler").watch, {
      feedUrl: "https://github.com/gitbutlerapp/gitbutler/releases.atom",
      format: "atom",
      versionPattern: "^release\\/(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      skipPattern: "^nightly\\/",
      repo: "gitbutlerapp/gitbutler",
    });
    assert.deepEqual(loadDescriptor("commandcode-desktop").watch, {
      feedUrl: "https://github.com/CommandCodeAI/desktop/releases.atom",
      format: "atom",
      versionPattern: "(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      repo: "CommandCodeAI/desktop",
    });
    assert.deepEqual(loadDescriptor("little-genius").watch, {
      feedUrl: "https://api.avakot.org/lg/manifest.json",
      format: "json",
      versionField: "version",
      versionPattern: "^(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
    });
    assert.deepEqual(loadDescriptor("wfhelper").watch, {
      feedUrl: "https://github.com/WFHelper/WFHelper/releases.atom",
      format: "atom",
      versionPattern: "^v(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      repo: "WFHelper/WFHelper",
    });
  });

  it("captures the version from a real feed title", () => {
    // Feed titles are release names, not tags (e.g. "Command Code 0.1.29").
    const titles: Record<string, [string, string]> = {
      vscode: ["1.137.0", "1.137.0"],
      "opencode-desktop": ["v1.18.30", "1.18.30"],
      gitbutler: ["release/0.22.3", "0.22.3"],
      "commandcode-desktop": ["Command Code 0.1.29", "0.1.29"],
      // JSON feeds carry no titles; the pattern applies to the versionField
      // value instead (here the manifest's top-level "0.6.7").
      "little-genius": ["0.6.7", "0.6.7"],
      wfhelper: ["v2.1.0", "2.1.0"],
    };
    for (const [app, [title, version]] of Object.entries(titles)) {
      const watch = loadDescriptor(app).watch;
      assert.ok(watch !== undefined, `${app} must declare a watch block`);
      assert.equal(new RegExp(watch.versionPattern).exec(title)?.[1], version);
    }
  });

  it("skips the pre-release lines each pattern excludes", () => {
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

  it("requires the app id (directory name) to equal the cask token", () => {
    // Dispatch names apps by id or cask token and the pipeline keys on the id,
    // so they must be the same string; the directory is already asserted to be
    // the id, which makes the app directory, cask token and asset prefix one
    // name.
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            // Keep assetPrefix === cask so the id check is the one that fires.
            copy["cask"] = "other-cask";
            copy["assetPrefix"] = "other-cask";
          }),
          "vscode",
        ),
      /id \(vscode\) must equal cask \(other-cask\)/,
    );
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
          mutated("commandcode-desktop", (copy) => {
            nested(copy, "updater")["env"] = { "bad key": "1" };
          }),
          "commandcode-desktop",
        ),
      /not a valid name/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("commandcode-desktop", (copy) => {
            nested(copy, "updater")["env"] = { OK: "value\ninjected" };
          }),
          "commandcode-desktop",
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
          mutated("commandcode-desktop", (copy) => { delete nested(copy, "oracle")["tagPrefix"]; }),
          "commandcode-desktop",
        ),
      /must be set together/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("commandcode-desktop", (copy) => { nested(copy, "oracle")["assetPrefix"] = "x"; }),
          "commandcode-desktop",
        ),
      /mutually exclusive/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("commandcode-desktop", (copy) => { nested(copy, "oracle")["assetNameTemplate"] = "no-version-here.deb"; }),
          "commandcode-desktop",
        ),
      /must contain \{version\}/,
    );
  });

  it("rejects malformed update-manifest oracles", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => { delete nested(copy, "oracle")["assetTemplate"]; }),
          "opencode-desktop",
        ),
      /assetTemplate must be a non-empty string/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => { nested(copy, "oracle")["assetTemplate"] = "opencode.desb"; }),
          "opencode-desktop",
        ),
      /must contain \{arch\}/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => { nested(copy, "oracle")["downloadHosts"] = []; }),
          "opencode-desktop",
        ),
      /downloadHosts must not be empty/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => { nested(copy, "oracle")["downloadHosts"] = "opencode.ai"; }),
          "opencode-desktop",
        ),
      /downloadHosts must be an array/,
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
    // The format is declared, never defaulted: an omission must fail here rather
    // than silently watching an atom feed (the API defaults it only for
    // descriptors it did not write).
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { delete nested(copy, "watch")["format"]; }),
          "vscode",
        ),
      /watch\.format must be a non-empty string/,
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
      copy["watch"] = {
        feedUrl: "https://example.com/releases.atom",
        format: "atom",
        versionPattern: "^(\\d+)$",
      };
    });
    assert.deepEqual(validateDescriptor(minimal, "vscode").watch, {
      feedUrl: "https://example.com/releases.atom",
      format: "atom",
      versionPattern: "^(\\d+)$",
    });
  });

  it("validates the provider-specific avakot oracle", () => {
    const descriptor = loadDescriptor("little-genius");
    assert.equal(descriptor.oracle.kind, "avakot");
    if (descriptor.oracle.kind === "avakot") {
      assert.equal(descriptor.oracle.repository, "https://api.avakot.org/lg/manifest.json");
      assert.equal(descriptor.oracle.assetTemplate, "linux_x86_64_deb");
      assert.deepEqual(descriptor.oracle.downloadHosts, ["api.avakot.org"]);
    }
    assert.throws(
      () =>
        validateDescriptor(
          mutated("little-genius", (copy) => { nested(copy, "oracle")["downloadHosts"] = []; }),
          "little-genius",
        ),
      /downloadHosts must not be empty/,
    );
    // The fixed artifact name belongs to the avakot kind: as update-manifest
    // it fails the {arch} requirement, keeping the generic contract strict.
    assert.throws(
      () =>
        validateDescriptor(
          mutated("little-genius", (copy) => { nested(copy, "oracle")["kind"] = "update-manifest"; }),
          "little-genius",
        ),
      /must contain \{arch\}/,
    );
  });

  it("validates the json watch format and its version field", () => {
    const jsonWatch = {
      feedUrl: "https://api.avakot.org/lg/manifest.json",
      format: "json",
      versionField: "version",
      versionPattern: "^(\\d+)$",
    };
    assert.deepEqual(validateDescriptor(mutated("vscode", (copy) => { copy["watch"] = jsonWatch; }), "vscode").watch, jsonWatch);
    // Every descriptor declares its format; only json demands a version field.
    const atomWatch = {
      feedUrl: "https://example.com/releases.atom",
      format: "atom",
      versionPattern: "^(\\d+)$",
    };
    assert.deepEqual(validateDescriptor(mutated("vscode", (copy) => { copy["watch"] = atomWatch; }), "vscode").watch, atomWatch);
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["watch"] = {
              feedUrl: "https://api.avakot.org/lg/manifest.json",
              format: "json",
              versionPattern: "^(\\d+)$",
            };
          }),
          "vscode",
        ),
      /versionField is required when format is "json"/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["watch"] = { feedUrl: "https://example.com/x", format: "rss", versionPattern: "^(\\d+)$" };
          }),
          "vscode",
        ),
      /format must be "atom" or "json"/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["watch"] = {
              feedUrl: "https://example.com/releases.atom",
              format: "atom",
              versionPattern: "^(\\d+)$",
              versionField: "version",
            };
          }),
          "vscode",
        ),
      /versionField requires format "json"/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["watch"] = {
              feedUrl: "https://api.avakot.org/lg/manifest.json",
              format: "json",
              versionField: "a..b",
              versionPattern: "^(\\d+)$",
            };
          }),
          "vscode",
        ),
      /must be a dotted field path/,
    );
  });
});

describe("descriptor env and output lines", () => {
  it("emits the workflow variables", () => {
    const env = new Map(
      descriptorLines(loadDescriptor("commandcode-desktop"), "env").map((line) => {
        const [key = "", ...rest] = line.split("=");
        return [key, rest.join("=")] as [string, string];
      }),
    );
    assert.equal(env.get("APP_ID"), "commandcode-desktop");
    assert.equal(env.get("APP_CASK"), "commandcode-desktop");
    assert.equal(env.get("WATCH"), JSON.stringify(loadDescriptor("commandcode-desktop").watch));
    assert.equal(env.get("TAG_PREFIX"), "commandcode-desktop-v");
    assert.equal(env.get("SOURCE_DIR"), "packaging/apps/commandcode-desktop");
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
