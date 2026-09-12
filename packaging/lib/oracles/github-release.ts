// GitHub release asset oracle: release listing -> per-asset SHA-256 digest from
// the GitHub API -> download-time verification. Picks the newest non-draft,
// non-prerelease release carrying both architecture .deb assets.

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
  writeFileAtomic,
} from "../http.ts";
import { writeMetadata } from "../metadata.ts";
import type { Architecture, GithubReleaseOracle, Metadata } from "../types.ts";
import { ARCHITECTURES } from "../types.ts";
import { parseSha256Digest, normalizeTagVersion } from "./release-common.ts";
import { prepareOutput, type ResolveRequest } from "./shared.ts";

const GITHUB_API_PREFIX = "https://api.github.com/repos/";
const REPOSITORY_PATTERN =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface ReleaseAsset {
  name: string;
  digest: string;
  size: number;
}

export function assertRepositoryUrl(repository: string): string {
  const normalized = repository.replace(/\/+$/, "");
  if (!REPOSITORY_PATTERN.test(normalized)) {
    fail(`Unsafe GitHub API repository URL: ${repository}`);
  }
  return normalized;
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") fail(`URL must be https: ${url}`);
  if (parsed.hostname !== "api.github.com") fail(`unexpected host: ${url}`);
  if (parsed.hash !== "") fail(`URL must not contain a fragment: ${url}`);
  const headers: Record<string, string> = {
    "User-Agent": "homebrew-tap-appimage-builder",
    Accept: "application/vnd.github+json",
  };
  if (token !== "") headers["Authorization"] = `Bearer ${assertSingleLine(token, "token")}`;
  const response = await fetchWithRetry(url, { headers, redirect: "error", timeoutMs: 30000 });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

interface ReleaseSelection {
  tag: string;
  assets: Record<Architecture, ReleaseAsset>;
}

export async function selectRelease(
  repository: string,
  assetPrefix: string,
  token: string,
): Promise<ReleaseSelection> {
  const releases = await fetchJson(`${repository}/releases?per_page=30`, token);
  if (!Array.isArray(releases)) throw new Error("GitHub API did not return a release list");
  for (const candidate of releases) {
    const release = candidate as {
      draft?: unknown;
      prerelease?: unknown;
      assets?: unknown;
      tag_name?: unknown;
    };
    if (release.draft === true || release.prerelease === true) continue;
    if (!Array.isArray(release.assets)) continue;
    const byName = new Map<string, { name: string; digest: string; size: number }>();
    for (const raw of release.assets) {
      const asset = raw as { name?: unknown; digest?: unknown; size?: unknown };
      if (typeof asset.name !== "string") continue;
      if (typeof asset.digest !== "string" || typeof asset.size !== "number") continue;
      byName.set(asset.name, { name: asset.name, digest: asset.digest, size: asset.size });
    }
    const assets = {} as Record<Architecture, ReleaseAsset>;
    let complete = true;
    for (const architecture of ARCHITECTURES) {
      const asset = byName.get(`${assetPrefix}-${architecture}.deb`);
      if (
        !asset ||
        !/^sha256:/i.test(asset.digest) ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 ||
        asset.size > MAX_PAYLOAD_BYTES
      ) {
        complete = false;
        break;
      }
      assets[architecture] = {
        name: asset.name,
        digest: parseSha256Digest(asset.digest),
        size: asset.size,
      };
    }
    if (!complete) continue;
    if (typeof release.tag_name !== "string") continue;
    return { tag: release.tag_name, assets };
  }
  throw new Error(
    `No GitHub release found carrying ${assetPrefix}-amd64.deb and ${assetPrefix}-arm64.deb with SHA-256 digests`,
  );
}

export async function downloadAndVerify(
  url: string,
  destination: string,
  expectedSha256: string,
  expectedSize: number,
  label: string,
): Promise<void> {
  const response = await fetchWithRetry(url, { redirect: "follow", timeoutMs: 60000 });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    throw new Error(`Download redirected to non-HTTPS URL (${finalUrl.protocol}) for ${url}`);
  }
  assertHostAllowed(finalUrl, GITHUB_ASSET_HOSTS, "download");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_PAYLOAD_BYTES) throw new Error("payload too large");
  const bytes = await readPayload(response);
  if (bytes.length !== expectedSize) {
    throw new Error(`${label} size mismatch: expected ${expectedSize}, got ${bytes.length}`);
  }
  if (!digestMatchesHex(expectedSha256, sha256Digest(bytes))) {
    throw new Error(
      `${label} SHA256 mismatch: expected ${expectedSha256}, got ${sha256Digest(bytes).toString("hex")}`,
    );
  }
  writeFileAtomic(destination, bytes);
}

export async function resolveWithGithubRelease(
  oracle: GithubReleaseOracle,
  request: ResolveRequest,
): Promise<Metadata> {
  const repository = assertRepositoryUrl(oracle.repository);
  const assetPrefix = assertMatches(
    oracle.assetPrefix,
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
    "asset prefix",
  );
  const { outputDir, metadataPath } = prepareOutput(request);
  const architecture = request.architecture;

  const { tag, assets } = await selectRelease(repository, assetPrefix, request.token);
  const asset = assets[architecture];
  const version = normalizeTagVersion(tag);
  const downloadBase = `${repository.replace(GITHUB_API_PREFIX, "https://github.com/")}/releases/download`;
  const size = assertPositiveSize(asset.size, MAX_PAYLOAD_BYTES, `${asset.name} size`);

  const metadata: Metadata = {
    package: assetPrefix,
    version,
    packageVersion: version,
    architecture,
    repositoryPath: `${tag}/${asset.name}`,
    sha256: asset.digest,
    size,
    depends: "",
    repository: downloadBase,
    path: null,
  };

  if (!request.metadataOnly) {
    const packagePath = path.join(outputDir, `${assetPrefix}_${version}_${architecture}.deb`);
    await downloadAndVerify(
      `${downloadBase}/${metadata.repositoryPath}`,
      packagePath,
      metadata.sha256,
      metadata.size,
      path.basename(packagePath),
    );
    metadata.path = packagePath;
  }
  writeMetadata(metadataPath, metadata);
  return metadata;
}
