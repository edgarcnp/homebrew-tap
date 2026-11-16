import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  isAppImageAsset,
  payloadExtension,
  resolveWithGithubRelease,
  selectRelease,
  updateYmlName,
} from "../../lib/advisories/github-release.ts";
import { assertRepositoryUrl, fetchReleaseList } from "../../lib/advisories/github-api.ts";
import { resolveWithJsonAsset, selectJsonAsset } from "../../lib/advisories/json-asset.ts";
import {
  resolveWithMozillaRelease,
  verifyDetachedSignature,
  verifySigningKey,
} from "../../lib/advisories/mozilla-release.ts";
import { normalizeTagVersion, parseSha256Digest } from "../../lib/advisories/release-common.ts";
import { parseUpdateYml } from "../../lib/advisories/update-yml.ts";
import {
  fetchManifest,
  resolveWithUpdateManifest,
  selectManifestAsset,
  validateManifestEndpoint,
} from "../../lib/advisories/update-manifest.ts";
import { GuardViolationError, NotReadyError } from "../../lib/core/errors.ts";
import { REPO_ROOT } from "../../lib/core/paths.ts";
import type { JsonAssetArtifact, MozillaReleaseArtifact } from "../../lib/core/types.ts";

const SHA512 = "A".repeat(86) + "==";
const OPENCODE_HOSTS = ["opencode.ai"];
const FIXTURE_DIR = path.join(REPO_ROOT, "packaging", "tests", "fixtures", "signature");
const FIXTURE_FINGERPRINT = "36041EC6C8BCF1CC11EC50DC1A109BC1DB4F9184";

function isNotReady(expected: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof NotReadyError, `expected NotReadyError, got ${String(error)}`);
    assert.match(error.message, expected);
    return true;
  };
}

