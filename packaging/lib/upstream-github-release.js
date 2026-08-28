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
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

async function fetchWithRetry(url, opts, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetch(url, opts);
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      continue;
    }
    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      if (attempt === retries) return response;
      const retryAfter = response.headers.get("retry-after");
      let delayMs = 500 * Math.pow(2, attempt);
      if (retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs)) delayMs = secs * 1000;
        else {
          const dateMs = Date.parse(retryAfter);
          if (Number.isFinite(dateMs)) delayMs = Math.max(0, dateMs - Date.now());
        }
      }
      delayMs = Math.min(delayMs, 30000);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    return response;
  }
  throw lastError;
}

function writeFileAtomic(filePath, data) {
  const tmp = filePath + ".tmp." + crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

async function readPayload(response) {
  const lenHeader = Number(response.headers.get("content-length") || 0);
  if (lenHeader > MAX_PAYLOAD_BYTES) throw new Error("payload too large");
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error(`Payload too large (${bytes.length} bytes) for ${response.url}`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`Payload exceeds size cap (${MAX_PAYLOAD_BYTES} bytes) for ${response.url}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

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
  const u = new URL(String(url));
  if (u.protocol !== "https:") throw new Error(`URL must be https: ${url}`);
  if (u.hostname !== "api.github.com") throw new Error(`unexpected host: ${url}`);
  if (u.hash) throw new Error(`URL must not contain hash: ${url}`);
  if (token && /[\r\n]/.test(String(token))) throw new Error("invalid token");
  const headers = { "User-Agent": "homebrew-tap-appimage-builder" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Abort slow/stalled downloads (30s or 60s) instead of hanging indefinitely
  const response = await fetchWithRetry(url, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function selectRelease(repository, assetPrefix, token) {
  if(!/^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository).replace(/\/+$/,""))) throw new Error("invalid repository");
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
      if (!asset || !/^sha256:/.test(asset.digest ?? "") || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PAYLOAD_BYTES) {
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
  // Abort slow/stalled downloads (30s or 60s) instead of hanging indefinitely
  const response = await fetchWithRetry(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    throw new Error(`Download redirected to non-HTTPS URL (${finalUrl.protocol}) for ${url}`);
  }
  const final = new URL(response.url); if(!["github.com","objects.githubusercontent.com","github-releases.githubusercontent.com","release-assets.githubusercontent.com"].includes(final.hostname)) throw new Error("unexpected download host");
  const len=Number(response.headers.get("content-length")||0); if(len>MAX_PAYLOAD_BYTES) throw new Error("payload too large");
  const bytes = await readPayload(response);
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
  writeFileAtomic(destination, bytes);
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
  const resolvedMeta = path.resolve(options.metadataPath); const resolvedOut = path.resolve(options.outputDir); if(!resolvedMeta.startsWith(resolvedOut+path.sep) && resolvedMeta!==resolvedOut) throw new Error("metadataPath must be inside outputDir");

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
  writeFileAtomic(options.metadataPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const values = {};
  let metadataOnly = false;
  const allowedFlags = new Set(["--output-dir", "--metadata", "--repository", "--asset-prefix", "--arch"]);
  for (let i = 0; i < args.length;) {
    if (args[i] === "--metadata-only") {
      metadataOnly = true;
      i += 1;
      continue;
    }
    if (!args[i].startsWith("--") || !allowedFlags.has(args[i])) {
      throw new Error(`Invalid argument: ${args[i]}`);
    }
    if (!args[i+1] || args[i+1].startsWith("--")) {
      throw new Error(`Missing value for ${args[i]}`);
    }
    if (Object.prototype.hasOwnProperty.call(values, args[i])) {
      throw new Error(`Duplicate argument: ${args[i]}`);
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
