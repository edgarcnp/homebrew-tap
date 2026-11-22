// Update-manifest artifact: a pinned https JSON endpoint publishes a version
// and per-asset URL/SHA-256/size, e.g. opencode's update API. The manifest's
// version must equal the requested version; a mismatch, a missing asset or a
// missing digest is not-ready. The manifest publishes the digest, so
// --metadata-only resolve needs no payload download.

import * as path from "node:path";
import { NotReadyError } from "../core/errors.ts";
import {
  assertHostAllowed,
  assertHttpsUrl,
  assertPackageName,
  assertPositiveSize,
  assertSafeName,
  assertSha256Hex,
  fail,
  isRecord,
} from "../core/guards.ts";
import { MAX_PAYLOAD_BYTES } from "../core/http.ts";
import { makeMetadata, writeMetadata } from "../core/metadata.ts";
import { DEB_VERSION } from "../core/patterns.ts";
import { substitutePlaceholders } from "../core/template.ts";
import type { Metadata } from "../core/metadata.ts";
import type { UpdateManifestArtifact } from "../descriptor/artifact.ts";
import { downloadVerified, fetchVerified } from "./download.ts";
import {
  isNotFound,
  notReady,
  prepareOutput,
  ready,
  type ResolveOutcome,
  type ResolveRequest,
} from "./shared.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;

export function validateManifestEndpoint(repository: string): string {
  const url = assertHttpsUrl(repository, "update manifest endpoint");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export interface ManifestAsset {
  url: string;
  sha256: string;
  size: number;
}

export interface SelectedManifest {
  version: string;
  repository: string;
  repositoryPath: string;
  asset: ManifestAsset;
}

// Parses the manifest and selects the asset named by assetName, validating
// every trusted field (version, url, host, sha256, size). A missing or
// mismatched artifact is a typed NotReadyError; a malformed document is a
// plain failure. Pure, for testing.
export function selectManifestAsset(
  body: unknown,
  assetName: string,
  downloadHosts: readonly string[],
  requestedVersion: string,
): SelectedManifest {
  if (!isRecord(body)) fail("Update manifest is not an object");
  const version = body["version"];
  if (typeof version !== "string" || !DEB_VERSION.test(version)) {
    fail(`Update manifest has no sane version: ${String(version)}`);
  }
  if (version !== requestedVersion) {
    throw new NotReadyError(
      `update manifest publishes ${version}; requested ${requestedVersion}`,
    );
  }
  const metadata = body["metadata"];
  if (!isRecord(metadata)) fail("Update manifest has no metadata object");
  const files = metadata["files"];
  if (!isRecord(files)) fail("Update manifest has no metadata.files map");
  const entry = files[assetName];
  if (!isRecord(entry)) {
    throw new NotReadyError(`update manifest has no entry for ${assetName}`);
  }
  const rawUrl = entry["url"];
  if (typeof rawUrl !== "string" || rawUrl === "") {
    throw new NotReadyError(`update manifest ${assetName} has no url`);
  }
  const url = assertHttpsUrl(rawUrl, `Update manifest ${assetName} url`);
  assertHostAllowed(url, downloadHosts, "update manifest asset");
  // The file server pins the version in the path; an entry for another version
  // fails loudly instead of silently downgrading or mixing versions.
  if (!url.pathname.split("/").includes(version)) {
    fail(`Update manifest ${assetName} url does not carry version ${version}: ${rawUrl}`);
  }
  const sha256 = entry["sha256"];
  if (typeof sha256 !== "string" || sha256 === "") {
    throw new NotReadyError(`update manifest ${assetName} has no sha256`);
  }
  assertSha256Hex(sha256, `Update manifest ${assetName} sha256`);
  if (entry["size"] === undefined) {
    throw new NotReadyError(`update manifest ${assetName} has no size`);
  }
  const size = assertPositiveSize(
    entry["size"] as number,
    MAX_PAYLOAD_BYTES,
    `Update manifest ${assetName} size`,
  );
  return {
    version,
    repository: url.origin,
    repositoryPath: url.pathname.replace(/^\/+/, ""),
    asset: { url: rawUrl, sha256, size },
  };
}

// Shared with the provider-specific manifest artifacts under custom/: fetch
// and parse a pinned JSON manifest with the same size cap. The manifest is the
// version and digest trust root, so fetchVerified pins the final URL after any
// redirect to the host the descriptor declared.
export async function fetchManifest(repository: string): Promise<unknown> {
  const { bytes } = await fetchVerified(repository, {
    allowedHosts: [new URL(repository).hostname],
    label: "Update manifest",
    hostLabel: "manifest",
    timeoutMs: 30000,
    maxBytes: MAX_MANIFEST_BYTES,
  });
  return JSON.parse(bytes.toString("utf8"));
}

export async function resolveWithUpdateManifest(
  artifact: UpdateManifestArtifact,
  request: ResolveRequest,
): Promise<ResolveOutcome> {
  const repository = validateManifestEndpoint(artifact.repository);
  if (artifact.downloadHosts.length === 0) fail("downloadHosts must not be empty");
  for (const host of artifact.downloadHosts) assertSafeName(host, "download host");
  const packageName = assertPackageName(artifact.packageName, "package name");
  if (!artifact.assetTemplate.includes("{arch}")) {
    fail("update-manifest artifact requires an assetTemplate containing {arch}");
  }
  const assetName = substitutePlaceholders(artifact.assetTemplate, {
    arch: request.architecture,
  });
  const { outputDir, metadataPath } = prepareOutput(request);
  let selected: SelectedManifest;
  try {
    selected = selectManifestAsset(
      await fetchManifest(repository),
      assetName,
      artifact.downloadHosts,
      request.requestedVersion,
    );
  } catch (error) {
    if (error instanceof NotReadyError) return notReady(error.message);
    throw error;
  }

  const packagePath = request.metadataOnly
    ? null
    : path.join(outputDir, `${packageName}_${selected.version}_${request.architecture}.deb`);
  const metadata: Metadata = makeMetadata({
    package: packageName,
    version: selected.version,
    architecture: request.architecture,
    repositoryPath: selected.repositoryPath,
    sha256: selected.asset.sha256,
    size: selected.asset.size,
    repository: selected.repository,
    path: packagePath,
  });

  if (packagePath !== null) {
    try {
      await downloadVerified(
        selected.asset.url,
        packagePath,
        { sha256: selected.asset.sha256, size: selected.asset.size },
        { allowedHosts: artifact.downloadHosts, label: path.basename(packagePath) },
      );
    } catch (error) {
      if (isNotFound(error)) return notReady(`update manifest asset ${assetName} is not available`);
      throw error;
    }
  }

  writeMetadata(metadataPath, metadata);
  return ready(metadata);
}
