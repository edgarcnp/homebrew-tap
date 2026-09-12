#!/usr/bin/env node
"use strict";

// Resolver for Freebuff Desktop's Linux AppImage releases. Upstream's
// GitHub repo interleaves freebuff-desktop-v* releases with unrelated
// releases that all share one seeded created_at, so the /releases listing
// order is unstable and unusable for version discovery. Instead the app's
// own electron-updater feed is the version source (like gitbutler's CDN
// redirect):
//   GET <feed>/<linux-x64|linux-arm64>/latest-linux[-arm64].yml
//   -> 302 https://github.com/CodebuffAI/codebuff-community/releases/
//         download/freebuff-desktop-v<version>/<name>.yml
// The yml carries the AppImage filename, SHA-512 and size; the GitHub API
// release for that exact tag carries the SHA-256 asset digest. Both hashes
// and the size are verified at download time. --metadata-only queries both
// checksum sources but never downloads the payload.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_PAYLOAD_BYTES,
  fetchWithRetry,
  readPayload,
  writeFileAtomic,
} = require(path.join(__dirname, "..", "..", "lib", "net-utils"));

// Pinned hosts: the feed origin, the API, and the GitHub asset hosts.
const ALLOWED_FEED_HOSTS = new Set(["freebuff.com"]);
const ALLOWED_ASSET_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const MAX_YAML_BYTES = 64 * 1024;

// electron-builder names the linux update yml per architecture
const ARCH_LAYOUT = {
  amd64: {
    feedDir: "linux-x64",
    yml: "latest-linux.yml",
    assetArch: "x86_64",
  },
  arm64: {
    feedDir: "linux-arm64",
    yml: "latest-linux-arm64.yml",
    assetArch: "arm64",
  },
};

function sha256Buffer(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha512Base64(bytes) {
  return crypto.createHash("sha512").update(bytes).digest("base64");
}

function sha256Matches(expectedHex, actualBuffer) {
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actualBuffer.length && crypto.timingSafeEqual(actualBuffer, expected);
}

function validateRepository(repository) {
  let u;
  try {
    u = new URL(String(repository));
  } catch (error) {
    throw new Error(`Invalid repository URL (${repository}): ${error.message}`);
  }
  if (u.protocol !== "https:") throw new Error(`Repository must be https (got ${u.protocol}) for ${repository}`);
  if (u.search || u.hash) throw new Error(`Repository must not contain query or hash for ${repository}`);
  if (!ALLOWED_FEED_HOSTS.has(u.hostname)) throw new Error(`Unexpected feed host (${u.hostname})`);
  return u.origin + u.pathname.replace(/\/+$/, "");
}

function validateGithubRepository(githubRepository) {
  const normalized = String(githubRepository).replace(/\/+$/, "");
  if (!/^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`Unsafe GitHub API repository URL: ${githubRepository}`);
  }
  return normalized;
}

// Returns { version, tag } from the feed's 302 Location, pinning the exact
// GitHub release-asset URL shape so an upstream layout change fails loudly.
function parseFeedRedirect(locationUrl, tagPrefix) {
  let u;
  try {
    u = new URL(String(locationUrl));
  } catch (error) {
    throw new Error(`Feed redirect Location is not an absolute URL (${locationUrl}): ${error.message}`);
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com") {
    throw new Error(`Feed redirected to unexpected URL: ${locationUrl}`);
  }
  const segments = u.pathname.split("/").filter(Boolean);
  // github.com/<owner>/<repo>/releases/download/<tag>/<file>.yml
  if (segments.length !== 6 || segments[2] !== "releases" || segments[3] !== "download") {
    throw new Error(`Feed redirect path is not a release asset download: ${u.pathname}`);
  }
  const [owner, repo, , , tag, fileName] = segments;
  if (!/^[A-Za-z0-9._-]+\.yml$/.test(fileName)) {
    throw new Error(`Feed redirect target is not an update yml: ${fileName}`);
  }
  if (!tag.startsWith(tagPrefix)) {
    throw new Error(`Release tag ${tag} does not start with ${tagPrefix}`);
  }
  const version = tag.slice(tagPrefix.length).replace(/^v/, "");
  if (!/^[0-9][0-9A-Za-z.-]*$/.test(version)) {
    throw new Error(`Unrecognized version in tag ${tag}`);
  }
  return { version, tag, owner, repo, fileName };
}

function requireGithubCoords(parsed, githubRepository) {
  const match = githubRepository.match(/^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match || match[1] !== parsed.owner || match[2] !== parsed.repo) {
    throw new Error(`Feed redirect ${parsed.owner}/${parsed.repo} does not match configured repository`);
  }
}

