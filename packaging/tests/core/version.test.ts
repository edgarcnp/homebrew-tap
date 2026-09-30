import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareDebVersions, sortDebVersions, normalizeUpstreamVersion, parseDebVersion } from "../../lib/core/version.ts";
import { DEB_VERSION } from "../../lib/core/patterns.ts";

describe("compareDebVersions", () => {
  // Expectations follow dpkg's verrevcmp()/order() (libdpkg/version.c): the
  // end of a part and digits weigh 0, '~' weighs -1, letters weigh their ASCII
  // value, other characters weigh value + 256; digit runs compare numerically
  // with leading zeros ignored.
  const cases: Array<[string, string, -1 | 0 | 1]> = [
    ["1.133.0-1786487972", "1.133.0-1786487973", -1],
    ["1.133.0", "1.133.0", 0],
    ["1.0~beta1", "1.0", -1],
    ["1.0~", "1.0", -1],
    // the empty part sorts before letters, so a letter suffix is newer
    ["1.0", "1.0a", -1],
    ["1.0a", "1.0aa", -1],
    // letters sort before all other punctuation: the rule the previous
    // string-comparison implementation violated
    ["1.0a", "1.0+", -1],
    ["1a", "1.0", -1],
    ["1.0", "1.0.", -1],
    ["1:1.0", "2.0", 1],
    ["2.0", "1:1.0", -1],
    ["1.007", "1.7", 0],
    ["1.0-1", "1.0.1-1", -1],
    ["1.0-1", "1.0-1a", -1],
    ["0.22.3-3215", "0.22.3", 1],
  ];

  for (const [a, b, expected] of cases) {
    it(`orders ${a} vs ${b} as ${expected}`, () => {
      assert.equal(compareDebVersions(a, b), expected);
      assert.equal(compareDebVersions(b, a), expected === 0 ? 0 : (-expected as -1 | 1));
    });
  }

  it("rejects malformed versions", () => {
    assert.throws(() => compareDebVersions("../etc/passwd", "1.0"), /Invalid package version/);
    assert.throws(() => compareDebVersions("1.0", "a1.0"), /Invalid package version/);
    assert.throws(() => compareDebVersions("1.0", ""), /Invalid package version/);
  });

  it("splits epoch, upstream and revision like dpkg", () => {
    assert.deepEqual(parseDebVersion("1:2.3-4"), { epoch: "1", upstream: "2.3", revision: "4" });
    assert.deepEqual(parseDebVersion("2.3"), { epoch: "0", upstream: "2.3", revision: "" });
  });
});

describe("sortDebVersions", () => {
  it("orders a mixed release train ascending", () => {
    const versions = ["1.0.109a", "1.0.109-1", "1.0.109", "1.0.10", "1.0.9", "1.0.109~beta"];
    assert.deepEqual(sortDebVersions(versions), [
      "1.0.9",
      "1.0.10",
      "1.0.109~beta",
      "1.0.109",
      "1.0.109-1",
      "1.0.109a",
    ]);
  });

  it("orders the shapes where GNU sort -V disagrees with dpkg", () => {
    // sort -V ranks 1.0.109a before 1.0.109-1; dpkg splits the hyphen into
    // upstream+revision and ranks the lettered version second.
    assert.deepEqual(sortDebVersions(["1.0.109a", "1.0.109-1"]), ["1.0.109-1", "1.0.109a"]);
    assert.deepEqual(sortDebVersions(["1.0.109+build", "1.0.109-rc.1"]), [
      "1.0.109-rc.1",
      "1.0.109+build",
    ]);
  });

  it("leaves the input untouched and rejects malformed versions", () => {
    const versions = ["1.0.0", "0.9.0"];
    assert.deepEqual(sortDebVersions(versions), ["0.9.0", "1.0.0"]);
    assert.deepEqual(versions, ["1.0.0", "0.9.0"]);
    assert.throws(() => sortDebVersions(["v1.0.0"]), /Invalid package version/);
  });
});

describe("normalizeUpstreamVersion", () => {
  it("strips a numeric build-epoch suffix", () => {
    assert.equal(normalizeUpstreamVersion("1.133.0-1786487972"), "1.133.0");
    assert.equal(normalizeUpstreamVersion("0.22.3-3215"), "0.22.3");
  });

  it("keeps versions that carry no build epoch", () => {
    assert.equal(normalizeUpstreamVersion("0.0.109"), "0.0.109");
    assert.equal(normalizeUpstreamVersion("1.18.30"), "1.18.30");
  });

  it("strips a Debian epoch, which a cask version cannot carry", () => {
    assert.equal(normalizeUpstreamVersion("1:1.133.0-1786487972"), "1.133.0");
    assert.equal(normalizeUpstreamVersion("2:0.22.3"), "0.22.3");
  });

  it("strips Mozilla's apt ~buildN rebuild marker", () => {
    assert.equal(normalizeUpstreamVersion("157.0~build1"), "157.0");
    assert.equal(normalizeUpstreamVersion("157.0.1~build1"), "157.0.1");
    assert.equal(normalizeUpstreamVersion("157.0~build12"), "157.0");
    assert.equal(normalizeUpstreamVersion("1:157.0~build1"), "157.0");
  });

  it("keeps a '~' pre-release marker that is not a ~buildN rebuild", () => {
    assert.equal(normalizeUpstreamVersion("1.0~rc1"), "1.0~rc1");
    assert.equal(normalizeUpstreamVersion("1.0~build"), "1.0~build");
    assert.equal(normalizeUpstreamVersion("1.0~build1.1"), "1.0~build1.1");
  });
});

describe("DEB_VERSION", () => {
  it("matches the dpkg charset parseDebVersion enforces", () => {
    for (const version of ["1.0.0", "1.0.0-1", "1.0.0~rc1", "1.0.0+1"]) {
      assert.ok(DEB_VERSION.test(version), version);
      assert.doesNotThrow(() => parseDebVersion(version));
    }
    assert.equal(DEB_VERSION.test("1.0_x"), false);
    assert.throws(() => parseDebVersion("1.0_x"));
  });
});
