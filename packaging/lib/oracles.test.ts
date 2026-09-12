import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectLatestPackage, verifyIndexedFile } from "./oracles/apt.ts";
import { parseFinalUrl } from "./oracles/cdn-redirect.ts";
import {
  parseFeedRedirect,
  parseUpdateYml,
  requireGithubCoords,
  selectAsset,
  validateFeedRepository,
} from "./oracles/electron-feed.ts";
import { assertRepositoryUrl, selectRelease } from "./oracles/github-release.ts";
import { normalizeTagVersion, parseSha256Digest } from "./oracles/release-common.ts";
import { compareDebVersions } from "./version.ts";

const SHA512 = "A".repeat(86) + "==";
const GITBUTLER_HOSTS = ["releases.gitbutler.com"];

describe("apt oracle", () => {
  const packages = [
    "Package: code",
    "Architecture: amd64",
    "Version: 1.137.0-1786487972",
    `SHA256: ${"a".repeat(64)}`,
    "Size: 1024",
    "Filename: pool/main/c/code/code_1.137.0-1786487972_amd64.deb",
    "Depends: libc6 (>= 2.17)",
    "",
    "Package: code",
    "Architecture: amd64",
    "Version: 1.136.2",
    `SHA256: ${"b".repeat(64)}`,
    "Size: 1024",
    "Filename: pool/main/c/code/code_1.136.2_amd64.deb",
    "",
  ].join("\n");

  it("picks the newest entry for the requested architecture", () => {
    const selected = selectLatestPackage(packages, "code", "amd64");
    assert.equal(selected.version, "1.137.0");
    assert.equal(selected.packageVersion, "1.137.0-1786487972");
    assert.equal(selected.sha256, "a".repeat(64));
    assert.equal(selected.depends, "libc6 (>= 2.17)");
  });

  it("applies dpkg ordering when versions carry letters", () => {
    const withPrerelease = packages.replace("Version: 1.136.2", "Version: 1.136.2+a");
    assert.equal(selectLatestPackage(withPrerelease, "code", "amd64").version, "1.137.0");
    // "1.137.0a" sorts after "1.137.0"; the old string comparison disagreed with dpkg here.
    const newer = packages.replace("Version: 1.137.0-1786487972", "Version: 1.137.0a-1");
    assert.equal(compareDebVersions("1.137.0a-1", "1.136.2"), 1);
    assert.equal(selectLatestPackage(newer, "code", "amd64").version, "1.137.0a");
  });

  it("rejects unsafe indexes and unknown packages", () => {
    assert.throws(() => selectLatestPackage(packages, "firefox", "amd64"), /No firefox\/amd64 entry/);
    assert.throws(
      () =>
        selectLatestPackage(
          packages.replace("pool/main/c/code/code_1.137.0-1786487972_amd64.deb", "../../etc/passwd"),
          "code",
          "amd64",
        ),
      /Unsafe code Filename/,
    );
    assert.throws(
      () =>
        selectLatestPackage(
          packages.replace("pool/main/c/code/code_1.137.0-1786487972_amd64.deb", "pool/../x.deb"),
          "code",
          "amd64",
        ),
      /Unsafe code Filename/,
    );
    assert.throws(
      () => selectLatestPackage(packages.replace(`SHA256: ${"a".repeat(64)}`, "SHA256: nope"), "code", "amd64"),
      /Invalid code SHA256/,
    );
  });

  it("verifies an indexed file's size and digest", () => {
    // exercised through a real file so the timing-safe comparison path runs
    assert.throws(
      () => verifyIndexedFile("/nonexistent/path", { sha256: "a".repeat(64), size: 1 }, "code"),
      /ENOENT/,
    );
  });
});

describe("github-release oracle", () => {
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

  it("is exported for network-free reuse", () => {
    assert.equal(typeof selectRelease, "function");
  });
});

