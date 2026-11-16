// JSON-asset artifact: a pinned https update document names the download URL,
// its SHA-256 and its version (VS Code's linux-x64 stable endpoint). The
// document's version must equal the requested version; a missing digest is
// not-ready, so an unverified download can never be staged. The size is
// measured from the verified bytes because the document publishes none.

import * as path from "node:path";
import { ChecksumMismatchError, NotReadyError } from "../core/errors.ts";
import {
  assertHostAllowed,
  assertHttpsUrl,
  assertPositiveSize,
  assertSafeName,
  assertSha256Hex,
  fail,
  isRecord,
} from "../core/guards.ts";
import {
  MAX_PAYLOAD_BYTES,
  digestMatchesHex,
  sha256Digest,
  writeFileAtomic,
} from "../core/http.ts";
import { makeMetadata, writeMetadata } from "../core/metadata.ts";
import type { JsonAssetArtifact, Metadata } from "../core/types.ts";
import { fetchVerified } from "./download.ts";
import {
  isNotFound,
  notReady,
  prepareOutput,
  ready,
  type ResolveOutcome,
  type ResolveRequest,
} from "./shared.ts";

const MAX_DOCUMENT_BYTES = 1024 * 1024;

// A dotted field path: the update document is a flat record in practice, but
// allowing dots keeps the descriptor declarative.
function readField(body: Record<string, unknown>, field: string): unknown {
  let current: unknown = body;
  for (const segment of field.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export interface JsonAssetSelection {
  version: string;
  url: string;
  sha256: string;
}

// Pure selection: binds the document to the requested version and refuses an
// asset without a digest. Missing fields are not-ready; a non-object document
// is a plain failure.
export function selectJsonAsset(
  body: unknown,
  artifact: JsonAssetArtifact,
  requestedVersion: string,
): JsonAssetSelection {
  if (!isRecord(body)) fail("Update document is not an object");
  const version = readField(body, artifact.versionField);
  if (typeof version !== "string" || version === "") {
    throw new NotReadyError(`update document has no ${artifact.versionField}`);
  }
  if (version !== requestedVersion) {
    throw new NotReadyError(`update document publishes ${version}; requested ${requestedVersion}`);
  }
  const rawUrl = readField(body, artifact.urlField);
  if (typeof rawUrl !== "string" || rawUrl === "") {
    throw new NotReadyError(`update document has no ${artifact.urlField}`);
  }
  const rawSha256 = readField(body, artifact.sha256Field);
  if (typeof rawSha256 !== "string" || rawSha256 === "") {
    throw new NotReadyError(`update document has no ${artifact.sha256Field}`);
  }
  return {
    version,
    url: assertHttpsUrl(rawUrl, `update document ${artifact.urlField}`).href,
    sha256: assertSha256Hex(rawSha256, `update document ${artifact.sha256Field}`),
  };
}

export async function resolveWithJsonAsset(
  artifact: JsonAssetArtifact,
  request: ResolveRequest,
): Promise<ResolveOutcome> {
  const endpoint = assertHttpsUrl(artifact.url, "update document endpoint");
  if (artifact.downloadHosts.length === 0) fail("downloadHosts must not be empty");
  for (const host of artifact.downloadHosts) assertSafeName(host, "download host");
  const packageName = assertSafeName(artifact.packageName, "package name");
  const { outputDir, metadataPath } = prepareOutput(request);

  let document: unknown;
  try {
    const { bytes } = await fetchVerified(endpoint.href, {
      allowedHosts: [endpoint.hostname],
      label: "Update document",
      hostLabel: "update document",
      timeoutMs: 30000,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (isNotFound(error)) return notReady(`update document is not published: ${endpoint.href}`);
    throw error;
  }

  let selected: JsonAssetSelection;
  try {
    selected = selectJsonAsset(document, artifact, request.requestedVersion);
  } catch (error) {
    if (error instanceof NotReadyError) return notReady(error.message);
    throw error;
  }
  const assetUrl = assertHttpsUrl(selected.url, "update document asset");
  assertHostAllowed(assetUrl, artifact.downloadHosts, "update document asset");

  const extension = assetUrl.pathname.endsWith(".tar.gz")
    ? ".tar.gz"
    : path.extname(assetUrl.pathname);
  const label = `${packageName}_${selected.version}_${request.architecture}${extension}`;
  let bytes: Buffer;
  try {
    ({ bytes } = await fetchVerified(assetUrl.href, {
      allowedHosts: artifact.downloadHosts,
      label,
      timeoutMs: 60000,
    }));
  } catch (error) {
    if (isNotFound(error)) return notReady(`update document asset is not published: ${assetUrl.href}`);
    throw error;
  }
  const digest = sha256Digest(bytes);
  if (!digestMatchesHex(selected.sha256, digest)) {
    throw new ChecksumMismatchError(
      `${label} SHA256 mismatch: expected ${selected.sha256}, got ${digest.toString("hex")}`,
    );
  }
  const size = assertPositiveSize(bytes.length, MAX_PAYLOAD_BYTES, `${label} size`);
  let packagePath: string | null = null;
  if (!request.metadataOnly) {
    packagePath = path.join(outputDir, label);
    writeFileAtomic(packagePath, bytes);
  }
  const metadata: Metadata = makeMetadata({
    package: packageName,
    version: selected.version,
    architecture: request.architecture,
    repositoryPath: assetUrl.pathname.replace(/^\/+/, ""),
    sha256: selected.sha256,
    size,
    repository: assetUrl.origin,
    path: packagePath,
  });
  writeMetadata(metadataPath, metadata);
  return ready(metadata);
}
