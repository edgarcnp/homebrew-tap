// GitHub release asset advisory: the newest published release carrying the
// requested architecture's payload with a SHA-256 digest, verified at
// download. Two flavors:
//   - legacy `.deb` ("<assetPrefix>-<arch>.deb");
//   - versioned-asset by tag prefix plus `assetNameTemplate`, `.deb`,
//     `.AppImage` or `.tar.gz`. AppImage assets additionally cross-check the
//     release's electron-builder update yml (SHA-512 + size) before
//     downloading; a `.tar.gz` carries an app bundle tree (Zed) and is verified
//     by the release's published SHA-256 alone, since nothing upstream
//     publishes a second checksum for it.

import * as path from "node:path";
import { APPIMAGE_ARCH } from "../core/architecture.ts";
import { GITHUB_ASSET_HOSTS, assertMatches, assertPositiveSize, fail } from "../core/guards.ts";
import { MAX_PAYLOAD_BYTES } from "../core/http.ts";
import { makeMetadata, writeMetadata } from "../core/metadata.ts";
import { SAFE_REFERENCE } from "../core/patterns.ts";
import { hasPlaceholder, substitutePlaceholders } from "../core/template.ts";
import type { Architecture, GithubReleaseAdvisory, Metadata } from "../core/types.ts";
import { ARCHITECTURES } from "../core/types.ts";
import { downloadVerified, fetchVerified } from "./download.ts";
import { parseUpdateYml } from "./electron-feed.ts";
import {
  assertRepositoryUrl,
  fetchReleaseList,
  githubDownloadBase,
  isPublishedRelease,
  releaseAssetMap,
  releaseTag,
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

// An upstream AppImage payload (repacked by the appimage-tree pipeline stage),
// as opposed to a .deb or tarball payload staged from its own container.
export function isAppImageAsset(name: string): boolean {
  return name.endsWith(".AppImage");
}

// A tarball carrying an app bundle tree, staged by the tarball-tree pipeline
// stage: Zed publishes `zed-linux-x86_64.tar.gz` and no dpkg or AppImage
// artifact at all.
export function isTarballAsset(name: string): boolean {
  return name.endsWith(".tar.gz");
}

// The extension the payload is written with, which also tells the extract
// stage how to unpack it: dpkg for a `.deb`, its own extraction for an
// `.AppImage`, `tar` for a `.tar.gz`. Any other container is a layout this
// pipeline cannot unpack, so it fails here instead of writing a mislabelled
// file the build would only trip over later.
export function payloadExtension(name: string): string {
  if (name.endsWith(".deb")) return ".deb";
  if (isAppImageAsset(name)) return ".AppImage";
  if (isTarballAsset(name)) return ".tar.gz";
  return fail(`Unsupported release asset, not a .deb, .AppImage or .tar.gz payload: ${name}`);
}

// The electron-builder update yml shipped alongside an AppImage release
// asset, per architecture. Mirrors the electron-feed advisory's layout without
// its feed-redirect step: the tag is already known from the release scan.
export function updateYmlName(architecture: Architecture): string {
  return architecture === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

const MAX_YAML_BYTES = 64 * 1024;

async function fetchUpdateYml(
  downloadBase: string,
  tag: string,
  ymlName: string,
): Promise<string> {
  const { bytes } = await fetchVerified(`${downloadBase}/${tag}/${ymlName}`, {
    allowedHosts: GITHUB_ASSET_HOSTS,
    label: "Feed fetch",
    hostLabel: "feed yml",
    timeoutMs: 30000,
    maxBytes: MAX_YAML_BYTES,
  });
  return bytes.toString("utf8");
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
  const releases = await fetchReleaseList(repository, token);
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

// The arch placeholders an asset name template may use: `{arch}` is the
// pipeline spelling upstreams rarely publish (amd64), `{appimage_arch}` the
// uname-style one they usually do (x86_64, aarch64).
function archValues(architecture: Architecture): Record<string, string> {
  return { arch: architecture, appimage_arch: APPIMAGE_ARCH[architecture] };
}

// Newest non-draft, non-prerelease release whose tag starts with tagPrefix and
// which carries the templated asset for the requested architecture. An arm64
// request against an amd64-only upstream (e.g. wfhelper) scans every
// release and fails with the asset name it never found.
export async function selectTemplatedRelease(
  repository: string,
  assetNameTemplate: string,
  tagPrefix: string,
  architecture: Architecture,
  token: string,
): Promise<TemplatedSelection> {
  const prefix = assertMatches(tagPrefix, SAFE_REFERENCE, "tag prefix");
  if (!hasPlaceholder(assetNameTemplate)) {
    fail(`assetNameTemplate must contain a placeholder: ${assetNameTemplate}`);
  }
  const releases = await fetchReleaseList(repository, token);
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
    const expected = substitutePlaceholders(assetNameTemplate, {
      version,
      ...archValues(architecture),
    });
    const asset = validatedAsset(releaseAssetMap(release).get(expected));
    if (asset === null) continue;
    return { tag, version, asset };
  }
  throw new Error(
    `No GitHub release found carrying ${substitutePlaceholders(assetNameTemplate, archValues(architecture))} with a SHA-256 digest under tag prefix ${prefix}`,
  );
}

interface AppImageResolution {
  outputDir: string;
  metadataPath: string;
  downloadBase: string;
  packageName: string;
  tag: string;
  version: string;
  asset: ReleaseAsset;
  size: number;
}

// AppImage flavor of the templated resolve: the release's update yml supplies
// the SHA-512 and re-states the size, and the GitHub API supplies the SHA-256.
// All three must agree before the payload is trusted.
async function resolveAppImageAsset(
  request: ResolveRequest,
  resolved: AppImageResolution,
): Promise<Metadata> {
  const { outputDir, metadataPath, downloadBase, packageName, tag, version, asset, size } = resolved;
  const ymlName = updateYmlName(request.architecture);
  const yml = parseUpdateYml(await fetchUpdateYml(downloadBase, tag, ymlName), version, asset.name);
  if (yml.size !== size) {
    throw new Error(`Asset size ${size} does not match update yml size ${yml.size}`);
  }
  const packagePath = request.metadataOnly
    ? null
    : path.join(outputDir, `${packageName}_${version}_${request.architecture}.AppImage`);
  const metadata = makeMetadata({
    package: packageName,
    version,
    architecture: request.architecture,
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
      { sha256: asset.digest, sha512: yml.sha512, size },
      { allowedHosts: GITHUB_ASSET_HOSTS, label: path.basename(packagePath) },
    );
  }
  writeMetadata(metadataPath, metadata);
  return metadata;
}

export async function resolveWithGithubRelease(
  advisory: GithubReleaseAdvisory,
  request: ResolveRequest,
): Promise<Metadata> {
  const repository = assertRepositoryUrl(advisory.repository);
  const { outputDir, metadataPath } = prepareOutput(request);
  const architecture = request.architecture;
  const downloadBase = githubDownloadBase(repository);

  if (advisory.assetNameTemplate !== undefined) {
    if (advisory.tagPrefix === undefined || advisory.packageName === undefined) {
      fail("assetNameTemplate requires tagPrefix and packageName");
    }
    const packageName = assertMatches(advisory.packageName, SAFE_REFERENCE, "package name");
    const { tag, version, asset } = await selectTemplatedRelease(
      repository,
      advisory.assetNameTemplate,
      advisory.tagPrefix,
      architecture,
      request.token,
    );
    const size = assertPositiveSize(asset.size, MAX_PAYLOAD_BYTES, `${asset.name} size`);
    // AppImage payloads (e.g. WFHelper) cross-check the release's
    // electron-builder update yml: its SHA-512 and size must agree with the
    // API asset before the payload is trusted, mirroring the electron-feed
    // advisory minus the feed-redirect step.
    const extension = payloadExtension(asset.name);
    if (extension === ".AppImage") {
      return resolveAppImageAsset(
        request,
        { outputDir, metadataPath, downloadBase, packageName, tag, version, asset, size },
      );
    }
    const packagePath = request.metadataOnly
      ? null
      : path.join(outputDir, `${packageName}_${version}_${architecture}${extension}`);
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

  if (advisory.assetPrefix === undefined) fail("github-release advisory requires assetPrefix or assetNameTemplate");
  const assetPrefix = assertMatches(advisory.assetPrefix, SAFE_REFERENCE, "asset prefix");
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
