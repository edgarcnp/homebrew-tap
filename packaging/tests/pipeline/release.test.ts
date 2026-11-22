import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadDescriptor } from "../../lib/descriptor/index.ts";
import { sha256Hex } from "../../lib/core/http.ts";
import { planReleasePrune, renderReleaseNotes } from "../../lib/pipeline/release.ts";
import type { AppDescriptor } from "../../lib/descriptor/app.ts";

// Every shipped cask is amd64-only, so the dual-arch walk (both assets, both
// pins) is exercised with a synthetic descriptor instead of a real app.
const descriptor: AppDescriptor = { ...loadDescriptor("vscode"), architectures: ["amd64", "arm64"] };

function withAssets(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-release-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("planReleasePrune", () => {
  it("returns the oldest versions beyond the keep window", () => {
    const plan = planReleasePrune(
      ["vscode-v1.9.0", "vscode-v1.137.0", "vscode-v1.10.0"],
      "vscode-v",
      2,
    );
    assert.deepEqual(plan.versions, ["1.9.0", "1.10.0", "1.137.0"]);
    assert.deepEqual(plan.stale, ["1.9.0"]);
  });

  it("orders by dpkg, so a lettered version is not mistaken for the newest", () => {
    const plan = planReleasePrune(
      ["vscode-v1.0.109-1", "vscode-v1.0.109a", "vscode-v1.9.0"],
      "vscode-v",
      1,
    );
    assert.deepEqual(plan.stale, ["1.0.109-1", "1.0.109a"]);
  });

  it("ignores other tags and reports nothing stale within the window", () => {
    const plan = planReleasePrune(["other-v9.9.9", "vscode-v1.0.0", ""], "vscode-v", 3);
    assert.deepEqual(plan.versions, ["1.0.0"]);
    assert.deepEqual(plan.stale, []);
  });

  it("fails on an empty or unparseable version under the prefix", () => {
    assert.throws(() => planReleasePrune(["vscode-v"], "vscode-v", 1), /empty version/);
    assert.throws(() => planReleasePrune(["vscode-v../etc"], "vscode-v", 1), /Invalid package version/);
  });
});

describe("renderReleaseNotes", () => {
  const assets = {
    "vscode-1.0.0-x86_64.AppImage": "amd64-bytes",
    "vscode-1.0.0-aarch64.AppImage": "arm64-bytes",
  };

  it("tables the upstream and AppImage checksums and the sources", () => {
    withAssets(assets, (dir) => {
      const notes = renderReleaseNotes(descriptor, {
        amd64: { sha256: "a".repeat(64), url: "https://example.test/amd64" },
        arm64: { sha256: "b".repeat(64), url: "https://example.test/arm64" },
      }, dir);
      assert.match(notes, /\| Artifact \| SHA-256 \|/);
      assert.match(notes, new RegExp(`\\| Upstream package \\(amd64\\) \\| \`${"a".repeat(64)}\` \\|`));
      assert.match(notes, new RegExp(`\\| Upstream package \\(arm64\\) \\| \`${"b".repeat(64)}\` \\|`));
      assert.match(notes, new RegExp(`\\| AppImage \\(aarch64\\) \\| \`${sha256Hex("arm64-bytes")}\` \\|`));
      assert.match(notes, new RegExp(`\\| AppImage \\(x86_64\\) \\| \`${sha256Hex("amd64-bytes")}\` \\|`));
      assert.match(notes, /- Upstream package \(amd64\): https:\/\/example\.test\/amd64/);
      assert.match(notes, /- Upstream package \(arm64\): https:\/\/example\.test\/arm64/);
      assert.equal(notes.endsWith("\n"), true);
    });
  });

  it("marks a missing upstream amd64 checksum n/a and omits the arm64 rows", () => {
    withAssets({ "vscode-1.0.0-x86_64.AppImage": "amd64-bytes" }, (dir) => {
      const notes = renderReleaseNotes(descriptor, {}, dir);
      assert.match(notes, /\| Upstream package \(amd64\) \| `n\/a` \|/);
      assert.doesNotMatch(notes, /Upstream package \(arm64\)/);
    });
  });
});
