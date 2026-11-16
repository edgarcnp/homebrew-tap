// GitHub release artifact: the requested version selects the release whose tag
// normalizes to it, then the declared asset for the architecture. A missing
// tag, asset or digest is not-ready, never a silent fallback to another
// release. The asset name is a template (`{version}`, `{arch}`,
// `{appimage_arch}`); an `.AppImage` additionally cross-checks the release's
// electron-builder update yml (SHA-512 + size) before downloading, and every
// other container is verified by the release's published SHA-256.

import * as path from "node:path";
import { APPIMAGE_ARCH } from "../core/architecture.ts";
import { NotReadyError, UpstreamConflictError } from "../core/errors.ts";
import { GITHUB_ASSET_HOSTS, assertMatches, assertPositiveSize, fail } from "../core/guards.ts";
import { MAX_PAYLOAD_BYTES } from "../core/http.ts";
import { makeMetadata, writeMetadata } from "../core/metadata.ts";
import { DEB_VERSION, SAFE_REFERENCE } from "../core/patterns.ts";
import { hasPlaceholder, substitutePlaceholders } from "../core/template.ts";
import type { Architecture, GithubReleaseArtifact, Metadata } from "../core/types.ts";
import { downloadVerified, fetchVerified } from "./download.ts";
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
import { isNotFound, notReady, prepareOutput, ready, type ResolveOutcome, type ResolveRequest } from "./shared.ts";
import { parseUpdateYml } from "./update-yml.ts";

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

// The extension the payload is written with, which also tells the extract
// stage how to unpack it: dpkg for a `.deb`, its own extraction for an
// `.AppImage`, `tar` for a tarball. Any other container is a layout this
// pipeline cannot unpack, so it fails here instead of writing a mislabelled
// file the build would only trip over later.
export function payloadExtension(name: string): string {
  if (name.endsWith(".deb")) return ".deb";
  if (isAppImageAsset(name)) return ".AppImage";
  if (name.endsWith(".tar.gz")) return ".tar.gz";
  if (name.endsWith(".tar.xz")) return ".tar.xz";
  return fail(`Unsupported release asset, not a .deb, .AppImage or tarball payload: ${name}`);
}

// The electron-builder update yml shipped alongside an AppImage release
// asset, per architecture.
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

export interface ReleaseSelection {
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

// The one release whose tag normalizes to the requested version, carrying the
// templated asset for the requested architecture. Every other release is
// irrelevant: no resolver here selects "the newest".
export async function selectRelease(
  repository: string,
  assetNameTemplate: string,
  tagPrefix: string,
  requestedVersion: string,
  architecture: Architecture,
  token: string,
): Promise<ReleaseSelection> {
  const prefix = assertMatches(tagPrefix, SAFE_REFERENCE, "tag prefix");
  const requested = assertMatches(requestedVersion, DEB_VERSION, "requested version");
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
    if (version !== requested) continue;
    const expected = substitutePlaceholders(assetNameTemplate, {
      version,
      ...archValues(architecture),
    });
    const asset = validatedAsset(releaseAssetMap(release).get(expected));
    if (asset === null) {
      throw new NotReadyError(`release ${tag} has no ${expected} with a SHA-256 digest`);
    }
    return { tag, version, asset };
  }
  throw new NotReadyError(`no published release carries ${prefix}${requested}`);
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

// AppImage flavor: the release's update yml supplies the SHA-512 and restates
// the size, and the GitHub API supplies the SHA-256. All three must agree
// before the payload is trusted.
async function resolveAppImageAsset(
  request: ResolveRequest,
  resolved: AppImageResolution,
): Promise<Metadata> {
  const { outputDir, metadataPath, downloadBase, packageName, tag, version, asset, size } = resolved;
  const ymlName = updateYmlName(request.architecture);
  let ymlBody: string;
  try {
    ymlBody = await fetchUpdateYml(downloadBase, tag, ymlName);
  } catch (error) {
    if (isNotFound(error)) {
      throw new NotReadyError(`release ${tag} has no ${ymlName}`);
    }
    throw error;
  }
  const yml = parseUpdateYml(ymlBody, version, asset.name);
  if (yml.size !== size) {
    throw new UpstreamConflictError(
      `Asset size ${size} does not match update yml size ${yml.size}`,
      { reason: "release_asset_size_mismatch" },
    );
  }
  const packagePath = request.metadataOnly
    ? null
    : path.join(outputDir, `${packageName}_${version}_${request.architecture}${payloadExtension(asset.name)}`);
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
    try {
      await downloadVerified(
        `${downloadBase}/${metadata.repositoryPath}`,
        packagePath,
        { sha256: asset.digest, sha512: yml.sha512, size },
        { allowedHosts: GITHUB_ASSET_HOSTS, label: path.basename(packagePath) },
      );
    } catch (error) {
      if (isNotFound(error)) throw new NotReadyError(`release asset ${asset.name} is not available`);
      throw error;
    }
  }
  writeMetadata(metadataPath, metadata);
  return metadata;
}

async function downloadAsset(
  url: string,
  packagePath: string,
  asset: ReleaseAsset,
): Promise<void> {
  try {
    await downloadVerified(
      url,
      packagePath,
      { sha256: asset.digest, size: asset.size },
      { allowedHosts: GITHUB_ASSET_HOSTS, label: path.basename(packagePath) },
    );
  } catch (error) {
    if (isNotFound(error)) throw new NotReadyError(`release asset ${asset.name} is not available`);
    throw error;
  }
}

export async function resolveWithGithubRelease(
  artifact: GithubReleaseArtifact,
  request: ResolveRequest,
): Promise<ResolveOutcome> {
  const repository = assertRepositoryUrl(artifact.repository);
  const { outputDir, metadataPath } = prepareOutput(request);
  const architecture = request.architecture;
  const downloadBase = githubDownloadBase(repository);
  const version = request.requestedVersion;
  const packageName = assertMatches(artifact.packageName, SAFE_REFERENCE, "package name");

  let selection: ReleaseSelection;
  try {
    selection = await selectRelease(
      repository,
      artifact.assetNameTemplate,
      artifact.tagPrefix,
      version,
      architecture,
      request.token,
    );
  } catch (error) {
    if (error instanceof NotReadyError) return notReady(error.message);
    throw error;
  }
  const { tag, asset } = selection;
  const size = assertPositiveSize(asset.size, MAX_PAYLOAD_BYTES, `${asset.name} size`);
  const extension = payloadExtension(asset.name);
  if (extension === ".AppImage") {
    try {
      return ready(
        await resolveAppImageAsset(request, {
          outputDir,
          metadataPath,
          downloadBase,
          packageName,
          tag,
          version,
          asset,
          size,
        }),
      );
    } catch (error) {
      if (error instanceof NotReadyError) return notReady(error.message);
      throw error;
    }
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
    try {
      await downloadAsset(`${downloadBase}/${metadata.repositoryPath}`, packagePath, asset);
    } catch (error) {
      if (error instanceof NotReadyError) return notReady(error.message);
      throw error;
    }
  }
  writeMetadata(metadataPath, metadata);
  return ready(metadata);
}
