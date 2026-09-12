// electron-updater feed oracle. The app's own update feed is the version
// source (the upstream repository interleaves unrelated releases that share a
// single created_at, so the /releases listing order is unusable):
//
//   GET <feed>/<linux-x64|linux-arm64>/latest-linux[-arm64].yml
//     -> 302 https://github.com/<owner>/<repo>/releases/download/<tag>/<name>.yml
//
// The yml carries the AppImage filename, SHA-512 and size; the GitHub API
// release for that exact tag carries the SHA-256 asset digest. Both hashes and
// the size are verified at download time.

import * as path from "node:path";
import {
  GITHUB_ASSET_HOSTS,
  assertHostAllowed,
  assertMatches,
  assertPositiveSize,
  assertSingleLine,
  fail,
} from "../guards.ts";
import {
  MAX_PAYLOAD_BYTES,
  digestMatchesHex,
  fetchWithRetry,
  readPayload,
  sha256Digest,
  sha512Base64,
  writeFileAtomic,
} from "../http.ts";
import { writeMetadata } from "../metadata.ts";
import type { Architecture, ElectronFeedOracle, Metadata } from "../types.ts";
import { assertRepositoryUrl } from "./github-release.ts";
import { normalizeTagVersion, parseSha256Digest } from "./release-common.ts";
import { prepareOutput, type ResolveRequest } from "./shared.ts";

const MAX_YAML_BYTES = 64 * 1024;

// electron-builder names the linux update yml per architecture.
const ARCH_LAYOUT: Record<
  Architecture,
  { feedDir: string; yml: string; assetArch: string }
> = {
  amd64: { feedDir: "linux-x64", yml: "latest-linux.yml", assetArch: "x86_64" },
  arm64: { feedDir: "linux-arm64", yml: "latest-linux-arm64.yml", assetArch: "arm64" },
};

export function validateFeedRepository(repository: string): string {
  let url: URL;
  try {
    url = new URL(String(repository));
  } catch {
    fail(`Invalid feed repository URL: ${repository}`);
  }
  if (url.protocol !== "https:") {
    fail(`Feed repository must be https (got ${url.protocol}) for ${repository}`);
  }
  if (url.search !== "" || url.hash !== "") {
    fail(`Feed repository must not contain a query or fragment: ${repository}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export interface FeedRedirect {
  version: string;
  tag: string;
  owner: string;
  repo: string;
  fileName: string;
}

// Pins the exact GitHub release-asset URL shape so an upstream layout change
// fails loudly instead of resolving a wrong asset.
export function parseFeedRedirect(locationUrl: string, tagPrefix: string): FeedRedirect {
  let url: URL;
  try {
    url = new URL(String(locationUrl));
  } catch {
    fail(`Feed redirect Location is not an absolute URL (${locationUrl})`);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    fail(`Feed redirected to unexpected URL: ${locationUrl}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  // github.com/<owner>/<repo>/releases/download/<tag>/<file>.yml
  if (segments.length !== 6 || segments[2] !== "releases" || segments[3] !== "download") {
    fail(`Feed redirect path is not a release asset download: ${url.pathname}`);
  }
  const [owner, repo, , , tag, fileName] = segments;
  if (owner === undefined || repo === undefined || tag === undefined || fileName === undefined) {
    fail(`Feed redirect path is not a release asset download: ${url.pathname}`);
  }
  if (!/^[A-Za-z0-9._-]+\.yml$/.test(fileName)) {
    fail(`Feed redirect target is not an update yml: ${fileName}`);
  }
  if (!tag.startsWith(tagPrefix)) {
    fail(`Release tag ${tag} does not start with ${tagPrefix}`);
  }
  const version = normalizeTagVersion(tag.slice(tagPrefix.length));
  return { version, tag, owner, repo, fileName };
}

export function requireGithubCoords(parsed: FeedRedirect, githubRepository: string): void {
  const match =
    /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
      githubRepository,
    );
  if (!match || match[1] !== parsed.owner || match[2] !== parsed.repo) {
    fail(`Feed redirect ${parsed.owner}/${parsed.repo} does not match configured repository`);
  }
}

// Minimal strict parser for the electron-builder update yml: reads the
// top-level version/path/sha512 keys and the files: entries (which carry
// size), then cross-checks them against each other and the expected asset
// name. releaseNotes and any other content are ignored.
export function parseUpdateYml(
  body: string,
  expectedVersion: string,
  expectedAsset: string,
): { sha512: string; size: number } {
  if (body.length > MAX_YAML_BYTES) throw new Error("update yml too large");
  const top: Record<string, string> = {};
  const files: Array<Record<string, string>> = [];
  let inFiles = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("files:")) {
      inFiles = true;
      continue;
    }
    const topLevel = /^(version|path|sha512):\s*(.*)\s*$/.exec(line);
    if (topLevel === null) {
      if (!inFiles) continue;
      const entry = /^ {2}- url:\s*(\S+)\s*$/.exec(line);
      if (entry !== null && entry[1] !== undefined) {
        files.push({ url: entry[1] });
        continue;
      }
      const field = /^ {4}(sha512|size|blockMapSize):\s*(\S+)\s*$/.exec(line);
      const current = files[files.length - 1];
      if (field !== null && current !== undefined) {
        const key = field[1];
        const value = field[2];
        if (key !== undefined && value !== undefined) current[key] = value;
      }
      continue;
    }
    inFiles = false;
    const key = topLevel[1];
    const value = topLevel[2];
    if (key !== undefined && value !== undefined && top[key] === undefined) top[key] = value;
  }
  for (const key of ["version", "path", "sha512"]) {
    if (top[key] === undefined) throw new Error(`update yml missing ${key}`);
  }
  if (files.length === 0) throw new Error("update yml has no files entries");
  const first = files[0];
  if (first === undefined) throw new Error("update yml has no files entries");
  for (const key of ["sha512", "size"]) {
    if (first[key] === undefined) throw new Error(`update yml files entry missing ${key}`);
  }
  if (top["version"] !== expectedVersion) {
    throw new Error(
      `update yml version ${String(top["version"])} does not match tag version ${expectedVersion}`,
    );
  }
  if (top["path"] !== expectedAsset || first["url"] !== expectedAsset) {
    throw new Error(
      `update yml asset ${String(top["path"])}/${String(first["url"])} does not match expected ${expectedAsset}`,
    );
  }
  if (top["sha512"] !== first["sha512"]) {
    throw new Error("update yml top-level sha512 disagrees with the files entry");
  }
  const sha512 = first["sha512"] ?? "";
  if (!/^[A-Za-z0-9+/]{86}==?$/.test(sha512)) {
    throw new Error(`update yml sha512 is not a base64 SHA-512: ${sha512.slice(0, 16)}...`);
  }
  const size = Number(first["size"]);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PAYLOAD_BYTES) {
    throw new Error(`update yml size is not a sane byte count: ${String(first["size"])}`);
  }
  return { sha512, size };
}

