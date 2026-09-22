// Avakot manifest oracle. Provider-specific, so it lives under
// oracles/custom/ rather than with the generic oracles: manifest.json serves
// {version, artifacts: {<name>: {url, sha256, [size], [version]}}} (e.g.
// Little Genius). The download URL is static (no version path segment) and no
// size is published, so the version binds through the per-entry version field
// and the payload is measured from the verified download — downloaded and
// discarded in --metadata-only mode, mirroring the cdn-redirect oracle.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertHostAllowed,
  assertHttpsUrl,
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
import type { AvakotOracle, Metadata } from "../../core/types.ts";
import { fetchVerified } from "../download.ts";
import { prepareOutput, type ResolveRequest } from "../shared.ts";
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

// Parses the manifest and selects the asset named by assetName, validating
// every trusted field (version, url, host, sha256, size). Pure, for testing.
export function selectAvakotAsset(
  body: unknown,
  assetName: string,
  downloadHosts: readonly string[],
): SelectedAvakot {
  if (!isRecord(body)) fail("Avakot manifest is not an object");
  const version = body["version"];
  if (typeof version !== "string" || !DEB_VERSION.test(version)) {
    fail(`Avakot manifest has no sane version: ${String(version)}`);
  }
  const artifacts = body["artifacts"];
  if (!isRecord(artifacts)) fail("Avakot manifest has no artifacts map");
  const entry = artifacts[assetName];
  if (!isRecord(entry)) fail(`Avakot manifest has no entry for ${assetName}`);
  // The download URL is static, so the per-entry version field (when present)
  // is the version binding: it must equal the top-level version.
  const entryVersion = entry["version"];
  if (entryVersion !== undefined) {
    if (typeof entryVersion !== "string" || entryVersion !== version) {
      fail(`Avakot manifest ${assetName} version ${String(entryVersion)} does not match ${version}`);
    }
  }
  const rawUrl = entry["url"];
  if (typeof rawUrl !== "string" || rawUrl === "") {
    fail(`Avakot manifest ${assetName} has no url`);
  }
  const url = assertHttpsUrl(rawUrl, `Avakot manifest ${assetName} url`);
  assertHostAllowed(url, downloadHosts, "update manifest asset");
  // The digest field also accepts the platforms-map alias "deb_sha256".
  const digest = entry["sha256"] ?? entry["deb_sha256"];
  if (typeof digest !== "string" || digest === "") {
    fail(`Avakot manifest ${assetName} has no sha256`);
  }
  assertSha256Hex(digest, `Avakot manifest ${assetName} sha256`);
  const rawSize = entry["size"];
  const asset: AvakotAsset = { url: rawUrl, sha256: digest };
  if (rawSize !== undefined) {
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
  oracle: AvakotOracle,
  request: ResolveRequest,
): Promise<Metadata> {
  const repository = validateManifestEndpoint(oracle.repository);
  if (oracle.downloadHosts.length === 0) fail("downloadHosts must not be empty");
  for (const host of oracle.downloadHosts) assertSafeName(host, "download host");
  const packageName = assertSafeName(oracle.packageName, "package name");
  const assetName = substitutePlaceholders(oracle.assetTemplate, {
    arch: request.architecture,
  });
  const { outputDir, metadataPath } = prepareOutput(request);
  const selected = selectAvakotAsset(
    await fetchManifest(repository),
    assetName,
    oracle.downloadHosts,
  );
  const label = `${packageName}_${selected.version}_${request.architecture}.deb`;
  const { bytes } = await fetchVerified(selected.asset.url, {
    allowedHosts: oracle.downloadHosts,
    label,
    timeoutMs: 60000,
  });
  const digest = sha256Digest(bytes);
  if (!digestMatchesHex(selected.asset.sha256, digest)) {
    throw new Error(`${label} SHA256 mismatch: expected ${selected.asset.sha256}, got ${digest.toString("hex")}`);
  }
  const size = bytes.length;
  assertPositiveSize(size, MAX_PAYLOAD_BYTES, `${label} size`);
  if (selected.asset.size !== undefined && selected.asset.size !== size) {
    throw new Error(
      `${label} size ${size} does not match manifest size ${selected.asset.size}`,
    );
  }
  let packagePath: string | null = null;
  if (!request.metadataOnly) {
    packagePath = path.join(outputDir, label);
    writeFileAtomic(packagePath, bytes);
    const onDisk = sha256Digest(fs.readFileSync(packagePath));
    if (!digestMatchesHex(selected.asset.sha256, onDisk)) {
      throw new Error(`Downloaded .deb SHA256 mismatch after write: got ${onDisk.toString("hex")}`);
    }
  }
  const metadata = makeMetadata({
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
  return metadata;
}
