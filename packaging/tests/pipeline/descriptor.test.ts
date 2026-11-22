import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { descriptorLines, listApps, loadDescriptor, resolveApp, validateDescriptor } from "../../lib/descriptor/index.ts";
import { descriptorPath } from "../../lib/core/paths.ts";
import { APP_ID } from "../../lib/core/patterns.ts";
import { descriptorJsonSchema } from "../../lib/descriptor/schema.ts";

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
    assert.equal(resolveApp("little-genius"), "little-genius");
    assert.equal(resolveApp("opencode-desktop"), "opencode-desktop");
    assert.equal(resolveApp("gitcomet"), "gitcomet");
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
      assert.equal(descriptor.sourceDir, `packaging/apps/${app}`);
    }
  });

  it("renders the descriptor type as JSON Schema", () => {
    // The schema is generated from AppDescriptorInput, so it cannot drift from
    // the validator the CLI runs. Editors use it for app.json completion.
    const schema = descriptorJsonSchema() as {
      properties?: Record<string, unknown>;
    };
    assert.ok(schema.properties?.["artifact"], "schema must describe artifact");
    assert.ok(schema.properties["payload"], "schema must describe payload");
    assert.ok(schema.properties["id"], "schema must describe id");
  });

  it("rejects unknown apps and missing descriptors", () => {
    assert.throws(() => loadDescriptor("nope"), /Unknown app/);
    assert.throws(() => loadDescriptor("../etc"), /Invalid app name/);
  });

  it("enforces the API's app-id shape for the id, cask and asset prefix", () => {
    // The API's discovery regex: it skips app directories that do not match,
    // and POST /v1/homebrew/tap/event rejects a record whose `app` does not.
    assert.equal(APP_ID.source, "^[a-z0-9][a-z0-9-]{0,63}$");
    assert.equal(APP_ID.test("a".repeat(64)), true, "64 characters is the cap");
    assert.equal(APP_ID.test("a".repeat(65)), false, "65 characters is too long");
    for (const app of APPS) {
      assert.ok(APP_ID.test(app), `${app} must match the API's app id`);
    }
    assert.throws(() => loadDescriptor("VSCode"), /Invalid app name/);
    assert.throws(() => loadDescriptor("opencode_desktop"), /Invalid app name/);
    assert.throws(() => loadDescriptor(`a${"b".repeat(64)}`), /Invalid app name/);
  });

  it("rejects an app id the API's discovery would skip, even when the directory agrees", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["id"] = "vscode_2";
          }),
          "vscode_2",
        ),
      /\.id: must be a lowercase app id/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["cask"] = "VSCode";
            copy["assetPrefix"] = "VSCode";
          }),
          "vscode",
        ),
      /cask: must be a lowercase app id/,
    );
  });
});

