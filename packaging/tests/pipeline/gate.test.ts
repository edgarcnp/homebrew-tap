import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNewer, planGate } from "../../lib/pipeline/gate.ts";
import type { CaskState } from "../../lib/core/types.ts";

function cask(version: string): CaskState {
  return { version, sha256: { amd64: "a".repeat(64), arm64: "b".repeat(64) } };
}

function gate(input: {
  caskVersion: string;
  requestedVersion: string;
  artifactVersion: string | null;
  releaseExists: boolean;
}): ReturnType<typeof planGate> {
  return planGate({
    cask: cask(input.caskVersion),
    requestedVersion: input.requestedVersion,
    artifactVersion: input.artifactVersion,
    releaseExists: input.releaseExists,
  });
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
  for (const [caskVersion, requested, expected] of cases) {
    it(`${caskVersion || "(empty)"} vs ${requested} -> ${expected}`, () => {
      assert.equal(isNewer(caskVersion, requested), expected);
    });
  }
});

describe("planGate", () => {
  it("builds when the cask is behind the requested version and no release exists", () => {
    const decision = gate({
      caskVersion: "1.0.0",
      requestedVersion: "1.1.0",
      artifactVersion: "1.1.0",
      releaseExists: false,
    });
    assert.equal(decision.action, "build");
    assert.match(decision.reason, /building/);
  });

  it("repairs the cask when the cask is behind but the release already exists", () => {
    const decision = gate({
      caskVersion: "1.0.0",
      requestedVersion: "1.1.0",
      artifactVersion: "1.1.0",
      releaseExists: true,
    });
    assert.equal(decision.action, "repair-cask");
    assert.match(decision.reason, /catching cask 1\.0\.0 up/);
  });

  it("skips when the cask is already at the requested version", () => {
    const decision = gate({
      caskVersion: "1.1.0",
      requestedVersion: "1.1.0",
      artifactVersion: "1.1.0",
      releaseExists: true,
    });
    assert.equal(decision.action, "skip");
    assert.match(decision.reason, /already at requested/);
  });

  it("skips when the cask is at the requested version even with no release", () => {
    const decision = gate({
      caskVersion: "1.1.0",
      requestedVersion: "1.1.0",
      artifactVersion: "1.1.0",
      releaseExists: false,
    });
    assert.equal(decision.action, "skip");
  });

  it("skips when the cask is ahead of the requested version", () => {
    const decision = gate({
      caskVersion: "1.2.0",
      requestedVersion: "1.1.0",
      artifactVersion: "1.1.0",
      releaseExists: true,
    });
    assert.equal(decision.action, "skip");
    assert.match(decision.reason, /ahead of requested/);
  });

  // The not-ready case is independent of the cask: every cask position skips,
  // because there is no payload for the requested version to build.
  for (const caskVersion of ["1.0.0", "1.1.0", "1.2.0"]) {
    it(`skips as not-ready when the payload is absent (cask ${caskVersion})`, () => {
      const decision = gate({
        caskVersion,
        requestedVersion: "1.1.0",
        artifactVersion: null,
        releaseExists: true,
      });
      assert.equal(decision.action, "skip");
      assert.equal(decision.reasonCode, "not-ready");
      assert.match(decision.reason, /not-ready: no published artifact for 1\.1\.0/);
    });
  }

  it("fails closed as not-ready when a resolver returns another version", () => {
    const decision = gate({
      caskVersion: "1.0.0",
      requestedVersion: "1.1.0",
      artifactVersion: "1.0.0",
      releaseExists: false,
    });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reasonCode, "not-ready");
    assert.match(decision.reason, /resolved 1\.0\.0 does not match requested 1\.1\.0/);
  });

  it("treats an empty or non-numeric cask pin as behind", () => {
    for (const caskVersion of ["", "latest"]) {
      const decision = gate({
        caskVersion,
        requestedVersion: "1.1.0",
        artifactVersion: "1.1.0",
        releaseExists: false,
      });
      assert.equal(decision.action, "build");
    }
  });
});
