// CDN download-redirect oracle. The redirect target is the only version
// source (no signed apt repository, no GitHub release), and the CDN publishes
// no checksums, so the payload is hashed on download. In metadata-only mode
// the payload is still downloaded to compute the SHA-256 but discarded.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertHostAllowed,
  assertMatches,
  assertSafeName,
  assertSha256Hex,
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
import type { Architecture, CdnRedirectOracle, Metadata } from "../types.ts";
import { normalizeUpstreamVersion } from "../version.ts";
import { prepareOutput, type ResolveRequest } from "./shared.ts";

// Assumed upstream URL layout (live-verified 2026-08, both architectures):
//   GET <repository>/<archPath>/deb                    (302 redirect)
//   -> https://releases.gitbutler.com/releases/release/<version>[-<build>]/linux/<archPath>/GitButler_<version>_<debArch>.deb
// parseFinalUrl validates exactly that shape, so an upstream layout change
// fails loudly instead of producing a wrong download.
const ARCH_PATHS: Record<Architecture, { path: string; debArch: Architecture }> = {
  amd64: { path: "x86_64", debArch: "amd64" },
  arm64: { path: "aarch64", debArch: "arm64" },
};

export interface RedirectTarget {
  repository: string;
  repositoryPath: string;
  archPath: string;
  fileName: string;
  fileVersion: string;
  releaseVersion: string;
}

export function parseFinalUrl(finalUrl: string, redirectHosts: readonly string[]): RedirectTarget {
  const url = new URL(finalUrl);
  if (url.protocol !== "https:") {
    fail(`Redirected to non-HTTPS URL (${url.protocol}) for ${finalUrl}`);
  }
  assertHostAllowed(url, redirectHosts, "redirect");
  const segments = url.pathname.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] ?? "";
  const archPath = segments[segments.length - 2] ?? "";
  const release = segments[segments.length - 4] ?? "";
  if (!/^[0-9][0-9A-Za-z.+~]*(?:-[0-9]+)?$/.test(release)) {
    throw new Error(`Unrecognized release segment: ${release}`);
  }
  const fileNameMatch = /^GitButler_(.+)_(amd64|arm64)\.deb$/.exec(fileName);
  if (fileNameMatch === null) throw new Error(`Unrecognized .deb filename: ${fileName}`);
  const fileVersion = assertMatches(
    fileNameMatch[1] ?? "",
    /^[0-9][0-9A-Za-z.+~]*$/,
    ".deb version",
  );
  if (fileVersion !== normalizeUpstreamVersion(release)) {
    throw new Error(`Release version ${release} does not match filename version ${fileVersion}`);
  }
  return {
    repository: url.origin,
    repositoryPath: url.pathname.slice(1),
    archPath,
    fileName,
    fileVersion,
    releaseVersion: release,
  };
}

async function fetchFollowRedirects(
  url: string,
  redirectHosts: readonly string[],
): Promise<Response> {
  const initial = new URL(url);
  if (initial.protocol !== "https:") {
    fail(`Initial URL must be https (got ${initial.protocol}) for ${url}`);
  }
  const response = await fetchWithRetry(url, { redirect: "follow", timeoutMs: 60000 });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload too large (Content-Length ${declaredLength}) for ${url}`);
  }
  assertHostAllowed(new URL(response.url), redirectHosts, "redirect");
  return response;
}

export async function resolveWithCdnRedirect(
  oracle: CdnRedirectOracle,
  request: ResolveRequest,
): Promise<Metadata> {
  const mapping = ARCH_PATHS[request.architecture];
  if (oracle.redirectHosts.length === 0) fail("redirectHosts must not be empty");
  for (const host of oracle.redirectHosts) assertSafeName(host, "redirect host");

  const repositoryUrl = new URL(oracle.repository);
  if (repositoryUrl.protocol !== "https:") {
    fail(`Repository must be https (got ${repositoryUrl.protocol}) for ${oracle.repository}`);
  }
  if (repositoryUrl.search !== "" || repositoryUrl.hash !== "") {
    fail(`Repository must not contain a query or fragment: ${oracle.repository}`);
  }
  const repository = repositoryUrl.origin + repositoryUrl.pathname.replace(/\/+$/, "");
  const { outputDir, metadataPath } = prepareOutput(request);

  const response = await fetchFollowRedirects(
    `${repository}/${mapping.path}/deb`,
    oracle.redirectHosts,
  );
  const parsed = parseFinalUrl(response.url, oracle.redirectHosts);
  if (parsed.archPath !== mapping.path) {
    throw new Error(`Redirect arch ${parsed.archPath} does not match requested ${mapping.path}`);
  }

  const version = normalizeUpstreamVersion(parsed.releaseVersion);
  const bytes = await readPayload(response);
  const sha256 = sha256Digest(bytes).toString("hex");
  const size = bytes.length;
  let packagePath: string | null = null;
  if (!request.metadataOnly) {
    packagePath = path.join(outputDir, `${oracle.debName}_${version}_${mapping.debArch}.deb`);
    writeFileAtomic(packagePath, bytes);
    const onDisk = sha256Digest(fs.readFileSync(packagePath));
    if (!digestMatchesHex(sha256, onDisk)) {
      throw new Error(`Downloaded .deb SHA256 mismatch after write: got ${onDisk.toString("hex")}`);
    }
  }

  const metadata: Metadata = {
    package: oracle.packageName,
    version,
    packageVersion: version,
    architecture: mapping.debArch,
    repositoryPath: parsed.repositoryPath,
    sha256: assertSha256Hex(sha256, ".deb SHA256"),
    size,
    depends: "",
    repository: parsed.repository,
    path: packagePath,
  };
  writeMetadata(metadataPath, metadata);
  return metadata;
}