describe("descriptor contents (regression against the previous per-app scripts)", () => {
  it("keeps vscode's JSON asset, tarball staging and updater neutralization", () => {
    const descriptor = loadDescriptor("vscode");
    assert.equal(descriptor.artifact.kind, "json-asset");
    if (descriptor.artifact.kind === "json-asset") {
      assert.equal(
        descriptor.artifact.url,
        "https://update.code.visualstudio.com/api/update/linux-x64/stable/latest",
      );
      assert.equal(descriptor.artifact.urlField, "url");
      assert.equal(descriptor.artifact.sha256Field, "sha256hash");
      assert.equal(descriptor.artifact.versionField, "productVersion");
      assert.deepEqual(descriptor.artifact.downloadHosts, [
        "update.code.visualstudio.com",
        "vscode.download.prss.microsoft.com",
      ]);
    }
    assert.equal(descriptor.payload.kind, "tarball-tree");
    assert.equal(descriptor.payload.kind === "tarball-tree" ? descriptor.payload.root : "", "VSCode-linux-x64");
    assert.equal(descriptor.payload.kind === "tarball-tree" ? descriptor.payload.target : "", "bin");
    assert.equal(descriptor.icon.size, "1024x1024");
    assert.equal(descriptor.icon.source, "resources/app/resources/linux/code.png");
    assert.equal(descriptor.updater.removeJsonKeys?.keys.join(","), "updateUrl,checksums");
    assert.equal(descriptor.updater.patchEndpoint?.from, "update.code.visualstudio.com");
    assert.equal(descriptor.updater.patchEndpoint?.targets, "all");
    assert.equal(descriptor.updater.patchEndpoint?.binaryReplacement.length, 28);
    assert.equal(descriptor.updater.residualScan?.severity, "error");
  });

  it("keeps opencode-desktop's update-manifest, required feed removal and warning-level scan", () => {
    const descriptor = loadDescriptor("opencode-desktop");
    assert.equal(descriptor.artifact.kind, "update-manifest");
    if (descriptor.artifact.kind === "update-manifest") {
      assert.equal(
        descriptor.artifact.repository,
        "https://opencode.ai/update/api/latest/desktop/opencode",
      );
      assert.equal(descriptor.artifact.assetTemplate, "opencode-desktop-linux-{arch}.deb");
      assert.deepEqual(descriptor.artifact.downloadHosts, ["opencode.ai"]);
    }
    assert.equal(descriptor.payload.kind === "deb-tree" ? descriptor.payload.tree : "", "opt/OpenCode");
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

  it("keeps gitcomet's release tarball and repo-owned icon", () => {
    const descriptor = loadDescriptor("gitcomet");
    assert.equal(descriptor.artifact.kind, "github-release");
    if (descriptor.artifact.kind === "github-release") {
      assert.equal(descriptor.artifact.repository, "https://api.github.com/repos/Auto-Explore/GitComet");
      assert.equal(descriptor.artifact.tagPrefix, "v");
      assert.equal(
        descriptor.artifact.assetNameTemplate,
        "gitcomet-v{version}-linux-x86_64.tar.gz",
      );
      assert.equal(descriptor.artifact.packageName, "gitcomet");
    }
    assert.equal(descriptor.debloatArgs, "--add-common");
    assert.deepEqual(descriptor.architectures, ["amd64"]);
    assert.equal(descriptor.payload.kind, "tarball-tree");
    assert.equal(descriptor.payload.kind === "tarball-tree" ? descriptor.payload.root : "", undefined);
    assert.equal(descriptor.payload.kind === "tarball-tree" ? descriptor.payload.target : "", "bin");
    assert.equal(descriptor.icon.size, "512x512");
    assert.deepEqual(descriptor.icon, {
      source: "templates/gitcomet.png",
      size: "512x512",
      base: "app",
    });
    // The upstream check is a read-only toast, so upstream's supported switch
    // (seeded into the AppDir .env) is the whole neutralization: no endpoint to
    // patch, no residual scan and no runtime hook.
    assert.deepEqual(descriptor.updater.env, { GITCOMET_NO_UPDATE_CHECK: "1" });
    assert.equal(descriptor.updater.hook, undefined);
    assert.equal(descriptor.updater.residualScan, undefined);
    assert.deepEqual(descriptor.quickSharun, { hooks: ["fix-namespaces.hook"] });
  });

  it("keeps little-genius' avakot artifact, file list and error-level scan", () => {
    const descriptor = loadDescriptor("little-genius");
    assert.equal(descriptor.artifact.kind, "avakot");
    assert.deepEqual(descriptor.architectures, ["amd64"]);
    assert.deepEqual(descriptor.binaryTargets, ["little-genius", "lg-linux-compat"]);
    assert.equal(descriptor.payload.kind, "deb-files");
    assert.deepEqual(
      descriptor.payload.kind === "deb-files" ? descriptor.payload.files : [],
      ["usr/bin/little-genius", "usr/bin/lg-linux-compat"],
    );
    assert.equal(descriptor.icon.size, "512x512");
    // The tray indicator is dlopened at runtime; buildPackages installs it and
    // the descriptor names it as a quick-sharun deploy target. The 0.8.10
    // payload links the OpenSSL 3 sonames, which current Arch ships only in
    // core/openssl-3 (its openssl package is version 4).
    assert.deepEqual(descriptor.buildPackages, ["libayatana-appindicator", "openssl-3"]);
    assert.deepEqual(descriptor.quickSharun.libraries, ["/usr/lib/libayatana-appindicator3.so.1"]);
    assert.equal(descriptor.updater.patchEndpoint?.from, "https://api.avakot.org/lg/manifest.json");
    assert.equal(descriptor.updater.patchEndpoint?.binaryReplacement.length, 39);
    assert.equal(descriptor.updater.residualScan?.severity, "error");
  });

  it("keeps wfhelper's AppImage artifact, tree staging and required feed removal", () => {
    const descriptor = loadDescriptor("wfhelper");
    assert.equal(descriptor.artifact.kind, "github-release");
    assert.equal(
      descriptor.artifact.kind === "github-release" ? descriptor.artifact.assetNameTemplate : "",
      "WFHelper-{version}.AppImage",
    );
    assert.equal(
      descriptor.artifact.kind === "github-release" ? descriptor.artifact.tagPrefix : "",
      "v",
    );
    assert.equal(
      descriptor.artifact.kind === "github-release" ? descriptor.artifact.packageName : "",
      "wfhelper",
    );
    assert.deepEqual(descriptor.architectures, ["amd64"]);
    assert.equal(descriptor.payload.kind, "appimage-tree");
    assert.deepEqual(
      descriptor.payload.kind === "appimage-tree" ? descriptor.payload.exclude : [],
      ["AppRun", "wfhelper.desktop", "wfhelper.png", "usr"],
    );
    assert.equal(descriptor.icon.size, "512x512");
    assert.equal(descriptor.updater.removeFeed?.required, true);
    assert.deepEqual(descriptor.updater.env, { WF_DISABLE_AUTO_UPDATE: "1" });
    assert.equal(descriptor.updater.residualScan?.severity, "warning");
  });

  it("keeps zed's bundle tarball layout and tarball artifact", () => {
    const descriptor = loadDescriptor("zed");
    assert.equal(descriptor.artifact.kind, "github-release");
    assert.equal(
      descriptor.artifact.kind === "github-release" ? descriptor.artifact.assetNameTemplate : "",
      "zed-linux-{appimage_arch}.tar.gz",
    );
    assert.equal(descriptor.payload.kind, "tarball-tree");
    assert.equal(descriptor.payload.kind === "tarball-tree" ? descriptor.payload.root : "", "zed.app");
    assert.deepEqual(descriptor.binaryTargets, ["zed"]);
    assert.equal(descriptor.icon.source, "zed.app/share/icons/hicolor/512x512/apps/zed.png");
    assert.deepEqual(descriptor.updater.env, {
      ZED_UPDATE_EXPLANATION: "Installed by Homebrew: run brew upgrade --cask zed",
    });
    // Zed builds its cloud, LLM, updater and sign-in session URLs from one host
    // literal, so an endpoint patch on cloud.zed.dev also breaks sign-in.
    // ZED_UPDATE_EXPLANATION is upstream's own package-manager switch: init()
    // starts no updater poller, and the manual check only shows the message.
    assert.equal(descriptor.updater.patchEndpoint, undefined);
    assert.equal(descriptor.updater.residualScan, undefined);
  });

  it("keeps orca's deb payload, root resources link and updater patch", () => {
    const descriptor = loadDescriptor("orca");
    assert.equal(descriptor.artifact.kind, "github-release");
    if (descriptor.artifact.kind === "github-release") {
      assert.equal(descriptor.artifact.assetNameTemplate, "orca-ide_{version}_{arch}.deb");
      assert.equal(descriptor.artifact.tagPrefix, "v");
    }
    assert.equal(descriptor.payload.kind, "deb-tree");
    assert.equal(descriptor.payload.kind === "deb-tree" ? descriptor.payload.tree : "", "opt/Orca");
    assert.deepEqual(descriptor.appDirLinks, [
      { link: "resources", target: "bin/resources" },
      { link: "orca-ide", target: "bin/orca-ide" },
    ]);
    assert.deepEqual(descriptor.smoke, { ignoreDefunct: ["sh"] });
    assert.deepEqual(descriptor.hostHelpers, ["bin/resources/bin/orca-wayland-clipboard"]);
    assert.deepEqual(descriptor.binaryTargets, ["orca-ide"]);
    // The app pins its own generic GitHub release feed, so app-update.yml alone
    // is not enough: the repo literal is patched at both copies of the updater.
    assert.deepEqual(descriptor.updater.removeFeed, {
      paths: ["bin/resources/app-update.yml"],
      required: true,
    });
    const patch = descriptor.updater.patchEndpoint;
    assert.equal(patch?.from, "stablyai/orca");
    assert.equal(patch?.from.length, patch?.binaryReplacement.length);
    assert.deepEqual(patch?.targets, [
      "bin/resources/app.asar",
      "bin/resources/app.asar.unpacked/out/shared/updater/release-channel.js",
    ]);
    assert.equal(descriptor.updater.residualScan?.severity, "error");
  });

  it("validates a payload-owned cask desktop entry", () => {
    const descriptor = loadDescriptor("zed");
    assert.deepEqual(descriptor.caskDesktopEntry, {
      from: "share/applications/dev.zed.Zed.desktop",
      exec: "Exec=zed",
    });

    const assertRejects = (entry: unknown, expected: RegExp): void => {
      assert.throws(
        () =>
          validateDescriptor(
            mutated("zed", (copy) => {
              copy["caskDesktopEntry"] = entry;
            }),
            "zed",
          ),
        expected,
      );
    };
    assertRejects(
      { from: "share/applications/dev.zed.Zed.desktop", exec: "zed" },
      /caskDesktopEntry\.exec must be one "Exec=<command>" line/,
    );
    assertRejects(
      { from: "../outside.desktop", exec: "Exec=zed" },
      /caskDesktopEntry\.from must be a repository-relative path/,
    );
    assertRejects(
      { from: "share/applications/dev.zed.Zed.desktop", exec: "Exec=zed", path: "x" },
      /caskDesktopEntry\.path is not a known field/,
    );
  });

  it("validates a bundle tarball payload's root and target", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("zed", (copy) => {
            nested(copy, "payload")["root"] = "../outside";
          }),
          "zed",
        ),
      /must be a repository-relative path/,
    );
    // An omitted root is valid: the pipeline uses the tarball's single
    // top-level directory.
    const withoutRoot = validateDescriptor(
      mutated("artcraft-launcher", (copy) => {
        delete nested(copy, "payload")["root"];
      }),
      "artcraft-launcher",
    );
    assert.equal(withoutRoot.payload.kind === "tarball-tree" ? withoutRoot.payload.root : "x", undefined);
    assert.deepEqual(
      withoutRoot.payload.kind === "tarball-tree" ? withoutRoot.payload.exclude : undefined,
      ["share"],
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("artcraft-launcher", (copy) => {
            nested(copy, "payload")["exclude"] = ["../evil"];
          }),
          "artcraft-launcher",
        ),
      /payload\.exclude\[0\] must be a top-level name or glob/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "payload")["target"] = "usr";
          }),
          "vscode",
        ),
      /payload\.target: Invalid option/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("zed", (copy) => {
            nested(copy, "payload")["tree"] = "zed.app";
          }),
          "zed",
        ),
      /payload\.tree is not a known field/,
    );
  });

  it("keeps firefox's signed release tarball, flat staging and codec dlopens", () => {
    const descriptor = loadDescriptor("firefox");
    assert.equal(descriptor.artifact.kind, "mozilla-release");
    if (descriptor.artifact.kind === "mozilla-release") {
      assert.equal(
        descriptor.artifact.urlTemplate,
        "https://ftp.mozilla.org/pub/firefox/releases/{version}/linux-x86_64/en-US/firefox-{version}.tar.xz",
      );
      assert.equal(descriptor.artifact.signatureTemplate, "{url}.asc");
      assert.equal(descriptor.artifact.packageName, "firefox");
      assert.equal(
        descriptor.artifact.fingerprint,
        "14F26682D0916CDD81E37B6D61B7B526D98F0353",
      );
      assert.equal(descriptor.artifact.keyPath, "packaging/apps/firefox/assets/mozilla-release-key.asc");
    }
    assert.deepEqual(descriptor.architectures, ["amd64"]);
    assert.deepEqual(descriptor.binaryTargets, ["firefox"]);
    assert.equal(descriptor.payload.kind, "tarball-tree");
    assert.equal(descriptor.payload.kind === "tarball-tree" ? descriptor.payload.root : "", "firefox");
    assert.equal(descriptor.payload.kind === "tarball-tree" ? descriptor.payload.target : "", "bin");
    assert.equal(descriptor.icon.size, "128x128");
    assert.equal(descriptor.icon.source, "browser/chrome/icons/default/default128.png");
    assert.equal(
      descriptor.debloatArgs,
      "--add-common --prefer-nano ffmpeg-mini intel-media-driver-mini gdk-pixbuf2-mini",
    );
    assert.deepEqual(descriptor.buildPackages, ["libcanberra", "libxss", "speech-dispatcher"]);
    // The update service endpoint lives in application.ini, firefox-bin and
    // libxul, which can be same-length patched (libxul stores the bare host,
    // hence the scheme-less `from`). omni.ja also carries it but is a
    // CRC-checked archive, so the scan records that inert copy as a warning.
    assert.equal(descriptor.updater.patchEndpoint?.from, "aus5.mozilla.org");
    assert.equal(descriptor.updater.patchEndpoint?.binaryReplacement.length, 16);
    assert.deepEqual(descriptor.updater.patchEndpoint?.targets, [
      "bin/application.ini",
      "bin/firefox-bin",
      "bin/libxul.so",
    ]);
    assert.equal(descriptor.updater.residualScan?.severity, "warning");
    assert.equal(descriptor.updater.hook, "templates/rdd-sandbox-nvidia.hook");
    assert.deepEqual(descriptor.updater.env, {
      MOZ_LEGACY_PROFILES: "1",
      MOZ_APP_LAUNCHER: "${APPIMAGE}",
      // Host library directories the bundled loader's built-in list misses
      // (Debian multiarch, WSL); the NVIDIA VA-API driver's dependencies come
      // from the host and the shim that used to bridge them is not deployed.
      SHARUN_FALLBACK_LIBRARY_PATH: "/usr/lib/x86_64-linux-gnu:/usr/lib/wsl/lib",
    });
    // Firefox 137+ needs the force-enabled pref for its VA-API probe to run at
    // all, so the AppImage ships it as a default pref (user-overridable).
    assert.deepEqual(descriptor.extraFiles, [
      {
        source: "templates/vaapi-defaults.js",
        target: "bin/defaults/pref/vaapi-defaults.js",
      },
    ]);
    // The libs Firefox only dlopens at runtime, i.e. nothing ldd would surface.
    assert.deepEqual(descriptor.quickSharun.libraries, [
      "/usr/lib/libavcodec.so.63",
      "/usr/lib/libpipewire-0.3.so.0",
      "/usr/lib/libva.so.2",
      "/usr/lib/libva-drm.so.2",
      "/usr/lib/libcups.so.2",
      "/usr/lib/libsecret-1.so.0",
      "/usr/lib/libgssapi_krb5.so.2",
      "/usr/lib/libudev.so.1",
      "/usr/lib/libXss.so.1",
      "/usr/lib/libcanberra.so.0",
      "/usr/lib/libspeechd.so.2",
    ]);
    assert.deepEqual(descriptor.quickSharun.env, {
      DEPLOY_OPENGL: "1",
      DEPLOY_VULKAN: "1",
      URUNTIME_PRELOAD: "1",
      // cross-libc-dlopen's version-compat forwarders resolve lazily via dlsym
      // and deadlock when CUDA's cuInit first calls one from inside dlopen.
      CROSS_LIBC_DLOPEN: "0",
    });
  });
});

