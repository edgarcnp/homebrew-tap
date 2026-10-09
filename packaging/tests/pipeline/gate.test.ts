import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNewer, planGate } from "../../lib/pipeline/gate.ts";
import type { CaskState } from "../../lib/core/types.ts";

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

  it("skips when the cask is ahead even if the upstream release is missing", () => {
    const decision = planGate({
      cask: cask("1.2.0"),
      upstreamVersion: "1.1.0",
      releaseExists: false,
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

  it("skips as not-ready when the requested version is newer than upstream", () => {
    // The API dispatched 1.1.0 but the advisory still sees 1.0.0: the artifact
    // is not published yet, so the gate vetoes the build even though the cask
    // is behind and a release exists for the older version.
    const decision = planGate({
      cask: cask("1.0.0"),
      upstreamVersion: "1.0.0",
      requestedVersion: "1.1.0",
      releaseExists: true,
      releaseMatchesCask: true,
    });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "not-ready: upstream publishes 1.0.0; requested 1.1.0");
    assert.equal(decision.reasonCode, "not-ready");
  });

  it("does not call an uncomparable requested version not-ready", () => {
    const decision = planGate({
      cask: cask("1.0.0"),
      upstreamVersion: "1.0.0",
      requestedVersion: "latest",
      releaseExists: true,
      releaseMatchesCask: true,
    });
    assert.equal(decision.action, "skip");
    assert.doesNotMatch(decision.reason, /not-ready/);
  });

  it("builds normally when the requested version matches upstream", () => {
    const decision = planGate({
      cask: cask("1.0.0"),
      upstreamVersion: "1.1.0",
      requestedVersion: "1.1.0",
      releaseExists: false,
      releaseMatchesCask: null,
    });
    assert.equal(decision.action, "build");
  });

  it("keeps the cask-ahead skip when the requested version is already superseded", () => {
    // The cask covers a version newer than the API asked for; there is nothing
    // to wait for, so the terminal skip wins over not-ready.
    const decision = planGate({
      cask: cask("2.0.0"),
      upstreamVersion: "1.9.0",
      requestedVersion: "1.10.0",
      releaseExists: true,
      releaseMatchesCask: null,
    });
    assert.equal(decision.action, "skip");
    assert.match(decision.reason, /ahead of upstream/);
  });
});
