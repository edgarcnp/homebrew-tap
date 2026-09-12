import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareDebVersions, normalizeUpstreamVersion, parseDebVersion } from "./version.ts";

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

describe("normalizeUpstreamVersion", () => {
  it("strips a numeric build-epoch suffix", () => {
    assert.equal(normalizeUpstreamVersion("1.133.0-1786487972"), "1.133.0");
    assert.equal(normalizeUpstreamVersion("0.22.3-3215"), "0.22.3");
  });

  it("keeps versions that carry no build epoch", () => {
    assert.equal(normalizeUpstreamVersion("0.0.109"), "0.0.109");
    assert.equal(normalizeUpstreamVersion("1.18.30"), "1.18.30");
  });
});