async function fetchYaml(feedUrl: string): Promise<string> {
  const response = await fetchWithRetry(feedUrl, { redirect: "follow", timeoutMs: 30000 });
  if (!response.ok) throw new Error(`Feed fetch failed (${response.status}) for ${feedUrl}`);
  const finalUrl = new URL(response.url);
  assertHostAllowed(finalUrl, GITHUB_ASSET_HOSTS, "feed yml");
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_YAML_BYTES) {
    throw new Error(`Feed yml too large (Content-Length ${declaredLength})`);
  }
  const bytes = await readPayload(response);
  if (bytes.length > MAX_YAML_BYTES) throw new Error("Feed yml too large");
  return bytes.toString("utf8");
}

async function fetchReleaseForTag(
  githubRepository: string,
  tag: string,
  token: string,
): Promise<unknown> {
  const url = new URL(`${githubRepository}/releases/tags/${encodeURIComponent(tag)}`);
  if (url.hostname !== "api.github.com") fail(`unexpected host: ${String(url)}`);
  const headers: Record<string, string> = {
    "User-Agent": "homebrew-tap-appimage-builder",
    Accept: "application/vnd.github+json",
  };
  if (token !== "") headers["Authorization"] = `Bearer ${assertSingleLine(token, "token")}`;
  const response = await fetchWithRetry(url, { headers, redirect: "error", timeoutMs: 30000 });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${String(url)}`);
  }
  return response.json();
}

export interface SelectedAsset {
  name: string;
  sha256: string;
  size: number;
}

export function selectAsset(
  release: unknown,
  tag: string,
  assetName: string,
  ymlSize: number,
): SelectedAsset {
  const typed = release as { tag_name?: unknown; draft?: unknown; assets?: unknown };
  if (typed.tag_name !== tag) {
    throw new Error(`Release tag ${String(typed.tag_name)} does not match requested ${tag}`);
  }
  if (typed.draft === true) throw new Error(`Release ${tag} is a draft`);
  if (!Array.isArray(typed.assets)) throw new Error(`Release ${tag} has no asset list`);
  const found = typed.assets.find((candidate) => {
    const asset = candidate as { name?: unknown };
    return asset.name === assetName;
  }) as { digest?: unknown; size?: unknown } | undefined;
  if (found === undefined) throw new Error(`Release ${tag} has no asset ${assetName}`);
  const digest = String(found.digest ?? "");
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) {
    throw new Error(`Release asset digest is not a sha256 digest: ${digest}`);
  }
  const size = assertPositiveSize(
    found.size as number,
    MAX_PAYLOAD_BYTES,
    `release asset ${assetName}`,
  );
  if (size !== ymlSize) {
    throw new Error(`Asset size ${size} does not match update yml size ${ymlSize}`);
  }
  return { name: assetName, sha256: parseSha256Digest(digest), size };
}

async function downloadAndVerify(
  url: string,
  destination: string,
  expected: { sha256: string; sha512: string; size: number },
  label: string,
): Promise<void> {
  const response = await fetchWithRetry(url, { redirect: "follow", timeoutMs: 60000 });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const finalUrl = new URL(response.url);
  assertHostAllowed(finalUrl, GITHUB_ASSET_HOSTS, "download");
  const bytes = await readPayload(response);
  if (bytes.length !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, got ${bytes.length}`);
  }
  if (!digestMatchesHex(expected.sha256, sha256Digest(bytes))) {
    throw new Error(`${label} SHA256 mismatch against the GitHub release digest`);
  }
  if (sha512Base64(bytes) !== expected.sha512) {
    throw new Error(`${label} SHA512 mismatch against the upstream update feed`);
  }
  writeFileAtomic(destination, bytes);
}

