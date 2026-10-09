// Update-manifest advisory: a pinned https JSON endpoint is the version source
// ({version, metadata: {files: {<name>: {url, sha256, size}}}}), e.g.
// opencode's update API. Unlike cdn-redirect it publishes the digest, so
// --metadata-only resolve needs no download.

import * as path from "node:path";
import {
  assertHostAllowed,
  assertHttpsUrl,
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
import type { Metadata, UpdateManifestAdvisory } from "../core/types.ts";
import { downloadVerified, fetchVerified } from "./download.ts";
import { prepareOutput, type ResolveRequest } from "./shared.ts";

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
// every trusted field (version, url, host, sha256, size). Pure, for testing.
export function selectManifestAsset(
  body: unknown,
  assetName: string,
  downloadHosts: readonly string[],
): SelectedManifest {
  if (!isRecord(body)) fail("Update manifest is not an object");
  const version = body["version"];
  if (typeof version !== "string" || !DEB_VERSION.test(version)) {
    fail(`Update manifest has no sane version: ${String(version)}`);
  }
  const metadata = body["metadata"];
  if (!isRecord(metadata)) fail("Update manifest has no metadata object");
  const files = metadata["files"];
  if (!isRecord(files)) fail("Update manifest has no metadata.files map");
  const entry = files[assetName];
  if (!isRecord(entry)) fail(`Update manifest has no entry for ${assetName}`);
  const rawUrl = entry["url"];
  if (typeof rawUrl !== "string" || rawUrl === "") {
    fail(`Update manifest ${assetName} has no url`);
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
    fail(`Update manifest ${assetName} has no sha256`);
  }
  assertSha256Hex(sha256, `Update manifest ${assetName} sha256`);
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

// Shared with the provider-specific manifest advisories under custom/: fetch
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
  advisory: UpdateManifestAdvisory,
  request: ResolveRequest,
): Promise<Metadata> {
  const repository = validateManifestEndpoint(advisory.repository);
  if (advisory.downloadHosts.length === 0) fail("downloadHosts must not be empty");
  for (const host of advisory.downloadHosts) assertSafeName(host, "download host");
  const packageName = assertSafeName(advisory.packageName, "package name");
  if (!advisory.assetTemplate.includes("{arch}")) {
    fail("update-manifest advisory requires an assetTemplate containing {arch}");
  }
  const assetName = substitutePlaceholders(advisory.assetTemplate, {
    arch: request.architecture,
  });
  const { outputDir, metadataPath } = prepareOutput(request);
  const manifest = selectManifestAsset(
    await fetchManifest(repository),
    assetName,
    advisory.downloadHosts,
  );

  const packagePath = request.metadataOnly
    ? null
    : path.join(outputDir, `${packageName}_${manifest.version}_${request.architecture}.deb`);
  const metadata = makeMetadata({
    package: packageName,
    version: manifest.version,
    architecture: request.architecture,
    repositoryPath: manifest.repositoryPath,
    sha256: manifest.asset.sha256,
    size: manifest.asset.size,
    repository: manifest.repository,
    path: packagePath,
  });

  if (packagePath !== null) {
    await downloadVerified(
      manifest.asset.url,
      packagePath,
      { sha256: manifest.asset.sha256, size: manifest.asset.size },
      { allowedHosts: advisory.downloadHosts, label: path.basename(packagePath) },
    );
  }

  writeMetadata(metadataPath, metadata);
  return metadata;
}