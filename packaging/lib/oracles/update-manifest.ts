// Update-manifest oracle. A pinned https JSON endpoint is the version source:
// it returns {version, metadata: {files: {<name>: {url, sha256, size}}}}, e.g.
// opencode's v2 desktop update API (GET
// https://opencode.ai/update/api/latest/desktop/opencode). Unlike the CDN
// redirect oracle the manifest publishes the SHA-256 and size the payload is
// verified against, so --metadata-only resolve needs no download.

import * as path from "node:path";
import {
  assertHostAllowed,
  assertHttpsUrl,
  assertPositiveSize,
  assertSafeName,
  assertSha256Hex,
  fail,
  isRecord,
} from "../guards.ts";
import { MAX_PAYLOAD_BYTES, fetchWithRetry, readPayload } from "../http.ts";
import { makeMetadata, writeMetadata } from "../metadata.ts";
import { DEB_VERSION } from "../patterns.ts";
import { substitutePlaceholders } from "../template.ts";
import type { Metadata, UpdateManifestOracle } from "../types.ts";
import { downloadVerified } from "./download.ts";
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

// Parses the update-manifest body and selects the asset named by assetName.
// Every field the pipeline trusts — version, url, host, sha256, size — is
// validated here so an upstream layout change fails loudly instead of
// producing a wrong download. Pure of network side effects for testing.
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
  // The file server pins the exact version in the download path; an entry
  // pointing at a different version fails loudly rather than quietly
  // downgrading or mixing versions.
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

async function fetchManifest(repository: string): Promise<unknown> {
  const response = await fetchWithRetry(repository, { redirect: "follow", timeoutMs: 30000 });
  if (!response.ok) {
    throw new Error(`Update manifest fetch failed (${response.status}) for ${repository}`);
  }
  const bytes = await readPayload(response, MAX_MANIFEST_BYTES);
  return JSON.parse(bytes.toString("utf8"));
}

export async function resolveWithUpdateManifest(
  oracle: UpdateManifestOracle,
  request: ResolveRequest,
): Promise<Metadata> {
  const repository = validateManifestEndpoint(oracle.repository);
  if (oracle.downloadHosts.length === 0) fail("downloadHosts must not be empty");
  for (const host of oracle.downloadHosts) assertSafeName(host, "download host");
  const packageName = assertSafeName(oracle.packageName, "package name");
  if (!oracle.assetTemplate.includes("{arch}")) {
    fail("update-manifest oracle requires an assetTemplate containing {arch}");
  }
  const assetName = substitutePlaceholders(oracle.assetTemplate, {
    arch: request.architecture,
  });
  const { outputDir, metadataPath } = prepareOutput(request);
  const manifest = selectManifestAsset(
    await fetchManifest(repository),
    assetName,
    oracle.downloadHosts,
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
      { allowedHosts: oracle.downloadHosts, label: path.basename(packagePath) },
    );
  }

  writeMetadata(metadataPath, metadata);
  return metadata;
}