function jsonResponse(body: unknown, url: string, status = 200): Response {
  const response = new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status },
  );
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function bytesResponse(bytes: Buffer, url: string, status = 200): Response {
  const response = new Response(bytes, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("github-release artifact", () => {
  it("accepts only the api.github.com repository shape", () => {
    assert.equal(
      assertRepositoryUrl("https://api.github.com/repos/anomalyco/opencode/"),
      "https://api.github.com/repos/anomalyco/opencode",
    );
    assert.throws(() => assertRepositoryUrl("https://github.com/a/b"), /Unsafe GitHub API repository/);
    assert.throws(() => assertRepositoryUrl("https://api.github.com/repos/a"), /Unsafe GitHub API repository/);
  });

  it("normalizes tags and digests", () => {
    assert.equal(normalizeTagVersion("v1.18.30"), "1.18.30");
    assert.throws(() => normalizeTagVersion("v../etc"), /release tag version/);
    assert.equal(parseSha256Digest(`sha256:${"A".repeat(64)}`), "a".repeat(64));
    assert.throws(() => parseSha256Digest("md5:abc"), /not a sha256 digest/);
  });

  it("recognizes payload containers and names the per-arch update yml", () => {
    assert.equal(isAppImageAsset("WFHelper-2.1.0.AppImage"), true);
    assert.equal(isAppImageAsset("opencode-desktop-linux-amd64.deb"), false);
    assert.equal(updateYmlName("amd64"), "latest-linux.yml");
    assert.equal(updateYmlName("arm64"), "latest-linux-arm64.yml");
    assert.equal(payloadExtension("zed-linux-x86_64.tar.gz"), ".tar.gz");
    assert.equal(payloadExtension("firefox-160.0.tar.xz"), ".tar.xz");
    assert.equal(payloadExtension("pi-desktop_1.0.0_amd64.deb"), ".deb");
    assert.equal(payloadExtension("WFHelper-2.1.0.AppImage"), ".AppImage");
    assert.throws(
      () => payloadExtension("zed-linux-x86_64.zip"),
      /not a \.deb, \.AppImage or tarball payload/,
    );
  });

  it("selects exactly the requested version, not the newest release", async () => {
    const originalFetch = globalThis.fetch;
    const assets = (digest: string, size: number): unknown[] => [
      { name: "zed-linux-x86_64.tar.gz", digest: `sha256:${digest}`, size },
    ];
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { tag_name: "v1.29.1-pre", draft: false, prerelease: true, assets: assets("b".repeat(64), 90) },
          { tag_name: "v1.28.1", draft: false, prerelease: false, assets: assets("a".repeat(64), 90705601) },
          { tag_name: "v1.27.0", draft: false, prerelease: false, assets: assets("c".repeat(64), 90705601) },
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const selected = await selectRelease(
        "https://api.github.com/repos/zed-industries/zed",
        "zed-linux-{appimage_arch}.tar.gz",
        "v",
        "1.27.0",
        "amd64",
        "",
      );
      assert.equal(selected.tag, "v1.27.0");
      assert.equal(selected.version, "1.27.0");
      assert.equal(selected.asset.name, "zed-linux-x86_64.tar.gz");
      assert.equal(selected.asset.digest, "c".repeat(64));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("is not-ready when the requested tag or its asset is absent", async () => {
    const originalFetch = globalThis.fetch;
    const release = (assets: unknown[]) =>
      new Response(
        JSON.stringify([
          { tag_name: "v1.28.1", draft: false, prerelease: false, assets },
        ]),
        { status: 200 },
      );
    try {
      globalThis.fetch = (async () => release([])) as unknown as typeof fetch;
      await assert.rejects(
        selectRelease(
          "https://api.github.com/repos/zed-industries/zed",
          "zed-linux-{appimage_arch}.tar.gz",
          "v",
          "1.29.0",
          "amd64",
          "",
        ),
        isNotReady(/no published release carries v1\.29\.0/),
      );

      globalThis.fetch = (async () =>
        release([
          {
            name: "zed-linux-x86_64.tar.gz",
            digest: "no-digest",
            size: 10,
          },
        ])) as unknown as typeof fetch;
      await assert.rejects(
        selectRelease(
          "https://api.github.com/repos/zed-industries/zed",
          "zed-linux-{appimage_arch}.tar.gz",
          "v",
          "1.28.1",
          "amd64",
          "",
        ),
        isNotReady(/has no zed-linux-x86_64\.tar\.gz with a SHA-256 digest/),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports not-ready from the resolver instead of throwing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-github-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    try {
      const outcome = await resolveWithGithubRelease(
        {
          kind: "github-release",
          repository: "https://api.github.com/repos/zed-industries/zed",
          packageName: "zed",
          tagPrefix: "v",
          assetNameTemplate: "zed-linux-{appimage_arch}.tar.gz",
        },
        {
          architecture: "amd64",
          requestedVersion: "9.9.9",
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

  it("parses the electron-builder update yml", () => {
    const body = [
      "version: 0.0.109",
      "files:",
      "  - url: Freebuff-0.0.109-linux-x86_64.AppImage",
      `    sha512: ${SHA512}`,
      "    size: 1234567",
      "path: Freebuff-0.0.109-linux-x86_64.AppImage",
      `sha512: ${SHA512}`,
      "releaseDate: '2026-09-12T00:00:00.000Z'",
      "",
    ].join("\n");
    const parsed = parseUpdateYml(body, "0.0.109", "Freebuff-0.0.109-linux-x86_64.AppImage");
    assert.deepEqual(parsed, { sha512: SHA512, size: 1234567 });

    assert.throws(
      () => parseUpdateYml(body, "0.0.110", "Freebuff-0.0.109-linux-x86_64.AppImage"),
      /does not match tag version/,
    );
    assert.throws(
      () => parseUpdateYml(body, "0.0.109", "Other.AppImage"),
      /does not match expected/,
    );
    assert.throws(
      () => parseUpdateYml(body.replace("size: 1234567", "size: 0"), "0.0.109", "Freebuff-0.0.109-linux-x86_64.AppImage"),
      /not a sane byte count/,
    );
    assert.throws(() => parseUpdateYml("version: 1.0.0\n", "1.0.0", "x"), /missing path/);
  });

  it("walks past the first release page", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    const page = (count: number): unknown[] =>
      Array.from({ length: count }, (_entry, index) => ({
        tag_name: `t${index}`,
        draft: false,
        prerelease: false,
        assets: [],
      }));
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return new Response(
        JSON.stringify(url.includes("page=2") ? page(2) : page(100)),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const releases = await fetchReleaseList("https://api.github.com/repos/o/r", "");
      assert.equal(releases.length, 102);
      assert.match(urls[1] ?? "", /page=2/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function manifestFor(version = "2.0.8"): Record<string, unknown> {
  const entry = (name: string, sha256: string, size: number) => ({
    url: `https://opencode.ai/files/bin/${version}/${name}`,
    sha256,
    size,
  });
  return {
    channel: "latest",
    name: "desktop",
    distribution: "opencode",
    version,
    metadata: {
      files: {
        "opencode-desktop-linux-amd64.deb": entry(
          "opencode-desktop-linux-amd64.deb",
          "a".repeat(64),
          1000,
        ),
        "opencode-desktop-linux-arm64.deb": entry(
          "opencode-desktop-linux-arm64.deb",
          "b".repeat(64),
          2000,
        ),
      },
    },
  };
}

function manifestEntry(m: Record<string, unknown>): Record<string, unknown> {
  const metadata = m["metadata"] as Record<string, unknown>;
  const files = metadata["files"] as Record<string, Record<string, unknown>>;
  return files["opencode-desktop-linux-amd64.deb"]!;
}

function mutatedEntry(mutate: (entry: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = structuredClone(manifestFor());
  mutate(manifestEntry(copy));
  return copy;
}

describe("update-manifest artifact", () => {
  it("selects the requested asset from a valid manifest", () => {
    const selected = selectManifestAsset(
      manifestFor(),
      "opencode-desktop-linux-arm64.deb",
      OPENCODE_HOSTS,
      "2.0.8",
    );
    assert.equal(selected.version, "2.0.8");
    assert.equal(selected.repository, "https://opencode.ai");
    assert.equal(selected.repositoryPath, "files/bin/2.0.8/opencode-desktop-linux-arm64.deb");
    assert.deepEqual(selected.asset, {
      url: "https://opencode.ai/files/bin/2.0.8/opencode-desktop-linux-arm64.deb",
      sha256: "b".repeat(64),
      size: 2000,
    });
  });

  it("is not-ready when the manifest publishes another version", () => {
    assert.throws(
      () =>
        selectManifestAsset(
          manifestFor(),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.9",
        ),
      isNotReady(/update manifest publishes 2\.0\.8; requested 2\.0\.9/),
    );
  });

  it("is not-ready for a missing asset, url, digest or size", () => {
    assert.throws(
      () => selectManifestAsset(manifestFor(), "nope.deb", OPENCODE_HOSTS, "2.0.8"),
      isNotReady(/has no entry for nope\.deb/),
    );
    assert.throws(
      () =>
        selectManifestAsset(
          mutatedEntry((entry) => {
            entry["url"] = "";
          }),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      isNotReady(/has no url/),
    );
    assert.throws(
      () =>
        selectManifestAsset(
          mutatedEntry((entry) => {
            entry["sha256"] = "";
          }),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      isNotReady(/has no sha256/),
    );
    assert.throws(
      () =>
        selectManifestAsset(
          mutatedEntry((entry) => {
            delete entry["size"];
          }),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      isNotReady(/has no size/),
    );
  });

  it("rejects a non-object, version-less or badly versioned manifest", () => {
    assert.throws(() => selectManifestAsset("nope", "a", OPENCODE_HOSTS, "2.0.8"), /not an object/);
    assert.throws(() => selectManifestAsset([], "a", OPENCODE_HOSTS, "2.0.8"), /not an object/);
    assert.throws(
      () => selectManifestAsset({ ...manifestFor(), version: 2 }, "a", OPENCODE_HOSTS, "2.0.8"),
      /no sane version/,
    );
    assert.throws(
      () => selectManifestAsset({ ...manifestFor(), version: "/etc" }, "a", OPENCODE_HOSTS, "/etc"),
      /no sane version/,
    );
  });

  it("rejects a manifest without a metadata object or a files map", () => {
    assert.throws(
      () => selectManifestAsset({ version: "2.0.8" }, "a", OPENCODE_HOSTS, "2.0.8"),
      /no metadata object/,
    );
    assert.throws(
      () =>
        selectManifestAsset(
          { version: "2.0.8", metadata: { files: [] } },
          "a",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      /no metadata\.files map/,
    );
  });

  it("rejects unsafe, off-host or versionless asset urls", () => {
    const withUrl = (url: string) =>
      mutatedEntry((entry) => {
        entry["url"] = url;
      });
    assert.throws(
      () =>
        selectManifestAsset(
          withUrl("http://opencode.ai/files/bin/2.0.8/x.deb"),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      /must be https/,
    );
    assert.throws(
      () =>
        selectManifestAsset(
          withUrl("https://opencode.ai/files/bin/2.0.8/x.deb?foo=1"),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      /must not contain a query or fragment/,
    );
    assert.throws(
      () =>
        selectManifestAsset(
          withUrl("https://evil.example.com/files/bin/2.0.8/x.deb"),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      /Unexpected update manifest asset host/,
    );
    assert.throws(
      () =>
        selectManifestAsset(
          withUrl("https://opencode.ai/files/bin/2.0.9/x.deb"),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      /does not carry version 2\.0\.8/,
    );
  });

  it("rejects a bad digest and unsane sizes", () => {
    assert.throws(
      () =>
        selectManifestAsset(
          mutatedEntry((entry) => {
            entry["sha256"] = "zzz";
          }),
          "opencode-desktop-linux-amd64.deb",
          OPENCODE_HOSTS,
          "2.0.8",
        ),
      /sha256/,
    );
    for (const size of [0, -1, 1.5]) {
      assert.throws(
        () =>
          selectManifestAsset(
            mutatedEntry((entry) => {
              entry["size"] = size;
            }),
            "opencode-desktop-linux-amd64.deb",
            OPENCODE_HOSTS,
            "2.0.8",
          ),
        /not a sane byte count/,
      );
    }
  });

  it("reports not-ready from the resolver when the manifest is behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-manifest-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(
        manifestFor("2.0.8"),
        "https://opencode.ai/update/api/latest/desktop/opencode",
      )) as unknown as typeof fetch;
    try {
      const outcome = await resolveWithUpdateManifest(
        {
          kind: "update-manifest",
          repository: "https://opencode.ai/update/api/latest/desktop/opencode",
          packageName: "opencode-desktop",
          assetTemplate: "opencode-desktop-linux-{arch}.deb",
          downloadHosts: OPENCODE_HOSTS,
        },
        {
          architecture: "amd64",
          requestedVersion: "2.0.9",
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

  it("normalizes the manifest endpoint and rejects unsafe ones", () => {
    assert.equal(
      validateManifestEndpoint("https://opencode.ai/update/api/latest/desktop/opencode/"),
      "https://opencode.ai/update/api/latest/desktop/opencode",
    );
    assert.throws(() => validateManifestEndpoint("http://opencode.ai/x"), /must be https/);
    assert.throws(() => validateManifestEndpoint("https://opencode.ai/x?y=1"), /query or fragment/);
    assert.throws(() => validateManifestEndpoint("not a url"), /Invalid update manifest endpoint/);
  });

  it("rejects a manifest redirect that leaves the pinned host", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const response = new Response('{"version":"1.0.0"}', { status: 200 });
      Object.defineProperty(response, "url", { value: "https://evil.example/manifest.json" });
      return response;
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(fetchManifest("https://good.example/manifest.json"), (error: unknown) => {
        assert.ok(error instanceof GuardViolationError);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const JSON_ASSET: JsonAssetArtifact = {
  kind: "json-asset",
  url: "https://update.example/api/linux-x64/stable/latest",
  downloadHosts: ["update.example", "download.example"],
  urlField: "url",
  sha256Field: "sha256hash",
  versionField: "productVersion",
  packageName: "code",
};

function jsonDocument(version = "1.146.0"): Record<string, unknown> {
  return {
    productVersion: version,
    url: "https://download.example/stable/1.146.0/code-stable-x64.tar.gz",
    sha256hash: "a".repeat(64),
  };
}

describe("json-asset artifact", () => {
  it("binds the document to the requested version", () => {
    assert.deepEqual(selectJsonAsset(jsonDocument(), JSON_ASSET, "1.146.0"), {
      version: "1.146.0",
      url: "https://download.example/stable/1.146.0/code-stable-x64.tar.gz",
      sha256: "a".repeat(64),
    });
    assert.throws(
      () => selectJsonAsset(jsonDocument(), JSON_ASSET, "1.147.0"),
      isNotReady(/update document publishes 1\.146\.0; requested 1\.147\.0/),
    );
  });

  it("is not-ready without a version, url or digest, and rejects a bad digest", () => {
    for (const field of ["productVersion", "url", "sha256hash"]) {
      const body = jsonDocument();
      delete body[field];
      assert.throws(
        () => selectJsonAsset(body, JSON_ASSET, "1.146.0"),
        isNotReady(new RegExp(`has no ${field}`)),
      );
    }
    assert.throws(
      () =>
        selectJsonAsset(
          { ...jsonDocument(), sha256hash: "not-a-digest" },
          JSON_ASSET,
          "1.146.0",
        ),
      /sha256hash/,
    );
    assert.throws(() => selectJsonAsset("nope", JSON_ASSET, "1.146.0"), /not an object/);
  });

  it("downloads, verifies and measures the declared asset", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-json-asset-"));
    const payload = Buffer.from("vscode tarball bytes");
    const digest = createHash("sha256").update(payload).digest("hex");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url === JSON_ASSET.url) {
        return jsonResponse({ ...jsonDocument(), sha256hash: digest }, url);
      }
      return bytesResponse(payload, url);
    }) as unknown as typeof fetch;
    try {
      const outcome = await resolveWithJsonAsset(JSON_ASSET, {
        architecture: "amd64",
        requestedVersion: "1.146.0",
        outputDir: dir,
        metadataPath: path.join(dir, "metadata.json"),
        metadataOnly: false,
        token: "",
      });
      assert.equal(outcome.status, "ready");
      if (outcome.status !== "ready") return;
      assert.equal(outcome.metadata.version, "1.146.0");
      assert.equal(outcome.metadata.sha256, digest);
      assert.equal(outcome.metadata.size, payload.length);
      assert.ok(outcome.metadata.path !== null);
      assert.deepEqual(fs.readFileSync(outcome.metadata.path), payload);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns not-ready when the document publishes another version", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-json-asset-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) =>
      jsonResponse(jsonDocument("1.145.0"), String(input))) as unknown as typeof fetch;
    try {
      const outcome = await resolveWithJsonAsset(JSON_ASSET, {
        architecture: "amd64",
        requestedVersion: "1.146.0",
        outputDir: dir,
        metadataPath: path.join(dir, "metadata.json"),
        metadataOnly: true,
        token: "",
      });
      assert.equal(outcome.status, "not-ready");
      if (outcome.status !== "not-ready") return;
      assert.match(outcome.detail, /publishes 1\.145\.0; requested 1\.146\.0/);
      assert.equal(fs.existsSync(path.join(dir, "metadata.json")), false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const MOZILLA_FIXTURE: MozillaReleaseArtifact = {
  kind: "mozilla-release",
  urlTemplate: "https://ftp.mozilla.org/firefox/{version}/payload.txt",
  signatureTemplate: "{url}.asc",
  packageName: "firefox",
  fingerprint: FIXTURE_FINGERPRINT,
  keyPath: "packaging/tests/fixtures/signature/release-key.asc",
};

describe("mozilla-release artifact", () => {
  it("pins the committed Mozilla release key", () => {
    const keyPath = path.join(REPO_ROOT, "packaging/apps/firefox/assets/mozilla-release-key.asc");
    assert.doesNotThrow(() =>
      verifySigningKey(keyPath, "14F26682D0916CDD81E37B6D61B7B526D98F0353"),
    );
    assert.throws(
      () => verifySigningKey(keyPath, "0".repeat(40)),
      /does not contain expected fingerprint/,
    );
  });

  it("verifies a detached signature and rejects tampered bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-signature-"));
    const payload = path.join(dir, "payload.bin");
    const tampered = path.join(dir, "tampered.bin");
    fs.writeFileSync(payload, fs.readFileSync(path.join(FIXTURE_DIR, "payload.txt")));
    fs.writeFileSync(tampered, "tampered\n");
    try {
      assert.doesNotThrow(() =>
        verifyDetachedSignature(
          payload,
          path.join(FIXTURE_DIR, "payload.txt.asc"),
          path.join(FIXTURE_DIR, "release-key.asc"),
          FIXTURE_FINGERPRINT,
          dir,
        ),
      );
      assert.throws(
        () =>
          verifyDetachedSignature(
            tampered,
            path.join(FIXTURE_DIR, "payload.txt.asc"),
            path.join(FIXTURE_DIR, "release-key.asc"),
            FIXTURE_FINGERPRINT,
            dir,
          ),
        /signature verification failed/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads, verifies and hashes the signed release tarball", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-mozilla-"));
    const payload = fs.readFileSync(path.join(FIXTURE_DIR, "payload.txt"));
    const signature = fs.readFileSync(path.join(FIXTURE_DIR, "payload.txt.asc"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      return url.endsWith(".asc")
        ? bytesResponse(signature, url)
        : bytesResponse(payload, url);
    }) as unknown as typeof fetch;
    try {
      const outcome = await resolveWithMozillaRelease(MOZILLA_FIXTURE, {
        architecture: "amd64",
        requestedVersion: "160.0",
        outputDir: dir,
        metadataPath: path.join(dir, "metadata.json"),
        metadataOnly: true,
        token: "",
      });
      assert.equal(outcome.status, "ready");
      if (outcome.status !== "ready") return;
      assert.equal(outcome.metadata.version, "160.0");
      assert.equal(outcome.metadata.size, payload.length);
      assert.equal(outcome.metadata.path, null);
      assert.equal(
        outcome.metadata.repositoryPath,
        "firefox/160.0/payload.txt",
      );
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not-ready for a missing signature or a failed verification", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-mozilla-"));
    const payload = fs.readFileSync(path.join(FIXTURE_DIR, "payload.txt"));
    const signature = fs.readFileSync(path.join(FIXTURE_DIR, "payload.txt.asc"));
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith(".asc")) return jsonResponse("not found", url, 404);
        return bytesResponse(payload, url);
      }) as unknown as typeof fetch;
      const missing = await resolveWithMozillaRelease(MOZILLA_FIXTURE, {
        architecture: "amd64",
        requestedVersion: "160.0",
        outputDir: dir,
        metadataPath: path.join(dir, "metadata.json"),
        metadataOnly: true,
        token: "",
      });
      assert.equal(missing.status, "not-ready");

      globalThis.fetch = (async (input: string | URL) => {
        const url = String(input);
        return url.endsWith(".asc")
          ? bytesResponse(signature, url)
          : jsonResponse("tampered\n", url);
      }) as unknown as typeof fetch;
      const failed = await resolveWithMozillaRelease(MOZILLA_FIXTURE, {
        architecture: "amd64",
        requestedVersion: "160.0",
        outputDir: dir,
        metadataPath: path.join(dir, "metadata.json"),
        metadataOnly: true,
        token: "",
      });
      assert.equal(failed.status, "not-ready");
      if (failed.status === "not-ready") {
        assert.match(failed.detail, /signature verification failed/);
      }
      assert.equal(fs.existsSync(path.join(dir, "metadata.json")), false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