// Minimal strict parser for the electron-builder update yml: reads the
// top-level version/path/sha512 keys and the files: block entries (which
// carry size), then cross-checks the first file entry against the
// top-level triple, version, and the expected asset filename. releaseNotes
// and any other content are ignored.
function parseUpdateYml(body, expectedVersion, expectedAsset) {
  if (body.length > MAX_YAML_BYTES) throw new Error("update yml too large");
  const top = {};
  const files = [];
  let inFiles = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("files:")) { inFiles = true; continue; }
    const topLevel = line.match(/^(version|path|sha512):\s*(.*)\s*$/);
    if (topLevel) {
      inFiles = false;
      if (top[topLevel[1]] === undefined) top[topLevel[1]] = topLevel[2];
      continue;
    }
    if (!inFiles) continue;
    const entry = line.match(/^  - url:\s*(\S+)\s*$/);
    if (entry) { files.push({ url: entry[1] }); continue; }
    const field = line.match(/^ {4}(sha512|size|blockMapSize):\s*(\S+)\s*$/);
    if (field && files.length > 0) files[files.length - 1][field[1]] = field[2];
  }
  for (const key of ["version", "path", "sha512"]) {
    if (top[key] === undefined) throw new Error(`update yml missing ${key}`);
  }
  if (files.length === 0) throw new Error("update yml has no files entries");
  const first = files[0];
  for (const key of ["sha512", "size"]) {
    if (first[key] === undefined) throw new Error(`update yml files entry missing ${key}`);
  }
  if (top.version !== expectedVersion) {
    throw new Error(`update yml version ${top.version} does not match tag version ${expectedVersion}`);
  }
  if (top.path !== expectedAsset || first.url !== expectedAsset) {
    throw new Error(`update yml asset ${top.path}/${first.url} does not match expected ${expectedAsset}`);
  }
  if (top.sha512 !== first.sha512) {
    throw new Error("update yml top-level sha512 disagrees with the files entry");
  }
  if (!/^[A-Za-z0-9+/]{86}==?$/.test(first.sha512)) {
    throw new Error(`update yml sha512 is not a base64 SHA-512: ${first.sha512.slice(0, 16)}...`);
  }
  const size = Number(first.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PAYLOAD_BYTES) {
    throw new Error(`update yml size is not a sane byte count: ${first.size}`);
  }
  return { sha512: first.sha512, size };
}

async function fetchYaml(feedUrl) {
  const response = await fetchWithRetry(feedUrl, { redirect: "follow", timeoutMs: 30000 });
  if (!response.ok) throw new Error(`Feed fetch failed (${response.status}) for ${feedUrl}`);
  const finalUrl = new URL(response.url);
  if (!ALLOWED_ASSET_HOSTS.has(finalUrl.hostname)) {
    throw new Error(`Feed yml served from unexpected host (${finalUrl.hostname})`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_YAML_BYTES) throw new Error(`Feed yml too large (Content-Length ${declaredLength})`);
  const bytes = await readPayload(response);
  if (bytes.length > MAX_YAML_BYTES) throw new Error("Feed yml too large");
  return bytes.toString("utf8");
}

async function fetchReleaseForTag(githubRepository, tag, token) {
  const u = new URL(`${githubRepository}/releases/tags/${encodeURIComponent(tag)}`);
  if (u.hostname !== "api.github.com") throw new Error(`unexpected host: ${u}`);
  const headers = { "User-Agent": "homebrew-tap-appimage-builder", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchWithRetry(u, { headers, redirect: "error", timeoutMs: 30000 });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}) for ${u}`);
  return response.json();
}

function selectAsset(release, tag, assetName, ymlSize) {
  if (release.tag_name !== tag) {
    throw new Error(`Release tag ${release.tag_name} does not match requested ${tag}`);
  }
  if (release.draft) throw new Error(`Release ${tag} is a draft`);
  if (!Array.isArray(release.assets)) throw new Error(`Release ${tag} has no asset list`);
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) throw new Error(`Release ${tag} has no asset ${assetName}`);
  const digest = String(asset.digest ?? "");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Release asset digest is not a sha256 digest: ${digest}`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PAYLOAD_BYTES) {
    throw new Error(`Release asset ${assetName} has an unusable size`);
  }
  if (asset.size !== ymlSize) {
    throw new Error(`Asset size ${asset.size} does not match update yml size ${ymlSize}`);
  }
  return { name: assetName, sha256: digest.slice("sha256:".length).toLowerCase(), size: asset.size };
}

