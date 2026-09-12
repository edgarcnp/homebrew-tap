import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { finalizeApp, isElf, neutralizeUpdater } from "./neutralize.ts";
import type { AppDescriptor, UpdaterConfig } from "./types.ts";

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
    needsWebkit: false,
    binaryTargets: ["code"],
    oracle: { kind: "github-release", repository: "https://api.github.com/repos/x/y", assetPrefix: "z" },
    payload: { kind: "deb-tree", tree: "usr/share/code" },
    icon: { source: "usr/share/pixmaps/vscode.png", size: "256x256" },
    desktopTemplate: "templates/vscode.desktop",
    updater,
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
  it("appends .env entries once and installs the hook", () => {
    write("bin/app", "binary");
    // gitbutler is the app that ships a runtime hook template.
    const descriptor = descriptorWith(
      { env: { FREEBUFF_DISABLE_UPDATE_CHECK: "1" }, hook: "templates/prevent-autoupdate.hook" },
      "gitbutler",
    );

    const first = finalizeApp(descriptor, appDir);
    const second = finalizeApp(descriptor, appDir);

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(
      fs.readFileSync(path.join(appDir, ".env"), "utf8"),
      "FREEBUFF_DISABLE_UPDATE_CHECK=1\n",
    );
    const hook = path.join(appDir, "bin/prevent-autoupdate.hook");
    assert.equal(fs.existsSync(hook), true);
    assert.equal(fs.statSync(hook).mode & 0o111, 0o111);
  });

  it("fails when the hook template is missing", () => {
    assert.throws(
      () => finalizeApp(descriptorWith({ hook: "templates/absent.hook" }, "gitbutler"), appDir),
      /Missing runtime hook/,
    );
  });
});
