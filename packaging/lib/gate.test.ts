import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNewer, planGate } from "./gate.ts";
import type { CaskState } from "./types.ts";

function cask(version: string): CaskState {
  return { version, sha256: { amd64: "a".repeat(64), arm64: "b".repeat(64) } };
}

describe("isNewer", () => {
  const cases: Array<[string, string, boolean]> = [
    ["1.9.0", "1.10.0", true],
    ["1.10.0", "1.10.0", false],
    ["1.11.0", "1.10.0", false],
    ["", "1.0.0", true],
    ["latest", "1.0.0", true],
    // Debian semantics: '~' marks a pre-release, while '-1' is a revision and
    // therefore newer than the bare version.
    ["1.0.0~beta.1", "1.0.0", true],
    ["1.0.0-1", "1.0.0", false],
  ];
  for (const [caskVersion, upstream, expected] of cases) {
    it(`${caskVersion || "(empty)"} vs ${upstream} -> ${expected}`, () => {
      assert.equal(isNewer(caskVersion, upstream), expected);
    });
  }
});

describe("planGate", () => {
  it("builds when upstream is newer and no release exists", () => {
    const decision = planGate({
      cask: cask("1.0.0"),
      upstreamVersion: "1.1.0",
      releaseExists: false,
      releaseMatchesCask: null,
    });
    assert.equal(decision.action, "build");
    assert.match(decision.reason, /building/);
  });

  it("repairs the cask when upstream is newer but already published", () => {
    const decision = planGate({
      cask: cask("1.0.0"),
      upstreamVersion: "1.1.0",
      releaseExists: true,
      releaseMatchesCask: null,
    });
    assert.equal(decision.action, "repair-cask");
    assert.match(decision.reason, /catching cask up/);
  });

  it("skips when the cask is already at upstream and the assets match", () => {
    const decision = planGate({
      cask: cask("1.1.0"),
      upstreamVersion: "1.1.0",
      releaseExists: true,
      releaseMatchesCask: true,
    });
    assert.equal(decision.action, "skip");
  });

  it("repairs when the release assets no longer match the pinned checksums", () => {
    const decision = planGate({
      cask: cask("1.1.0"),
      upstreamVersion: "1.1.0",
      releaseExists: true,
      releaseMatchesCask: false,
    });
    assert.equal(decision.action, "repair-cask");
    assert.match(decision.reason, /assets differ/);
  });

  it("repairs when the asset comparison could not run", () => {
    const decision = planGate({
      cask: cask("1.1.0"),
      upstreamVersion: "1.1.0",
      releaseExists: true,
      releaseMatchesCask: null,
    });
    assert.equal(decision.action, "repair-cask");
    // Distinct from a known mismatch, so the reason names which happened.
    assert.match(decision.reason, /could not be compared/);
  });

  it("skips when the cask is ahead of upstream", () => {
    const decision = planGate({
      cask: cask("1.2.0"),
      upstreamVersion: "1.1.0",
      releaseExists: true,
      releaseMatchesCask: null,
    });
    assert.equal(decision.action, "skip");
    assert.match(decision.reason, /ahead of upstream/);
  });

  it("rebuilds when the cask pins a version with no release", () => {
    const decision = planGate({
      cask: cask("1.1.0"),
      upstreamVersion: "1.1.0",
      releaseExists: false,
      releaseMatchesCask: null,
    });
    assert.equal(decision.action, "build");
    assert.match(decision.reason, /no release/);
  });
});