export async function resolveWithElectronFeed(
  oracle: ElectronFeedOracle,
  request: ResolveRequest,
): Promise<Metadata> {
  const layout = ARCH_LAYOUT[request.architecture];
  const repository = validateFeedRepository(oracle.repository);
  const githubRepository = assertRepositoryUrl(oracle.githubRepository);
  const tagPrefix = assertMatches(
    oracle.tagPrefix,
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
    "tag prefix",
  );
  const { outputDir, metadataPath } = prepareOutput(request);

  // Redirect only: the Location header carries the exact release tag.
  const feedUrl = `${repository}/${layout.feedDir}/${layout.yml}`;
  const probe = await fetchWithRetry(feedUrl, { redirect: "manual", timeoutMs: 30000 });
  const initialHost = new URL(feedUrl).hostname;
  const repositoryHost = new URL(repository).hostname;
  if (initialHost !== repositoryHost) {
    fail(`Unexpected feed host (${initialHost})`);
  }
  if (probe.status !== 302) {
    throw new Error(`Feed did not answer with a redirect (${probe.status}) for ${feedUrl}`);
  }
  const location = probe.headers.get("location");
  if (location === null) throw new Error(`Feed redirect has no Location header for ${feedUrl}`);
  const parsed = parseFeedRedirect(location, tagPrefix);
  requireGithubCoords(parsed, githubRepository);

  const expectedAsset = oracle.assetNameTemplate
    .replaceAll("{version}", parsed.version)
    .replaceAll("{arch}", layout.assetArch);
  const yml = parseUpdateYml(await fetchYaml(location), parsed.version, expectedAsset);

  const release = await fetchReleaseForTag(githubRepository, parsed.tag, request.token);
  const asset = selectAsset(release, parsed.tag, expectedAsset, yml.size);

  const downloadBase = `${githubRepository.replace(
    "https://api.github.com/repos/",
    "https://github.com/",
  )}/releases/download`;
  const metadata: Metadata = {
    package: oracle.packageName,
    version: parsed.version,
    packageVersion: parsed.version,
    architecture: request.architecture,
    repositoryPath: `${parsed.tag}/${asset.name}`,
    sha256: asset.sha256,
    size: asset.size,
    depends: "",
    repository: downloadBase,
    path: null,
  };

  if (!request.metadataOnly) {
    const packagePath = path.join(
      outputDir,
      `${oracle.packageName}_${parsed.version}_${request.architecture}.AppImage`,
    );
    await downloadAndVerify(
      `${downloadBase}/${metadata.repositoryPath}`,
      packagePath,
      { sha256: asset.sha256, sha512: yml.sha512, size: asset.size },
      path.basename(packagePath),
    );
    metadata.path = packagePath;
  }
  writeMetadata(metadataPath, metadata);
  return metadata;
}