describe("quick-sharun configuration", () => {
  it("deploys fix-namespaces for every app", () => {
    for (const app of APPS) {
      const quickSharun = loadDescriptor(app).quickSharun;
      assert.deepEqual(quickSharun.hooks, ["fix-namespaces.hook"]);
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

  it("rejects a library path that is not absolute", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["quickSharun"] = { libraries: ["usr/lib/libfoo.so.1"] };
          }),
          "vscode",
        ),
      /must be an absolute path/,
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
      /hostHelpers: Invalid input: expected array/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["hostHelpers"] = [""];
          }),
          "vscode",
        ),
      /hostHelpers\.0: Too small/,
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

describe("extra files", () => {
  it("omits the field when the block is absent", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        delete copy["extraFiles"];
      }),
      "vscode",
    );
    assert.equal(descriptor.extraFiles, undefined);
  });

  it("accepts source/target pairs", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        copy["extraFiles"] = [
          { source: "templates/prefs.js", target: "bin/defaults/pref/prefs.js" },
        ];
      }),
      "vscode",
    );
    assert.deepEqual(descriptor.extraFiles, [
      { source: "templates/prefs.js", target: "bin/defaults/pref/prefs.js" },
    ]);
  });

  it("rejects non-arrays, escapes, unknown keys and duplicate targets", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["extraFiles"] = {};
          }),
          "vscode",
        ),
      /extraFiles: Invalid input: expected array/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["extraFiles"] = [{ source: "templates/prefs.js", target: "/bin/prefs.js" }];
          }),
          "vscode",
        ),
      /must be a repository-relative path/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["extraFiles"] = [{ source: "templates/prefs.js", target: "bin/../prefs.js" }];
          }),
          "vscode",
        ),
      /must be a repository-relative path/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["extraFiles"] = [
              { source: "templates/prefs.js", target: "bin/prefs.js", mode: "0644" },
            ];
          }),
          "vscode",
        ),
      /is not a known field/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["extraFiles"] = [
              { source: "templates/a.js", target: "bin/prefs.js" },
              { source: "templates/b.js", target: "bin/prefs.js" },
            ];
          }),
          "vscode",
        ),
      /duplicates/,
    );
  });
});

