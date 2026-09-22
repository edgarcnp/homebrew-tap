import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectAvakotAsset } from "../../../lib/oracles/custom/avakot.ts";

describe("avakot oracle", () => {
  // Mirrors the live Little Genius manifest: the .deb URL never changes and
  // no size is published, so the version binds through the per-entry field.
  const avakotFor = (version = "0.6.7"): Record<string, unknown> => ({
    version,
    artifacts: {
      linux_x86_64_deb: {
        version,
        url: "https://api.avakot.org/lg/download/deb",
        sha256: "c".repeat(64),
      },
    },
  });
  const AVAKOT_HOSTS = ["api.avakot.org"];

  function entryOf(manifest: Record<string, unknown>): Record<string, unknown> {
    const artifacts = manifest["artifacts"] as Record<string, Record<string, unknown>>;
    return artifacts["linux_x86_64_deb"]!;
  }

  it("selects the fixed artifact and leaves the size unmeasured", () => {
    const selected = selectAvakotAsset(avakotFor(), "linux_x86_64_deb", AVAKOT_HOSTS);
    assert.equal(selected.version, "0.6.7");
    assert.equal(selected.repository, "https://api.avakot.org");
    assert.equal(selected.repositoryPath, "lg/download/deb");
    assert.equal(selected.asset.url, "https://api.avakot.org/lg/download/deb");
    assert.equal(selected.asset.sha256, "c".repeat(64));
    assert.equal(selected.asset.size, undefined);
  });

  it("rejects a non-object, version-less or artifact-less manifest", () => {
    assert.throws(() => selectAvakotAsset("nope", "a", AVAKOT_HOSTS), /not an object/);
    assert.throws(
      () => selectAvakotAsset({ ...avakotFor(), version: 2 }, "a", AVAKOT_HOSTS),
      /no sane version/,
    );
    assert.throws(
      () => selectAvakotAsset({ version: "0.6.7" }, "a", AVAKOT_HOSTS),
      /no artifacts map/,
    );
  });

  it("accepts the deb_sha256 digest alias", () => {
    const manifest = avakotFor();
    const entry = entryOf(manifest);
    delete entry["sha256"];
    entry["deb_sha256"] = "d".repeat(64);
    const selected = selectAvakotAsset(manifest, "linux_x86_64_deb", AVAKOT_HOSTS);
    assert.equal(selected.asset.sha256, "d".repeat(64));
  });

  it("rejects an entry version that does not match the manifest", () => {
    const manifest = avakotFor();
    entryOf(manifest)["version"] = "0.6.6";
    assert.throws(
      () => selectAvakotAsset(manifest, "linux_x86_64_deb", AVAKOT_HOSTS),
      /does not match 0\.6\.7/,
    );
  });

  it("rejects a missing entry, a missing digest and an off-host url", () => {
    assert.throws(
      () => selectAvakotAsset(avakotFor(), "linux_x86_64_appimage", AVAKOT_HOSTS),
      /no entry for linux_x86_64_appimage/,
    );
    const noDigest = avakotFor();
    delete entryOf(noDigest)["sha256"];
    assert.throws(
      () => selectAvakotAsset(noDigest, "linux_x86_64_deb", AVAKOT_HOSTS),
      /has no sha256/,
    );
    const offHost = avakotFor();
    entryOf(offHost)["url"] = "https://evil.example.com/lg/download/deb";
    assert.throws(
      () => selectAvakotAsset(offHost, "linux_x86_64_deb", AVAKOT_HOSTS),
      /Unexpected update manifest asset host/,
    );
  });
});
