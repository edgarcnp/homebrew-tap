import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { substitutePlaceholders } from "../../lib/core/template.ts";

describe("substitutePlaceholders", () => {
  it("replaces every declared token", () => {
    assert.equal(
      substitutePlaceholders("app-{version}-{arch}.deb", { version: "1.2.3", arch: "amd64" }),
      "app-1.2.3-amd64.deb",
    );
  });

  it("leaves an undeclared token untouched", () => {
    assert.equal(
      substitutePlaceholders("app-{version}-{arch}.deb", { version: "1.2.3" }),
      "app-1.2.3-{arch}.deb",
    );
  });

  it("treats a value as a literal, never a pattern", () => {
    assert.equal(
      substitutePlaceholders("app-{version}.deb", { version: "$1{arch}" }),
      "app-$1{arch}.deb",
    );
  });

  it("does not rescan a substituted value", () => {
    assert.equal(substitutePlaceholders("{version}", { version: "{arch}", arch: "amd64" }), "{arch}");
    assert.equal(
      substitutePlaceholders("{version}", { arch: "amd64", version: "{arch}" }),
      "{arch}",
    );
  });
});