describe("AppDir links", () => {
  it("omits the field when the block is absent", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        delete copy["appDirLinks"];
      }),
      "vscode",
    );
    assert.equal(descriptor.appDirLinks, undefined);
  });

  it("accepts link/target pairs", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        copy["appDirLinks"] = [{ link: "resources", target: "bin/resources" }];
      }),
      "vscode",
    );
    assert.deepEqual(descriptor.appDirLinks, [{ link: "resources", target: "bin/resources" }]);
  });

  it("rejects non-arrays, escapes, unknown keys, duplicates and the staged bin directory", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["appDirLinks"] = {};
          }),
          "vscode",
        ),
      /appDirLinks: Invalid input: expected array/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["appDirLinks"] = [{ link: "/resources", target: "bin/resources" }];
          }),
          "vscode",
        ),
      /must be a repository-relative path/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["appDirLinks"] = [{ link: "resources", target: "bin/../share" }];
          }),
          "vscode",
        ),
      /must be a repository-relative path/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["appDirLinks"] = [{ link: "resources", target: "bin/resources", mode: "0644" }];
          }),
          "vscode",
        ),
      /is not a known field/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["appDirLinks"] = [
              { link: "resources", target: "bin/resources" },
              { link: "resources", target: "share" },
            ];
          }),
          "vscode",
        ),
      /duplicates/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["appDirLinks"] = [{ link: "bin", target: "share" }];
          }),
          "vscode",
        ),
      /must not be the staged bin directory/,
    );
  });
});

