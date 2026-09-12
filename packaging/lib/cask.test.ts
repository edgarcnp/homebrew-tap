import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkCask, readCask, readCaskFile, updateCask, writeCask } from "./cask.ts";
import { listApps, loadDescriptor } from "./descriptor.ts";
import { caskPath } from "./paths.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("readCask", () => {
  it("reads every real cask", () => {
    for (const app of listApps()) {
      const descriptor = loadDescriptor(app);
      const state = readCaskFile(caskPath(descriptor.cask));
      assert.match(state.version, /^\d/);
      assert.match(state.sha256.amd64, /^[0-9a-f]{64}$/);
      assert.match(state.sha256.arm64, /^[0-9a-f]{64}$/);
    }
  });

  it("requires exactly one version and both checksums", () => {
    const source = ["  version \"1.0.0\"", `  sha256 arm64_linux:  "${HASH_A}"`].join("\n");
    assert.throws(() => readCask(source), /x86_64_linux sha256/);
    assert.throws(() => readCask(""), /version stanza/);
    assert.throws(
      () => readCask('  version "1.0.0"\n  version "1.0.1"\n'),
      /exactly one version stanza/,
    );
  });
});

describe("updateCask", () => {
  const source = [
    'cask "demo" do',
    '  version "1.0.0"',
    `  sha256 arm64_linux:  "${HASH_A}",`,
    `         x86_64_linux: "${HASH_B}"`,
    "end",
    "",
  ].join("\n");

  it("rewrites only the version and the two checksums", () => {
    const updated = updateCask(source, {
      version: "1.2.3",
      sha256: { amd64: "1".repeat(64), arm64: "2".repeat(64) },
    });
    assert.equal(updated.split("\n").length, source.split("\n").length);
    assert.match(updated, /^ {2}version "1\.2\.3"$/m);
    assert.match(updated, new RegExp(`sha256 arm64_linux:  "2{64}",`));
    assert.match(updated, new RegExp(`x86_64_linux: "1{64}"`));
    assert.match(updated, /^cask "demo" do$/m);
    assert.equal(updated.endsWith("end\n"), true);
  });

  it("fails instead of half-updating an unexpected file", () => {
    assert.throws(
      () => updateCask('  version "1.0.0"\n', { version: "2.0.0", sha256: { amd64: HASH_A, arm64: HASH_B } }),
      /exactly one arm64_linux sha256/,
    );
    assert.throws(
      () => updateCask(source, { version: "bad\"version", sha256: { amd64: HASH_A, arm64: HASH_B } }),
      /Unsafe cask version/,
    );
    assert.throws(
      () => updateCask(source, { version: "2.0.0", sha256: { amd64: "short", arm64: HASH_B } }),
      /Invalid x86_64 sha256/,
    );
  });

  it("writes atomically and leaves no temporary file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-cask-"));
    try {
      const file = path.join(dir, "demo.rb");
      fs.writeFileSync(file, source);
      writeCask(file, { version: "9.9.9", sha256: { amd64: HASH_A, arm64: HASH_B } });
      assert.match(fs.readFileSync(file, "utf8"), /version "9\.9\.9"/);
      assert.deepEqual(fs.readdirSync(dir), ["demo.rb"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkCask", () => {
  it("accepts every real cask", () => {
    for (const app of listApps()) {
      const descriptor = loadDescriptor(app);
      const problems = checkCask(descriptor, fs.readFileSync(caskPath(descriptor.cask), "utf8"));
      assert.deepEqual(problems, [], `${app}: ${problems.join("; ")}`);
    }
  });

  it("reports descriptor drift", () => {
    const descriptor = loadDescriptor("vscode");
    const source = fs.readFileSync(caskPath(descriptor.cask), "utf8");

    const iconDrift = checkCask({ ...descriptor, icon: { ...descriptor.icon, size: "999x999" } }, source);
    assert.equal(iconDrift.length, 2, iconDrift.join("; "));
    assert.match(iconDrift.join("; "), /does not install the icon/);

    const urlDrift = checkCask({ ...descriptor, sourceRepo: "someone/else" }, source);
    assert.match(urlDrift.join("; "), /url does not match/);

    const binaryDrift = checkCask({ ...descriptor, binaryTargets: ["code-tunnel"] }, source);
    assert.match(binaryDrift.join("; "), /missing binary target "code-tunnel"/);

    const tagDrift = checkCask({ ...descriptor, tagPrefix: "other-v" }, source);
    assert.match(tagDrift.join("; "), /livecheck does not match/);

    const broken = source.replace("depends_on :linux", "depends_on :macos");
    assert.match(checkCask(descriptor, broken).join("; "), /missing depends_on :linux/);
  });
});
