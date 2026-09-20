// GitHub release asset oracle: release listing -> per-asset SHA-256 digest from
// the GitHub API -> download-time verification. Legacy layout picks the newest
// non-draft, non-prerelease release carrying both architecture .deb assets
// ("<assetPrefix>-<arch>.deb"); the versioned-asset flavor picks the newest
// release carrying the requested architecture's templated asset
// ("<name>-<version>-<arch>.deb") under a pinned tag prefix.

import * as path from "node:path";
import { GITHUB_ASSET_HOSTS, assertMatches, assertPositiveSize, fail } from "../guards.ts";
import { MAX_PAYLOAD_BYTES } from "../http.ts";
import { makeMetadata, writeMetadata } from "../metadata.ts";
import type { Architecture, GithubReleaseOracle, Metadata } from "../types.ts";
import { ARCHITECTURES } from "../types.ts";
import { downloadVerified } from "./download.ts";
import {
  githubApiFetch,
  githubDownloadBase,
  asReleaseList,
  isPublishedRelease,
  releaseAssetMap,
  releaseTag,
  releasesApiUrl,
  assertRepositoryUrl,
  type ReleaseAssetRecord,
} from "./github-api.ts";
import { isSha256Digest, normalizeTagVersion, parseSha256Digest } from "./release-common.ts";
import { prepareOutput, type ResolveRequest } from "./shared.ts";

interface ReleaseAsset {
  name: string;
  digest: string;
  size: number;
}

// An asset is usable only when its digest is a real sha256 and its size is
// sane; anything else counts as "not published", so a partial release is
// skipped rather than half-trusted.
function validatedAsset(record: ReleaseAssetRecord | undefined): ReleaseAsset | null {
  if (record === undefined) return null;
  if (!isSha256Digest(record.digest)) return null;
  if (!Number.isSafeInteger(record.size) || record.size <= 0 || record.size > MAX_PAYLOAD_BYTES) {
    return null;
  }
  return { name: record.name, digest: parseSha256Digest(record.digest), size: record.size };
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
  const releases = asReleaseList(await githubApiFetch(releasesApiUrl(repository), token));
  for (const release of releases) {
    if (!isPublishedRelease(release)) continue;
    const byName = releaseAssetMap(release);
    const assets = {} as Record<Architecture, ReleaseAsset>;
    let complete = true;
    for (const architecture of ARCHITECTURES) {
      const asset = validatedAsset(byName.get(`${assetPrefix}-${architecture}.deb`));
      if (asset === null) {
        complete = false;
        break;
      }
      assets[architecture] = asset;
    }
    if (!complete) continue;
    const tag = releaseTag(release);
    if (tag === undefined) continue;
    return { tag, assets };
  }
  throw new Error(
    `No GitHub release found carrying ${assetPrefix}-amd64.deb and ${assetPrefix}-arm64.deb with SHA-256 digests`,
  );
}

export interface TemplatedSelection {
  tag: string;
  version: string;
  asset: ReleaseAsset;
}

// Newest non-draft, non-prerelease release whose tag starts with tagPrefix and
// which carries the templated asset for the requested architecture. An arm64
// request against an amd64-only upstream (e.g. CommandCode) scans every
// release and fails with the asset name it never found.
export async function selectTemplatedRelease(
  repository: string,
  assetNameTemplate: string,
  tagPrefix: string,
  architecture: Architecture,
  token: string,
): Promise<TemplatedSelection> {
  const prefix = assertMatches(tagPrefix, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "tag prefix");
  if (!assetNameTemplate.includes("{version}")) fail("assetNameTemplate must contain {version}");
  const releases = asReleaseList(await githubApiFetch(releasesApiUrl(repository), token));
  for (const release of releases) {
    if (!isPublishedRelease(release)) continue;
    const tag = releaseTag(release);
    if (tag === undefined || !tag.startsWith(prefix)) continue;
    let version: string;
    try {
      version = normalizeTagVersion(tag.slice(prefix.length));
    } catch {
      continue;
    }
    const expected = assetNameTemplate
      .replaceAll("{version}", version)
      .replaceAll("{arch}", architecture);
    const asset = validatedAsset(releaseAssetMap(release).get(expected));
    if (asset === null) continue;
    return { tag, version, asset };
  }
  throw new Error(
    `No GitHub release found carrying ${assetNameTemplate.replaceAll("{arch}", architecture)} with a SHA-256 digest under tag prefix ${prefix}`,
  );
}

export async function resolveWithGithubRelease(
  oracle: GithubReleaseOracle,
  request: ResolveRequest,
): Promise<Metadata> {
  const repository = assertRepositoryUrl(oracle.repository);
  const { outputDir, metadataPath } = prepareOutput(request);
  const architecture = request.architecture;
  const downloadBase = githubDownloadBase(repository);

  if (oracle.assetNameTemplate !== undefined) {
    if (oracle.tagPrefix === undefined || oracle.packageName === undefined) {
      fail("assetNameTemplate requires tagPrefix and packageName");
    }
    const packageName = assertMatches(
      oracle.packageName,
      /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
      "package name",
    );
    const { tag, version, asset } = await selectTemplatedRelease(
      repository,
      oracle.assetNameTemplate,
      oracle.tagPrefix,
      architecture,
      request.token,
    );
    const size = assertPositiveSize(asset.size, MAX_PAYLOAD_BYTES, `${asset.name} size`);
    const packagePath = request.metadataOnly
      ? null
      : path.join(outputDir, `${packageName}_${version}_${architecture}.deb`);
    const metadata = makeMetadata({
      package: packageName,
      version,
      architecture,
      repositoryPath: `${tag}/${asset.name}`,
      sha256: asset.digest,
      size,
      repository: downloadBase,
      path: packagePath,
    });
    if (packagePath !== null) {
      await downloadVerified(
        `${downloadBase}/${metadata.repositoryPath}`,
        packagePath,
        { sha256: metadata.sha256, size: metadata.size },
        { allowedHosts: GITHUB_ASSET_HOSTS, label: path.basename(packagePath) },
      );
    }
    writeMetadata(metadataPath, metadata);
    return metadata;
  }

  if (oracle.assetPrefix === undefined) fail("github-release oracle requires assetPrefix or assetNameTemplate");
  const assetPrefix = assertMatches(
    oracle.assetPrefix,
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
    "asset prefix",
  );
  const { tag, assets } = await selectRelease(repository, assetPrefix, request.token);
  const asset = assets[architecture];
  const version = normalizeTagVersion(tag);
  const size = assertPositiveSize(asset.size, MAX_PAYLOAD_BYTES, `${asset.name} size`);
  const packagePath = request.metadataOnly
    ? null
    : path.join(outputDir, `${assetPrefix}_${version}_${architecture}.deb`);
  const metadata = makeMetadata({
    package: assetPrefix,
    version,
    architecture,
    repositoryPath: `${tag}/${asset.name}`,
    sha256: asset.digest,
    size,
    repository: downloadBase,
    path: packagePath,
  });
  if (packagePath !== null) {
    await downloadVerified(
      `${downloadBase}/${metadata.repositoryPath}`,
      packagePath,
      { sha256: metadata.sha256, size: metadata.size },
      { allowedHosts: GITHUB_ASSET_HOSTS, label: path.basename(packagePath) },
    );
  }
  writeMetadata(metadataPath, metadata);
  return metadata;
}