describe("smoke exceptions", () => {
  it("omits the field when the block is absent", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        delete copy["smoke"];
      }),
      "vscode",
    );
    assert.equal(descriptor.smoke, undefined);
  });

  it("accepts a defunct process name", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        copy["smoke"] = { ignoreDefunct: ["sh", "Xvfb"] };
      }),
      "vscode",
    );
    assert.deepEqual(descriptor.smoke, { ignoreDefunct: ["sh", "Xvfb"] });
  });

  it("rejects empty lists, unsafe names, duplicates and unknown keys", () => {
    const assertRejects = (block: unknown, expected: RegExp): void => {
      assert.throws(
        () =>
          validateDescriptor(
            mutated("vscode", (copy) => {
              copy["smoke"] = block;
            }),
            "vscode",
          ),
        expected,
      );
    };
    assertRejects({}, /ignoreDefunct must not be empty/);
    assertRejects({ ignoreDefunct: [] }, /ignoreDefunct must not be empty/);
    assertRejects({ ignoreDefunct: ["/bin/sh"] }, /is not a process name/);
    assertRejects({ ignoreDefunct: ["a".repeat(16)] }, /is not a process name/);
    assertRejects({ ignoreDefunct: ["sh", "sh"] }, /duplicates/);
    assertRejects({ ignoreDefunct: ["sh"], timeoutSeconds: 30 }, /is not a known field/);
  });
});

