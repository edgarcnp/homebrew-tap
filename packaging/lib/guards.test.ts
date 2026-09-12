import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  GITHUB_ASSET_HOSTS,
  assertHttpsUrl,
  assertInside,
  assertMatches,
  assertPositiveSize,
  assertSameLength,
  assertSha256Hex,
  assertSingleLine,
} from "./guards.ts";
import { assertMetadata, METADATA_KEYS, metadataUrl, readMetadataField, writeMetadata } from "./metadata.ts";
import type { Metadata } from "./types.ts";

function validMetadata(): Metadata {
  return {
    package: "code",
    version: "1.137.0",
    packageVersion: "1.137.0-1786487972",
    architecture: "amd64",
    repositoryPath: "pool/main/c/code/code_1.137.0-1786487972_amd64.deb",
    sha256: "a".repeat(64),
    size: 1234,
    depends: "libc6 (>= 2.17)",
    repository: "https://packages.microsoft.com/repos/code",
    path: "/tmp/code.deb",
  };
}

describe("guards", () => {
  it("rejects newlines and NUL bytes", () => {
    assert.equal(assertSingleLine("ok", "value"), "ok");
    assert.throws(() => assertSingleLine("bad\nnext", "value"), /newlines or NUL/);
    assert.throws(() => assertSingleLine("bad\u0000", "value"), /newlines or NUL/);
  });

  it("requires https URLs without query or fragment", () => {
    assert.equal(assertHttpsUrl("https://example.com/x", "url").hostname, "example.com");
    assert.throws(() => assertHttpsUrl("http://example.com/x", "url"), /must be https/);
    assert.throws(() => assertHttpsUrl("https://example.com/x?y=1", "url"), /query or fragment/);
    assert.throws(() => assertHttpsUrl("https://example.com/x#y", "url"), /query or fragment/);
    assert.throws(() => assertHttpsUrl("not a url", "url"), /Invalid url/);
  });

  it("contains paths", () => {
    const parent = "/tmp/output";
    assert.equal(assertInside("/tmp/output/meta.json", parent, "metadataPath"), "/tmp/output/meta.json");
    assert.throws(() => assertInside("/tmp/output/../../etc/passwd", parent, "metadataPath"), /must be inside/);
    assert.throws(() => assertInside("/etc/passwd", parent, "metadataPath"), /must be inside/);
  });

  it("enforces the ELF same-length invariant", () => {
    assertSameLength("abc", "xyz", "patch");
    assert.throws(() => assertSameLength("abc", "xy", "patch"), /length mismatch/);
  });

  it("shares one GitHub asset host list", () => {
    assert.ok(GITHUB_ASSET_HOSTS.includes("github-releases.githubusercontent.com"));
    assert.ok(GITHUB_ASSET_HOSTS.includes("release-assets.githubusercontent.com"));
  });

  it("validates sizes and digests", () => {
    assert.equal(assertPositiveSize(10, 100, "size"), 10);
    assert.throws(() => assertPositiveSize(0, 100, "size"), /not a sane byte count/);
    assert.throws(() => assertPositiveSize(101, 100, "size"), /not a sane byte count/);
    assert.throws(() => assertPositiveSize(1.5, 100, "size"), /not a sane byte count/);
    assert.equal(assertSha256Hex("A".repeat(64).toLowerCase(), "sha256"), "a".repeat(64));
    assert.throws(() => assertSha256Hex("abc", "sha256"), /Invalid sha256/);
    assert.equal(assertMatches("v1.2.3", /^v\d/, "tag"), "v1.2.3");
  });
});

describe("metadata", () => {
  it("accepts a well-formed document and derives its URL", () => {
    const metadata = assertMetadata(validMetadata());
    assert.equal(
      metadataUrl(metadata),
      "https://packages.microsoft.com/repos/code/pool/main/c/code/code_1.137.0-1786487972_amd64.deb",
    );
  });

  it("rejects unsafe or malformed documents", () => {
    assert.throws(() => assertMetadata({ ...validMetadata(), architecture: "sparc" }), /architecture/);
    assert.throws(() => assertMetadata({ ...validMetadata(), sha256: "nope" }), /sha256/);
    assert.throws(() => assertMetadata({ ...validMetadata(), size: -1 }), /byte count/);
    assert.throws(
      () => assertMetadata({ ...validMetadata(), repositoryPath: "../../etc/passwd" }),
      /Unsafe metadata.repositoryPath/,
    );
    assert.throws(
      () => assertMetadata({ ...validMetadata(), repository: "http://example.com" }),
      /must be https/,
    );
    assert.throws(() => assertMetadata({ ...validMetadata(), version: "v1" }), /Invalid metadata.version/);
    assert.throws(() => assertMetadata("not an object"), /not an object/);
  });

  it("round-trips through disk and reads named fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-metadata-"));
    try {
      const file = path.join(dir, "metadata.json");
      writeMetadata(file, validMetadata());
      assert.equal(readMetadataField(file, "version"), "1.137.0");
      assert.equal(readMetadataField(file, "sha256"), "a".repeat(64));
      assert.match(readMetadataField(file, "url"), /code_1\.137\.0-1786487972_amd64\.deb$/);
      assert.equal(readMetadataField(file, "path"), "/tmp/code.deb");
      assert.throws(() => readMetadataField(file, "nope"), /Unknown metadata field/);
      assert.deepEqual(METADATA_KEYS.includes("size"), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
