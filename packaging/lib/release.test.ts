import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadDescriptor } from "./descriptor.ts";
import { sha256Hex } from "./http.ts";
import { compareReleasedAssets } from "./release.ts";

// vscode ships both architectures, so it exercises the dual-arch walk.
const descriptor = loadDescriptor("vscode");

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

describe("compareReleasedAssets", () => {
  it("matches when every shipped asset hashes to the cask pin", () => {
    withAssets(
      {
        "vscode-1.0.0-x86_64.AppImage": "amd64-bytes",
        "vscode-1.0.0-aarch64.AppImage": "arm64-bytes",
      },
      (dir) => {
        const result = compareReleasedAssets(descriptor, {
          version: "1.0.0",
          sha256: {
            amd64: sha256Hex("amd64-bytes"),
            arm64: sha256Hex("arm64-bytes"),
          },
        }, dir);
        assert.deepEqual(result, { matches: true, notes: [] });
      },
    );
  });

  it("reports a hash mismatch as false", () => {
    withAssets(
      {
        "vscode-1.0.0-x86_64.AppImage": "amd64-bytes",
        "vscode-1.0.0-aarch64.AppImage": "arm64-bytes",
      },
      (dir) => {
        const result = compareReleasedAssets(descriptor, {
          version: "1.0.0",
          sha256: { amd64: "0".repeat(64), arm64: sha256Hex("arm64-bytes") },
        }, dir);
        assert.equal(result.matches, false);
        assert.match(result.notes.join("; "), /amd64 asset .* hashes to/);
      },
    );
  });

  it("cannot compare when a shipped architecture has no or several assets", () => {
    withAssets({ "vscode-1.0.0-x86_64.AppImage": "amd64-bytes" }, (dir) => {
      const missing = compareReleasedAssets(descriptor, {
        version: "1.0.0",
        sha256: { amd64: sha256Hex("amd64-bytes"), arm64: "0".repeat(64) },
      }, dir);
      assert.equal(missing.matches, null);
      assert.match(missing.notes.join("; "), /expected exactly one aarch64 asset/);
    });

    withAssets(
      {
        "vscode-1.0.0-x86_64.AppImage": "amd64-bytes",
        "vscode-1.0.1-x86_64.AppImage": "amd64-other",
        "vscode-1.0.0-aarch64.AppImage": "arm64-bytes",
      },
      (dir) => {
        const duplicated = compareReleasedAssets(descriptor, {
          version: "1.0.0",
          sha256: { amd64: sha256Hex("amd64-bytes"), arm64: sha256Hex("arm64-bytes") },
        }, dir);
        assert.equal(duplicated.matches, null);
        assert.match(duplicated.notes.join("; "), /expected exactly one x86_64 asset/);
      },
    );
  });

  it("cannot compare when the cask does not pin a shipped architecture", () => {
    withAssets(
      {
        "vscode-1.0.0-x86_64.AppImage": "amd64-bytes",
        "vscode-1.0.0-aarch64.AppImage": "arm64-bytes",
      },
      (dir) => {
        const result = compareReleasedAssets(descriptor, {
          version: "1.0.0",
          sha256: { amd64: sha256Hex("amd64-bytes") },
        }, dir);
        assert.equal(result.matches, null);
        assert.match(result.notes.join("; "), /cask does not pin the arm64 checksum/);
      },
    );
  });
});