describe("release watch", () => {
  it("loads each app's watch block", () => {
    assert.deepEqual(loadDescriptor("vscode").watch, {
      feedUrl: "https://update.code.visualstudio.com/api/update/linux-x64/stable/latest",
      format: "json",
      versionField: "productVersion",
      versionPattern: "^(\\d+\\.\\d+\\.\\d+)$",
      repo: "microsoft/vscode",
    });
    assert.deepEqual(loadDescriptor("opencode-desktop").watch, {
      feedUrl: "https://opencode.ai/update/api/latest/desktop/opencode",
      format: "json",
      versionField: "version",
      versionPattern: "^(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      repo: "anomalyco/opencode",
    });
    assert.deepEqual(loadDescriptor("gitcomet").watch, {
      feedUrl: "https://api.github.com/repos/Auto-Explore/GitComet/releases",
      format: "github-release",
      versionPattern: "^GitComet v(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      skipPattern: "^GitComet v\\d+\\.\\d+\\.\\d+-rc",
      repo: "Auto-Explore/GitComet",
    });
    assert.deepEqual(loadDescriptor("little-genius").watch, {
      feedUrl: "https://api.avakot.org/lg/manifest.json",
      format: "json",
      versionField: "version",
      versionPattern: "^(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
    });
    assert.deepEqual(loadDescriptor("wfhelper").watch, {
      feedUrl: "https://api.github.com/repos/WFHelper/WFHelper/releases",
      format: "github-release",
      versionPattern: "^v(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      repo: "WFHelper/WFHelper",
    });
    assert.deepEqual(loadDescriptor("artcraft-launcher").watch, {
      feedUrl: "https://api.github.com/repos/storytold/craft-launcher/releases",
      format: "github-release",
      versionPattern: "^ArtCraft Launcher v(\\d+\\.\\d+\\.\\d+(?:[.-]\\w+)*)$",
      skipPattern: "^ArtCraft Launcher v\\d+\\.\\d+\\.\\d+-",
      repo: "storytold/craft-launcher",
    });
  });

  it("captures the version from a real feed title", () => {
    // Feed titles are release names, not tags (e.g. "GitComet v0.2.5").
    const titles: Record<string, [string, string]> = {
      "artcraft-launcher": ["ArtCraft Launcher v0.2.0", "0.2.0"],
      vscode: ["1.137.0", "1.137.0"],
      "opencode-desktop": ["2.0.18", "2.0.18"],
      gitcomet: ["GitComet v0.2.5", "0.2.5"],
      // JSON feeds carry no titles; the pattern applies to the versionField
      // value instead — vscode reads "productVersion", while opencode-desktop
      // and little-genius read their top-level "version".
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
    const gitcomet = loadDescriptor("gitcomet").watch;
    assert.ok(gitcomet?.skipPattern !== undefined);
    assert.equal(new RegExp(gitcomet.skipPattern).test("GitComet v0.3.0-rc.1"), true);
    assert.equal(new RegExp(gitcomet.skipPattern).test("GitComet v0.3.0"), false);
    const artcraft = loadDescriptor("artcraft-launcher").watch;
    assert.ok(artcraft?.skipPattern !== undefined);
    assert.equal(new RegExp(artcraft.skipPattern).test("ArtCraft Launcher v0.3.0-beta.2"), true);
    assert.equal(new RegExp(artcraft.skipPattern).test("ArtCraft Launcher v0.3.0"), false);
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
      /appName: Invalid input: expected string/,
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
      () => validateDescriptor(mutated("vscode", (copy) => { copy["binaryTargets"] = []; }), "vscode"),
      /binaryTargets: Too small/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["tagPrefix"] = "bad prefix"; }), "vscode"),
      /tagPrefix: must be a safe reference/,
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

  it("rejects unknown artifact and payload kinds", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { nested(copy, "artifact")["kind"] = "ftp"; }),
          "vscode",
        ),
      /Unknown artifact kind/,
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

  it("rejects payload renames and patch targets that leave their roots", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("wfhelper", (copy) => {
            nested(copy, "payload")["rename"] = { "WFHelper.AppImage": "../../evil" };
          }),
          "wfhelper",
        ),
      /repository-relative/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("little-genius", (copy) => {
            nested(nested(copy, "updater"), "patchEndpoint")["targets"] = ["../../etc/hosts"];
          }),
          "little-genius",
        ),
      /repository-relative/,
    );
  });

  it("accepts a release tag prefix with + and rejects empty patch targets", () => {
    assert.doesNotThrow(() =>
      validateDescriptor(
        mutated("vscode", (copy) => {
          copy["tagPrefix"] = "v+";
        }),
        "vscode",
      ),
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("little-genius", (copy) => {
            nested(nested(copy, "updater"), "patchEndpoint")["targets"] = [];
          }),
          "little-genius",
        ),
      /targets: Too small/,
    );
  });

  it("rejects the removed advisory alias", () => {
    // The alias was documented as a one-release bridge; every descriptor now
    // uses `artifact`, so an unknown-key failure is the correct outcome.
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["advisory"] = copy["artifact"];
          }),
          "vscode",
        ),
      /advisory is not a known field/,
    );
  });

  it("rejects the removed apt and redirect artifact kinds", () => {
    for (const kind of ["apt", "cdn-redirect", "electron-feed"]) {
      assert.throws(
        () =>
          validateDescriptor(
            mutated("vscode", (copy) => {
              nested(copy, "artifact")["kind"] = kind;
            }),
            "vscode",
          ),
        /Unknown artifact kind/,
      );
    }
  });

  it("validates the JSON-asset and Mozilla artifact fields", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "artifact")["url"] = "http://update.example/json";
          }),
          "vscode",
        ),
      /must be https/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "artifact")["sha256Field"] = "not a field";
          }),
          "vscode",
        ),
      /must be a dotted field path/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("firefox", (copy) => {
            nested(copy, "artifact")["urlTemplate"] = "https://ftp.mozilla.org/fixed.tar.xz";
          }),
          "firefox",
        ),
      /urlTemplate must contain \{version\}/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("firefox", (copy) => {
            nested(copy, "artifact")["signatureTemplate"] = "signature.asc";
          }),
          "firefox",
        ),
      /signatureTemplate must contain \{url\}/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("firefox", (copy) => {
            nested(copy, "artifact")["fingerprint"] = "nope";
          }),
          "firefox",
        ),
      /fingerprint/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("firefox", (copy) => {
            nested(copy, "artifact")["keyPath"] = "../../etc/key";
          }),
          "firefox",
        ),
      /repository-relative path/,
    );
  });

  it("rejects unknown keys instead of dropping a typo", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["totallyUnknown"] = true;
          }),
          "vscode",
        ),
      /totallyUnknown is not a known field/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "updater")["patchEndpoit"] = {
              from: "a",
              textReplacement: "b",
              binaryReplacement: "c",
              targets: "all",
            };
          }),
          "vscode",
        ),
      /patchEndpoit is not a known field/,
    );
  });

  it("rejects unsafe updater configuration", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "updater")["env"] = { "bad key": "1" };
          }),
          "vscode",
        ),
      /not a valid name/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "updater")["env"] = { OK: "value\ninjected" };
          }),
          "vscode",
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
      /patterns: Too small/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            nested(copy, "updater")["residualScan"] = { patterns: ["x"], severity: "loud" };
          }),
          "vscode",
        ),
      /severity: Invalid option/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => {
            nested(copy, "artifact")["downloadHosts"] = [];
          }),
          "opencode-desktop",
        ),
      /downloadHosts: Too small/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { nested(copy, "icon")["size"] = "big"; }),
          "vscode",
        ),
      /icon\.size: must be a WxH size or scalable/,
    );
  });

  it("accepts a scalable svg icon", () => {
    const descriptor = validateDescriptor(
      mutated("vscode", (copy) => {
        const icon = nested(copy, "icon");
        icon["source"] = "usr/share/icons/hicolor/scalable/apps/vscode.svg";
        icon["size"] = "scalable";
      }),
      "vscode",
    );
    assert.equal(descriptor.icon.size, "scalable");
    assert.equal(descriptor.icon.source, "usr/share/icons/hicolor/scalable/apps/vscode.svg");
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { nested(copy, "icon")["base"] = "remote"; }),
          "vscode",
        ),
      /icon\.base: Invalid option/,
    );
  });

  it("defaults to dual-arch and rejects bad architecture lists", () => {
    const without = mutated("vscode", (copy) => { delete copy["architectures"]; });
    assert.deepEqual(validateDescriptor(without, "vscode").architectures, ["amd64", "arm64"]);
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["architectures"] = []; }), "vscode"),
      /architectures: Too small/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["architectures"] = ["riscv"]; }), "vscode"),
      /architectures.*Invalid option/,
    );
    assert.throws(
      () => validateDescriptor(mutated("vscode", (copy) => { copy["architectures"] = ["amd64", "amd64"]; }), "vscode"),
      /architectures\[1\] duplicates/,
    );
  });

  it("requires the GitHub-release template fields", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("wfhelper", (copy) => { delete nested(copy, "artifact")["tagPrefix"]; }),
          "wfhelper",
        ),
      /artifact\.tagPrefix: Invalid input: expected string/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("wfhelper", (copy) => { nested(copy, "artifact")["assetPrefix"] = "x"; }),
          "wfhelper",
        ),
      /artifact\.assetPrefix is not a known field/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("wfhelper", (copy) => { nested(copy, "artifact")["assetNameTemplate"] = "no-version-here.deb"; }),
          "wfhelper",
        ),
      /must contain a placeholder/,
    );
  });

  it("rejects malformed update-manifest artifacts", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => { delete nested(copy, "artifact")["assetTemplate"]; }),
          "opencode-desktop",
        ),
      /artifact\.assetTemplate: Invalid input: expected string/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => { nested(copy, "artifact")["assetTemplate"] = "opencode.desb"; }),
          "opencode-desktop",
        ),
      /must contain \{arch\}/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => { nested(copy, "artifact")["downloadHosts"] = []; }),
          "opencode-desktop",
        ),
      /downloadHosts: Too small/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("opencode-desktop", (copy) => { nested(copy, "artifact")["downloadHosts"] = "opencode.ai"; }),
          "opencode-desktop",
        ),
      /downloadHosts: Invalid input: expected array/,
    );
  });

  it("rejects malformed watch blocks and treats the block as optional", () => {
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { delete nested(copy, "watch")["feedUrl"]; }),
          "vscode",
        ),
      /watch\.feedUrl: Invalid input: expected string/,
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
      /watch\.format: Invalid option/,
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
          mutated("gitcomet", (copy) => { nested(copy, "watch")["skipPattern"] = "["; }),
          "gitcomet",
        ),
      /watch\.skipPattern must be a valid regular expression/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("gitcomet", (copy) => { nested(copy, "watch")["skipPattern"] = ""; }),
          "gitcomet",
        ),
      /watch\.skipPattern: Too small/,
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => { copy["watch"] = "https://example.com/releases.atom"; }),
          "vscode",
        ),
      /watch: Invalid input: expected object/,
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

  it("validates the provider-specific avakot artifact", () => {
    const descriptor = loadDescriptor("little-genius");
    assert.equal(descriptor.artifact.kind, "avakot");
    if (descriptor.artifact.kind === "avakot") {
      assert.equal(descriptor.artifact.repository, "https://api.avakot.org/lg/manifest.json");
      assert.equal(descriptor.artifact.assetTemplate, "linux_x86_64_deb");
      assert.deepEqual(descriptor.artifact.downloadHosts, ["api.avakot.org"]);
    }
    assert.throws(
      () =>
        validateDescriptor(
          mutated("little-genius", (copy) => { nested(copy, "artifact")["downloadHosts"] = []; }),
          "little-genius",
        ),
      /downloadHosts: Too small/,
    );
    // The fixed artifact name belongs to the avakot kind: as update-manifest
    // it fails the {arch} requirement, keeping the generic contract strict.
    assert.throws(
      () =>
        validateDescriptor(
          mutated("little-genius", (copy) => { nested(copy, "artifact")["kind"] = "update-manifest"; }),
          "little-genius",
        ),
      /must contain \{arch\}/,
    );
  });

  it("validates the json and github-release watch formats", () => {
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
    // The releases format pins the feed to the API's releases list; a trailing
    // slash is allowed (the readers strip it).
    const releaseWatch = {
      feedUrl: "https://api.github.com/repos/acme/app/releases",
      format: "github-release",
      versionPattern: "^(\\d+)$",
    };
    assert.deepEqual(validateDescriptor(mutated("vscode", (copy) => { copy["watch"] = releaseWatch; }), "vscode").watch, releaseWatch);
    assert.deepEqual(
      validateDescriptor(
        mutated("vscode", (copy) => { copy["watch"] = { ...releaseWatch, feedUrl: `${releaseWatch.feedUrl}/` }; }),
        "vscode",
      ).watch,
      { ...releaseWatch, feedUrl: `${releaseWatch.feedUrl}/` },
    );
    assert.throws(
      () =>
        validateDescriptor(
          mutated("vscode", (copy) => {
            copy["watch"] = {
              feedUrl: "https://github.com/acme/app/releases.atom",
              format: "github-release",
              versionPattern: "^(\\d+)$",
            };
          }),
          "vscode",
        ),
      /must be a GitHub releases-list URL/,
    );
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
      /watch\.format: Invalid option/,
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
            copy["watch"] = { ...releaseWatch, versionField: "version" };
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
      descriptorLines(loadDescriptor("little-genius"), "env").map((line) => {
        const [key = "", ...rest] = line.split("=");
        return [key, rest.join("=")] as [string, string];
      }),
    );
    assert.equal(env.get("APP_ID"), "little-genius");
    assert.equal(env.get("APP_CASK"), "little-genius");
    // The watch block is the API's input; the tap never reads it, so it is not
    // exported to CI.
    assert.equal(env.has("WATCH"), false);
    assert.equal(env.get("TAG_PREFIX"), "little-genius-v");
    assert.equal(env.get("SOURCE_DIR"), "packaging/apps/little-genius");
    assert.equal(env.get("BUILD_COMMAND"), "./build.sh");
    assert.equal(env.get("DEBLOAT_ARGS"), "--add-common --prefer-nano webkit2gtk-4.1-mini gdk-pixbuf2-mini");
    assert.equal(env.get("APP_ARCHITECTURES"), '["amd64"]');
    // The webkit closure, tray indicator and OpenSSL 3 sonames are build-time-only
    // packages.
    assert.equal(env.get("BUILD_PACKAGES"), "libayatana-appindicator openssl-3");
  });

  it("emits an empty build package list when an app declares none", () => {
    const lines = descriptorLines(loadDescriptor("opencode-desktop"), "env");
    assert.ok(lines.includes("BUILD_PACKAGES="));
  });

  it("emits lowercase keys for job outputs", () => {
    const littleGenius = loadDescriptor("little-genius");
    const lines = descriptorLines(littleGenius, "output");
    assert.ok(lines.includes("id=little-genius"));
    assert.ok(lines.includes("cask=little-genius"));
    assert.ok(lines.includes("asset_prefix=little-genius"));
    assert.ok(lines.every((line) => /^[a-z_]+=/.test(line)));
  });
});
