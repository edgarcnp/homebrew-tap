#!/usr/bin/env node
"use strict";

// Shared resolver for GitHub release assets: release listing -> per-asset
// SHA-256 digest from the GitHub API -> download-time verification. Picks the
// newest non-draft, non-prerelease release that carries both --asset-prefix
// deb assets with sha256 digests. API access is anonymous unless GITHUB_TOKEN
// or GH_TOKEN is set.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEB_ARCHES = ["amd64", "arm64"];

function normalizeTagVersion(tag) {
  const version = String(tag).replace(/^v/, "");
  if (!/^[0-9][0-9A-Za-z.+~_-]*$/.test(version)) {
    throw new Error(`Invalid release tag version: ${tag}`);
  }
  return version;
}

function parseSha256Digest(digest) {
  const match = String(digest ?? "").match(/^sha256:([0-9a-f]{64})$/i);
  if (!match) throw new Error(`Release asset digest is not a sha256 digest: ${digest}`);
  return match[1].toLowerCase();
}

async function fetchJson(url, token) {
  const headers = { "User-Agent": "homebrew-tap-appimage-builder" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function selectRelease(repository, assetPrefix, token) {
  const releases = await fetchJson(`${repository}/releases?per_page=30`, token);
  if (!Array.isArray(releases)) throw new Error("GitHub API did not return a release list");
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    if (!Array.isArray(release.assets)) continue;
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    const selected = {};
    let complete = true;
    for (const arch of DEB_ARCHES) {
      const asset = assets.get(`${assetPrefix}-${arch}.deb`);
      if (!asset || !/^sha256:/.test(asset.digest ?? "") || !Number.isInteger(asset.size)) {
        complete = false;
        break;
      }
      selected[arch] = asset;
    }
    if (!complete) continue;
    return { tag: release.tag_name, selected };
  }
  throw new Error(
    `No GitHub release found carrying ${assetPrefix}-amd64.deb and ${assetPrefix}-arm64.deb with SHA-256 digests`,
  );
}

async function downloadAndVerify(url, destination, expectedSha256, expectedSize, label) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    throw new Error(`Download redirected to non-HTTPS URL (${finalUrl.protocol}) for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expectedSize) {
    throw new Error(`${label} size mismatch: expected ${expectedSize}, got ${bytes.length}`);
  }
  const actual = crypto.createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(expectedSha256, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error(
      `${label} SHA256 mismatch: expected ${expectedSha256}, got ${actual.toString("hex")}`,
    );
  }
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
}

async function resolveUpstreamRelease(options) {
  const repository = String(options.repository).replace(/\/+$/, "");
  if (!/^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Unsafe GitHub API repository URL: ${repository}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(options.assetPrefix)) {
    throw new Error(`Unsafe asset prefix: ${options.assetPrefix}`);
  }
  if (!DEB_ARCHES.includes(options.architecture)) {
    throw new Error("--arch must be amd64 or arm64");
  }
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const { tag, selected } = await selectRelease(repository, options.assetPrefix, token);
  const asset = selected[options.architecture];
  const version = normalizeTagVersion(tag);
  const downloadBase = `${repository.replace(/^https:\/\/api\.github\.com\/repos\//, "https://github.com/")}/releases/download`;
  const metadata = {
    package: options.assetPrefix,
    version,
    packageVersion: version,
    architecture: options.architecture,
    repositoryPath: `${tag}/${asset.name}`,
    sha256: parseSha256Digest(asset.digest),
    size: Number(asset.size),
    depends: "",
    repository: downloadBase,
  };

  let packagePath = null;
  if (!options.metadataOnly) {
    packagePath = path.join(outputDir, `${options.assetPrefix}_${version}_${options.architecture}.deb`);
    await downloadAndVerify(
      `${downloadBase}/${metadata.repositoryPath}`,
      packagePath,
      metadata.sha256,
      metadata.size,
      path.basename(packagePath),
    );
  }
  const result = { ...metadata, path: packagePath };
  fs.writeFileSync(options.metadataPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const values = {};
  let metadataOnly = false;
  for (let i = 0; i < args.length;) {
    if (args[i] === "--metadata-only") {
      metadataOnly = true;
      i += 1;
      continue;
    }
    if (!args[i].startsWith("--") || i + 1 >= args.length) {
      throw new Error(`Invalid argument: ${args[i]}`);
    }
    values[args[i]] = args[i + 1];
    i += 2;
  }
  for (const flag of ["--output-dir", "--metadata", "--repository", "--asset-prefix"]) {
    if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
  }
  if (!["amd64", "arm64"].includes(values["--arch"])) {
    throw new Error("--arch must be amd64 or arm64");
  }
  const result = await resolveUpstreamRelease({
    outputDir: values["--output-dir"],
    metadataPath: values["--metadata"],
    assetPrefix: values["--asset-prefix"],
    architecture: values["--arch"],
    repository: values["--repository"],
    metadataOnly,
  });
  process.stdout.write(`${result.path ?? values["--metadata"]}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  normalizeTagVersion,
  parseSha256Digest,
  resolveUpstreamRelease,
  selectRelease,
};
