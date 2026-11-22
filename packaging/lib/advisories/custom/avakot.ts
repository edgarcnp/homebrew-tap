// Avakot manifest artifact. Provider-specific, so it lives under
// advisories/custom/ rather than with the generic artifacts: manifest.json
// serves {version, artifacts: {<name>: {url, sha256, [size], [version]}}} (e.g.
// Little Genius). The manifest's version and the per-entry version must both
// equal the requested version. The download URL is static (no version path
// segment) and no size is published, so the payload is measured from the
// verified download — downloaded and discarded in --metadata-only mode.

import * as fs from "node:fs";
import * as path from "node:path";
import { ChecksumMismatchError, NotReadyError } from "../../core/errors.ts";
import {
  assertHostAllowed,
  assertHttpsUrl,
  assertPackageName,
  assertPositiveSize,
  assertSafeName,
  assertSha256Hex,
  fail,
  isRecord,
} from "../../core/guards.ts";
import {
  MAX_PAYLOAD_BYTES,
  digestMatchesHex,
  sha256Digest,
  writeFileAtomic,
} from "../../core/http.ts";
import { makeMetadata, writeMetadata } from "../../core/metadata.ts";
import { DEB_VERSION } from "../../core/patterns.ts";
import { substitutePlaceholders } from "../../core/template.ts";
import type { Metadata } from "../../core/metadata.ts";
import type { AvakotArtifact } from "../../descriptor/artifact.ts";
import { fetchVerified } from "../download.ts";
import {
  isNotFound,
  notReady,
  prepareOutput,
  ready,
  type ResolveOutcome,
  type ResolveRequest,
} from "../shared.ts";
import { fetchManifest, validateManifestEndpoint } from "../update-manifest.ts";

export interface AvakotAsset {
  url: string;
  sha256: string;
  // Absent when the manifest publishes no size: resolve measures the download.
  size?: number;
}

export interface SelectedAvakot {
  version: string;
  repository: string;
  repositoryPath: string;
  asset: AvakotAsset;
}

// Parses the manifest and selects the asset named by assetName. A missing or
// mismatched artifact is a typed NotReadyError; a malformed document is a plain
// failure. Pure, for testing.
export function selectAvakotAsset(
  body: unknown,
  assetName: string,
  downloadHosts: readonly string[],
  requestedVersion: string,
): SelectedAvakot {
  if (!isRecord(body)) fail("Avakot manifest is not an object");
  const version = body["version"];
  if (typeof version !== "string" || !DEB_VERSION.test(version)) {
    fail(`Avakot manifest has no sane version: ${String(version)}`);
  }
  if (version !== requestedVersion) {
    throw new NotReadyError(`avakot manifest publishes ${version}; requested ${requestedVersion}`);
  }
  const artifacts = body["artifacts"];
  if (!isRecord(artifacts)) fail("Avakot manifest has no artifacts map");
  const entry = artifacts[assetName];
  if (!isRecord(entry)) {
    throw new NotReadyError(`avakot manifest has no entry for ${assetName}`);
  }
  // The download URL is static, so the per-entry version is the version
  // binding and is required: without it the manifest's version claim is not
  // bound to the payload at all.
  const entryVersion = entry["version"];
  if (typeof entryVersion !== "string" || entryVersion !== version) {
    throw new NotReadyError(
      `avakot manifest ${assetName} version ${String(entryVersion)} does not match ${version}`,
    );
  }
  const rawUrl = entry["url"];
  if (typeof rawUrl !== "string" || rawUrl === "") {
    throw new NotReadyError(`avakot manifest ${assetName} has no url`);
  }
  const url = assertHttpsUrl(rawUrl, `Avakot manifest ${assetName} url`);
  assertHostAllowed(url, downloadHosts, "update manifest asset");
  // The digest field also accepts the platforms-map alias "deb_sha256".
  const digest = entry["sha256"] ?? entry["deb_sha256"];
  if (typeof digest !== "string" || digest === "") {
    throw new NotReadyError(`avakot manifest ${assetName} has no sha256`);
  }
  assertSha256Hex(digest, `Avakot manifest ${assetName} sha256`);
  const rawSize = entry["size"];
  const asset: AvakotAsset = { url: rawUrl, sha256: digest };
  if (rawSize !== undefined && rawSize !== null) {
    asset.size = assertPositiveSize(
      rawSize as number,
      MAX_PAYLOAD_BYTES,
      `Avakot manifest ${assetName} size`,
    );
  }
  return {
    version,
    repository: url.origin,
    repositoryPath: url.pathname.replace(/^\/+/, ""),
    asset,
  };
}

export async function resolveWithAvakot(
  artifact: AvakotArtifact,
  request: ResolveRequest,
): Promise<ResolveOutcome> {
  const repository = validateManifestEndpoint(artifact.repository);
  if (artifact.downloadHosts.length === 0) fail("downloadHosts must not be empty");
  for (const host of artifact.downloadHosts) assertSafeName(host, "download host");
  const packageName = assertPackageName(artifact.packageName, "package name");
  const assetName = substitutePlaceholders(artifact.assetTemplate, {
    arch: request.architecture,
  });
  const { outputDir, metadataPath } = prepareOutput(request);
  let selected: SelectedAvakot;
  try {
    selected = selectAvakotAsset(
      await fetchManifest(repository),
      assetName,
      artifact.downloadHosts,
      request.requestedVersion,
    );
  } catch (error) {
    if (error instanceof NotReadyError) return notReady(error.message);
    throw error;
  }
  const label = `${packageName}_${selected.version}_${request.architecture}.deb`;
  let bytes: Buffer;
  try {
    ({ bytes } = await fetchVerified(selected.asset.url, {
      allowedHosts: artifact.downloadHosts,
      label,
      timeoutMs: 60000,
    }));
  } catch (error) {
    if (isNotFound(error)) return notReady(`avakot asset ${assetName} is not available`);
    throw error;
  }
  const digest = sha256Digest(bytes);
  if (!digestMatchesHex(selected.asset.sha256, digest)) {
    throw new ChecksumMismatchError(
      `${label} SHA256 mismatch: expected ${selected.asset.sha256}, got ${digest.toString("hex")}`,
    );
  }
  const size = bytes.length;
  assertPositiveSize(size, MAX_PAYLOAD_BYTES, `${label} size`);
  if (selected.asset.size !== undefined && selected.asset.size !== size) {
    throw new ChecksumMismatchError(
      `${label} size ${size} does not match manifest size ${selected.asset.size}`,
    );
  }
  let packagePath: string | null = null;
  if (!request.metadataOnly) {
    packagePath = path.join(outputDir, label);
    writeFileAtomic(packagePath, bytes);
    const onDisk = sha256Digest(fs.readFileSync(packagePath));
    if (!digestMatchesHex(selected.asset.sha256, onDisk)) {
      throw new ChecksumMismatchError(
        `Downloaded .deb SHA256 mismatch after write: got ${onDisk.toString("hex")}`,
      );
    }
  }
  const metadata: Metadata = makeMetadata({
    package: packageName,
    version: selected.version,
    architecture: request.architecture,
    repositoryPath: selected.repositoryPath,
    sha256: assertSha256Hex(selected.asset.sha256, ".deb SHA256"),
    size,
    repository: selected.repository,
    path: packagePath,
  });
  writeMetadata(metadataPath, metadata);
  return ready(metadata);
}