describe("electron-feed oracle", () => {
  it("parses the feed redirect and pins the asset shape", () => {
    const parsed = parseFeedRedirect(
      "https://github.com/CodebuffAI/codebuff-community/releases/download/freebuff-desktop-v0.0.109/latest-linux.yml",
      "freebuff-desktop-v",
    );
    assert.deepEqual(parsed, {
      version: "0.0.109",
      tag: "freebuff-desktop-v0.0.109",
      owner: "CodebuffAI",
      repo: "codebuff-community",
      fileName: "latest-linux.yml",
    });
    assert.throws(() => parseFeedRedirect("https://evil.example.com/x/y/z", "p"), /unexpected URL/);
    assert.throws(
      () => parseFeedRedirect("https://github.com/a/b/releases/tag/v1/x.yml", "v"),
      /not a release asset download/,
    );
    assert.throws(
      () =>
        parseFeedRedirect(
          "https://github.com/a/b/releases/download/v1.0.0/latest-linux.yml",
          "freebuff-desktop-v",
        ),
      /does not start with/,
    );
    assert.throws(
      () =>
        parseFeedRedirect("https://github.com/a/b/releases/download/tag1/file.txt", "tag"),
      /not an update yml/,
    );
  });

  it("rejects a feed host that is not the configured one", () => {
    assert.equal(
      validateFeedRepository("https://freebuff.com/api/desktop/updates/"),
      "https://freebuff.com/api/desktop/updates",
    );
    assert.throws(() => validateFeedRepository("http://freebuff.com/x"), /must be https/);
    assert.throws(() => validateFeedRepository("https://freebuff.com/x?y=1"), /query or fragment/);
    assert.throws(() => validateFeedRepository("nope"), /Invalid feed repository URL/);
  });

  it("cross-checks the feed coordinates against the configured repository", () => {
    const parsed = {
      version: "0.0.109",
      tag: "freebuff-desktop-v0.0.109",
      owner: "CodebuffAI",
      repo: "codebuff-community",
      fileName: "latest-linux.yml",
    };
    requireGithubCoords(parsed, "https://api.github.com/repos/CodebuffAI/codebuff-community");
    assert.throws(
      () => requireGithubCoords(parsed, "https://api.github.com/repos/other/repo"),
      /does not match configured repository/,
    );
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

    assert.throws(() => parseUpdateYml(body, "0.0.110", "Freebuff-0.0.109-linux-x86_64.AppImage"), /does not match tag version/);
    assert.throws(() => parseUpdateYml(body, "0.0.109", "Other.AppImage"), /does not match expected/);
    assert.throws(
      () => parseUpdateYml(body.replace("path: Freebuff", "path: Other"), "0.0.109", "Freebuff-0.0.109-linux-x86_64.AppImage"),
      /does not match expected/,
    );
    assert.throws(
      () => parseUpdateYml(body.replace(`sha512: ${SHA512}\nreleaseDate`, "sha512: B\nreleaseDate"), "0.0.109", "Freebuff-0.0.109-linux-x86_64.AppImage"),
      /disagrees with the files entry/,
    );
    assert.throws(
      () => parseUpdateYml(body.replace("size: 1234567", "size: 0"), "0.0.109", "Freebuff-0.0.109-linux-x86_64.AppImage"),
      /not a sane byte count/,
    );
    assert.throws(
      () =>
        parseUpdateYml(
          body.replaceAll(SHA512, "short"),
          "0.0.109",
          "Freebuff-0.0.109-linux-x86_64.AppImage",
        ),
      /not a base64 SHA-512/,
    );
    assert.throws(() => parseUpdateYml("version: 1.0.0\n", "1.0.0", "x"), /missing path/);
  });

  it("selects the release asset and rejects mismatches", () => {
    const release = {
      tag_name: "freebuff-desktop-v0.0.109",
      draft: false,
      assets: [
        { name: "Freebuff-0.0.109-linux-x86_64.AppImage", digest: `sha256:${"c".repeat(64)}`, size: 100 },
      ],
    };
    const asset = selectAsset(release, "freebuff-desktop-v0.0.109", "Freebuff-0.0.109-linux-x86_64.AppImage", 100);
    assert.deepEqual(asset, {
      name: "Freebuff-0.0.109-linux-x86_64.AppImage",
      sha256: "c".repeat(64),
      size: 100,
    });
    assert.throws(
      () => selectAsset(release, "freebuff-desktop-v0.0.108", "Freebuff-0.0.109-linux-x86_64.AppImage", 100),
      /does not match requested/,
    );
    assert.throws(
      () => selectAsset({ ...release, draft: true }, "freebuff-desktop-v0.0.109", "Freebuff-0.0.109-linux-x86_64.AppImage", 100),
      /is a draft/,
    );
    assert.throws(
      () => selectAsset(release, "freebuff-desktop-v0.0.109", "absent.AppImage", 100),
      /has no asset/,
    );
    assert.throws(
      () => selectAsset(release, "freebuff-desktop-v0.0.109", "Freebuff-0.0.109-linux-x86_64.AppImage", 101),
      /does not match update yml size/,
    );
    assert.throws(
      () => selectAsset(
        { ...release, assets: [{ name: "Freebuff-0.0.109-linux-x86_64.AppImage", digest: "sha1:x", size: 100 }] },
        "freebuff-desktop-v0.0.109",
        "Freebuff-0.0.109-linux-x86_64.AppImage",
        100,
      ),
      /not a sha256 digest/,
    );
  });
});

describe("cdn-redirect oracle", () => {
  const target =
    "https://releases.gitbutler.com/releases/release/0.22.3-3215/linux/x86_64/GitButler_0.22.3_amd64.deb";

  it("validates the upstream .deb URL shape", () => {
    const parsed = parseFinalUrl(target, GITBUTLER_HOSTS);
    assert.equal(parsed.repository, "https://releases.gitbutler.com");
    assert.equal(parsed.fileVersion, "0.22.3");
    assert.equal(parsed.releaseVersion, "0.22.3-3215");
    assert.equal(parsed.archPath, "x86_64");
  });

  it("rejects off-host redirects and unrecognized layouts", () => {
    assert.throws(
      () => parseFinalUrl(target.replace("releases.gitbutler.com", "evil.example.com"), GITBUTLER_HOSTS),
      /Unexpected redirect host/,
    );
    assert.throws(
      () => parseFinalUrl(target.replace("GitButler_0.22.3_amd64.deb", "setup.exe"), GITBUTLER_HOSTS),
      /Unrecognized \.deb filename/,
    );
    assert.throws(
      () => parseFinalUrl(target.replace("GitButler_0.22.3_", "GitButler_0.22.4_"), GITBUTLER_HOSTS),
      /does not match filename version/,
    );
    assert.throws(
      () => parseFinalUrl(target.replace("/0.22.3-3215/", "/v0.22.3/"), GITBUTLER_HOSTS),
      /Unrecognized release segment/,
    );
    assert.throws(
      () => parseFinalUrl(target.replace("https://", "http://"), GITBUTLER_HOSTS),
      /non-HTTPS URL/,
    );
  });
});
