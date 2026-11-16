import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  resolveWithAvakot,
  selectAvakotAsset,
} from "../../../lib/advisories/custom/avakot.ts";
import { NotReadyError } from "../../../lib/core/errors.ts";

describe("avakot artifact", () => {
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
  const REQUESTED = "0.6.7";

  function entryOf(manifest: Record<string, unknown>): Record<string, unknown> {
    const artifacts = manifest["artifacts"] as Record<string, Record<string, unknown>>;
    return artifacts["linux_x86_64_deb"]!;
  }

  it("selects the fixed artifact and leaves the size unmeasured", () => {
    const selected = selectAvakotAsset(
      avakotFor(),
      "linux_x86_64_deb",
      AVAKOT_HOSTS,
      REQUESTED,
    );
    assert.equal(selected.version, "0.6.7");
    assert.equal(selected.repository, "https://api.avakot.org");
    assert.equal(selected.repositoryPath, "lg/download/deb");
    assert.equal(selected.asset.url, "https://api.avakot.org/lg/download/deb");
    assert.equal(selected.asset.sha256, "c".repeat(64));
    assert.equal(selected.asset.size, undefined);
  });

  it("rejects a manifest for another version as not-ready", () => {
    assert.throws(
      () =>
        selectAvakotAsset(
          avakotFor("0.6.8"),
          "linux_x86_64_deb",
          AVAKOT_HOSTS,
          REQUESTED,
        ),
      (error: unknown) => {
        assert.ok(error instanceof NotReadyError);
        assert.match(error.message, /publishes 0\.6\.8; requested 0\.6\.7/);
        return true;
      },
    );
  });

  it("reports not-ready from the resolver when the manifest is behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-avakot-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const response = new Response(JSON.stringify(avakotFor("0.6.8")), { status: 200 });
      Object.defineProperty(response, "url", {
        value: "https://api.avakot.org/lg/manifest.json",
      });
      return response;
    }) as unknown as typeof fetch;
    try {
      const outcome = await resolveWithAvakot(
        {
          kind: "avakot",
          repository: "https://api.avakot.org/lg/manifest.json",
          packageName: "little-genius",
          assetTemplate: "linux_x86_64_deb",
          downloadHosts: AVAKOT_HOSTS,
        },
        {
          architecture: "amd64",
          requestedVersion: "0.6.7",
          outputDir: dir,
          metadataPath: path.join(dir, "metadata.json"),
          metadataOnly: true,
          token: "",
        },
      );
      assert.equal(outcome.status, "not-ready");
      assert.equal(fs.existsSync(path.join(dir, "metadata.json")), false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-object, version-less or artifact-less manifest", () => {
    assert.throws(
      () => selectAvakotAsset("nope", "a", AVAKOT_HOSTS, REQUESTED),
      /not an object/,
    );
    assert.throws(
      () => selectAvakotAsset({ ...avakotFor(), version: 2 }, "a", AVAKOT_HOSTS, REQUESTED),
      /no sane version/,
    );
    assert.throws(
      () => selectAvakotAsset({ version: "0.6.7" }, "a", AVAKOT_HOSTS, REQUESTED),
      /no artifacts map/,
    );
  });

  it("accepts the deb_sha256 digest alias", () => {
    const manifest = avakotFor();
    const entry = entryOf(manifest);
    delete entry["sha256"];
    entry["deb_sha256"] = "d".repeat(64);
    const selected = selectAvakotAsset(
      manifest,
      "linux_x86_64_deb",
      AVAKOT_HOSTS,
      REQUESTED,
    );
    assert.equal(selected.asset.sha256, "d".repeat(64));
  });

  it("rejects an entry version that does not match the manifest", () => {
    const manifest = avakotFor();
    entryOf(manifest)["version"] = "0.6.6";
    assert.throws(
      () => selectAvakotAsset(manifest, "linux_x86_64_deb", AVAKOT_HOSTS, REQUESTED),
      /does not match 0\.6\.7/,
    );
  });

  it("rejects a missing entry, a missing digest and an off-host url", () => {
    assert.throws(
      () => selectAvakotAsset(avakotFor(), "linux_x86_64_appimage", AVAKOT_HOSTS, REQUESTED),
      /no entry for linux_x86_64_appimage/,
    );
    const noDigest = avakotFor();
    delete entryOf(noDigest)["sha256"];
    assert.throws(
      () => selectAvakotAsset(noDigest, "linux_x86_64_deb", AVAKOT_HOSTS, REQUESTED),
      /has no sha256/,
    );
    const offHost = avakotFor();
    entryOf(offHost)["url"] = "https://evil.example.com/lg/download/deb";
    assert.throws(
      () => selectAvakotAsset(offHost, "linux_x86_64_deb", AVAKOT_HOSTS, REQUESTED),
      /Unexpected update manifest asset host/,
    );
  });
});