async function downloadAndVerify(url, destination, expectedSha256, expectedSha512, expectedSize, label) {
  const response = await fetchWithRetry(url, { redirect: "follow", timeoutMs: 60000 });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const finalUrl = new URL(response.url);
  if (!ALLOWED_ASSET_HOSTS.has(finalUrl.hostname)) {
    throw new Error(`Download redirected to unexpected host (${finalUrl.hostname}) for ${url}`);
  }
  const bytes = await readPayload(response);
  if (bytes.length !== expectedSize) {
    throw new Error(`${label} size mismatch: expected ${expectedSize}, got ${bytes.length}`);
  }
  if (!sha256Matches(Buffer.from(expectedSha256, "hex"), crypto.createHash("sha256").update(bytes).digest())) {
    throw new Error(`${label} SHA256 mismatch: expected ${expectedSha256}, got ${sha256Buffer(bytes)}`);
  }
  if (sha512Base64(bytes) !== expectedSha512) {
    throw new Error(`${label} SHA512 mismatch against the upstream update feed`);
  }
  writeFileAtomic(destination, bytes);
}

async function resolveFreebuffPackage(options) {
  const architecture = String(options.architecture).trim().toLowerCase();
  const layout = ARCH_LAYOUT[architecture];
  if (!layout) {
    throw new Error(`Unsupported architecture '${architecture}'; Freebuff publishes amd64 and arm64 only`);
  }
  const repository = validateRepository(options.repository);
  const githubRepository = validateGithubRepository(options.githubRepository);
  const tagPrefix = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(String(options.tagPrefix ?? ""))
    ? String(options.tagPrefix)
    : "freebuff-desktop-v";
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const resolvedMeta = path.resolve(options.metadataPath);
  if (!resolvedMeta.startsWith(outputDir + path.sep) && resolvedMeta !== outputDir) {
    throw new Error("metadataPath must be inside outputDir");
  }

  // Redirect only: the Location header carries the exact release tag.
  const feedUrl = `${repository}/${layout.feedDir}/${layout.yml}`;
  const probe = await fetchWithRetry(feedUrl, { redirect: "manual", timeoutMs: 30000 });
  const initialHost = new URL(feedUrl).hostname;
  if (!ALLOWED_FEED_HOSTS.has(initialHost)) throw new Error(`Unexpected feed host (${initialHost})`);
  if (probe.status !== 302) throw new Error(`Feed did not answer with a redirect (${probe.status}) for ${feedUrl}`);
  const location = probe.headers.get("location");
  if (!location) throw new Error(`Feed redirect has no Location header for ${feedUrl}`);
  const parsed = parseFeedRedirect(location, tagPrefix);
  requireGithubCoords(parsed, githubRepository);

  const yamlBody = await fetchYaml(location);
  const expectedAsset = `Freebuff-${parsed.version}-linux-${layout.assetArch}.AppImage`;
  const yml = parseUpdateYml(yamlBody, parsed.version, expectedAsset);

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (token && /[\r\n]/.test(String(token))) throw new Error("invalid token");
  const release = await fetchReleaseForTag(githubRepository, parsed.tag, token);
  const asset = selectAsset(release, parsed.tag, expectedAsset, yml.size);

  const downloadBase = `${githubRepository.replace(/^https:\/\/api\.github\.com\/repos\//, "https://github.com/")}/releases/download`;
  const metadata = {
    package: "freebuff-desktop",
    version: parsed.version,
    packageVersion: parsed.version,
    architecture,
    repositoryPath: `${parsed.tag}/${asset.name}`,
    sha256: asset.sha256,
    size: asset.size,
    depends: "",
    repository: downloadBase,
  };

  let packagePath = null;
  if (!options.metadataOnly) {
    packagePath = path.join(outputDir, `freebuff-desktop_${parsed.version}_${architecture}.AppImage`);
    await downloadAndVerify(
      `${downloadBase}/${metadata.repositoryPath}`,
      packagePath,
      asset.sha256,
      yml.sha512,
      asset.size,
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
  for (let i = 0; i < args.length;) {
    if (args[i] === "--metadata-only") {
      metadataOnly = true;
      i += 1;
      continue;
    }
    if (!args[i].startsWith("--") || i + 1 >= args.length) {
      throw new Error(`Invalid argument: ${args[i]}`);
    }
    if (Object.prototype.hasOwnProperty.call(values, args[i])) {
      throw new Error(`Duplicate argument: ${args[i]}`);
    }
    values[args[i]] = args[i + 1];
    i += 2;
  }
  // Tolerate flags the shared workflow passes unconditionally but that do
  // not apply to this resolver (e.g. --key-base64).
  for (const flag of ["--output-dir", "--metadata", "--repository", "--github-repository"]) {
    if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
  }
  if (!["amd64", "arm64"].includes(values["--arch"])) {
    throw new Error("--arch must be amd64 or arm64");
  }
  const result = await resolveFreebuffPackage({
    outputDir: values["--output-dir"],
    metadataPath: values["--metadata"],
    architecture: values["--arch"],
    repository: values["--repository"],
    githubRepository: values["--github-repository"],
    tagPrefix: values["--tag-prefix"] ?? "freebuff-desktop-v",
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
  parseFeedRedirect,
  parseUpdateYml,
  resolveFreebuffPackage,
  selectAsset,
  sha256Buffer,
  sha512Base64,
};
