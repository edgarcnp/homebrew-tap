// Signed apt repository oracle: pinned key -> InRelease -> Packages SHA-256 ->
// package SHA-256/size, picking the newest entry for the requested
// architecture.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertHttpsUrl,
  assertMatches,
  assertPositiveSize,
  assertSha256Hex,
  assertSingleLine,
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
import {
  assertReleaseFreshness,
  extractClearSignedPayload,
  parseDeb822,
  parseReleaseSha256,
} from "../deb822.ts";
import { writeMetadata } from "../metadata.ts";
import { REPO_ROOT } from "../paths.ts";
import type { AptOracle, Architecture, Metadata } from "../types.ts";
import { compareDebVersions, normalizeUpstreamVersion } from "../version.ts";
import { prepareOutput, type ResolveRequest } from "./shared.ts";

const MAX_KEY_BYTES = 1024 * 1024;

export function verifySigningKey(keyPath: string, expectedFingerprint: string): void {
  const result = childProcess.spawnSync(
    "gpg",
    ["--batch", "--show-keys", "--with-colons", keyPath],
    { encoding: "utf8", timeout: 10000, maxBuffer: 1 << 20 },
  );
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new Error("Could not inspect pinned signing key: timed out");
  }
  if (result.status !== 0) {
    throw new Error(`Could not inspect pinned signing key: ${(result.stderr ?? "").trim()}`);
  }
  const fingerprints = (result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9]);
  if (!fingerprints.includes(expectedFingerprint)) {
    throw new Error(
      `Pinned signing key does not contain expected fingerprint ${expectedFingerprint}`,
    );
  }
}

export function verifyInRelease(
  inReleasePath: string,
  keyPath: string,
  expectedFingerprint: string,
): string {
  verifySigningKey(keyPath, expectedFingerprint);
  // gpgv does not enforce pinned-key expiry/revocation; key rotation must be
  // tracked in-repo.
  const result = childProcess.spawnSync("gpgv", ["--keyring", keyPath, inReleasePath], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1 << 20,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new Error("InRelease signature verification failed: timed out");
  }
  if (result.status !== 0) {
    throw new Error(`InRelease signature verification failed: ${(result.stderr ?? "").trim()}`);
  }
  return extractClearSignedPayload(fs.readFileSync(inReleasePath, "utf8"));
}

async function download(url: string, destination: string, timeoutMs = 30000): Promise<void> {
  const requestUrl = assertHttpsUrl(url, "download URL");
  const expectedHost = requestUrl.hostname;
  const response = await fetchWithRetry(url, { redirect: "follow", timeoutMs });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    throw new Error(`Download redirected to non-HTTPS URL (${finalUrl.protocol}) for ${url}`);
  }
  if (finalUrl.hostname !== expectedHost) {
    throw new Error(`Download redirected to unexpected host (${finalUrl.hostname}) for ${url}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload too large (${contentLength} bytes) for ${url}`);
  }
  writeFileAtomic(destination, await readPayload(response));
}

export function verifyIndexedFile(
  filePath: string,
  expected: { sha256: string; size: number },
  label: string,
): void {
  const stat = fs.statSync(filePath);
  if (stat.size !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, got ${stat.size}`);
  }
  const actual = sha256Digest(fs.readFileSync(filePath));
  if (!digestMatchesHex(expected.sha256, actual)) {
    throw new Error(
      `${label} SHA256 mismatch: expected ${expected.sha256}, got ${actual.toString("hex")}`,
    );
  }
}

interface SelectedPackage {
  package: string;
  version: string;
  packageVersion: string;
  architecture: Architecture;
  repositoryPath: string;
  sha256: string;
  size: number;
  depends: string;
}

export function selectLatestPackage(
  source: string,
  packageName: string,
  architecture: Architecture,
): SelectedPackage {
  const entries = parseDeb822(source).filter(
    (entry) => entry["Package"] === packageName && entry["Architecture"] === architecture,
  );
  if (entries.length === 0) {
    throw new Error(`No ${packageName}/${architecture} entry found`);
  }
  for (const entry of entries) {
    if (!/^\d[0-9A-Za-z.+:~-]*$/.test(entry["Version"] ?? "")) {
      throw new Error(`Invalid ${packageName} version in Packages`);
    }
    const filename = entry["Filename"] ?? "";
    if (!/^pool\/[A-Za-z0-9._+/-]+\.deb$/.test(filename)) {
      throw new Error(`Unsafe ${packageName} Filename in Packages`);
    }
    if (filename.includes("..") || filename.startsWith("/")) {
      throw new Error(`Unsafe ${packageName} Filename in Packages`);
    }
    if (!/^[0-9a-f]{64}$/i.test(entry["SHA256"] ?? "")) {
      throw new Error(`Invalid ${packageName} SHA256 in Packages`);
    }
    if (!/^\d+$/.test(entry["Size"] ?? "")) {
      throw new Error(`Invalid ${packageName} Size in Packages`);
    }
  }
  const latest = entries.reduce((best, entry) =>
    compareDebVersions(entry["Version"] ?? "", best["Version"] ?? "") > 0 ? entry : best,
  );
  const version = latest["Version"] ?? "";
  const sha256 = (latest["SHA256"] ?? "").toLowerCase();
  return {
    package: latest["Package"] ?? packageName,
    version: normalizeUpstreamVersion(version),
    packageVersion: version,
    architecture: architecture,
    repositoryPath: latest["Filename"] ?? "",
    sha256: assertSha256Hex(sha256, `${packageName} SHA256`),
    size: assertPositiveSize(Number(latest["Size"]), MAX_PAYLOAD_BYTES, `${packageName} size`),
    depends: latest["Depends"] ?? "",
  };
}

function resolveKeyBase64(keyBase64Path: string, outputDir: string): string {
  const resolvedKey = path.resolve(keyBase64Path);
  const insideOutput =
    resolvedKey === outputDir || resolvedKey.startsWith(outputDir + path.sep);
  const insideRepo = resolvedKey === REPO_ROOT || resolvedKey.startsWith(REPO_ROOT + path.sep);
  if (!insideOutput && !insideRepo) {
    fail("keyBase64Path must be inside outputDir or the tap repository");
  }
  const stat = fs.statSync(resolvedKey);
  if (!stat.isFile()) fail("keyBase64Path is not a regular file");
  if (stat.size > MAX_KEY_BYTES) fail("keyBase64 too large");
  const raw = fs.readFileSync(resolvedKey, "utf8");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) fail("keyBase64 contains invalid characters");
  return raw.replace(/\s+/g, "");
}

export async function resolveWithApt(
  oracle: AptOracle,
  request: ResolveRequest,
): Promise<Metadata> {
  const packageName = assertMatches(
    oracle.packageName,
    /^[a-z0-9][a-z0-9.+_-]*$/,
    "package name",
  );
  const fingerprint = assertMatches(oracle.fingerprint, /^[0-9A-Fa-f]{40}$/, "key fingerprint");
  const repository = String(assertHttpsUrl(oracle.repository, "repository URL")).replace(
    /\/+$/,
    "",
  );
  const { outputDir, metadataPath } = prepareOutput(request);
  const architecture = request.architecture;

  const keyPath = path.join(outputDir, "repository-key.gpg");
  writeFileAtomic(keyPath, Buffer.from(resolveKeyBase64(oracle.keyBase64Path, outputDir), "base64"));

  const inReleasePath = path.join(outputDir, "InRelease");
  await download(`${repository}/dists/stable/InRelease`, inReleasePath);
  const releasePayload = verifyInRelease(inReleasePath, keyPath, fingerprint);
  assertReleaseFreshness(releasePayload);

  const packagesRelative = `main/binary-${architecture}/Packages`;
  const indexedPackages = parseReleaseSha256(releasePayload).get(packagesRelative);
  if (!indexedPackages) {
    throw new Error(`Signed InRelease does not index ${packagesRelative}`);
  }

  const packagesPath = path.join(outputDir, `Packages.${architecture}`);
  await download(`${repository}/dists/stable/${packagesRelative}`, packagesPath);
  verifyIndexedFile(packagesPath, indexedPackages, packagesRelative);
  const selected = selectLatestPackage(
    fs.readFileSync(packagesPath, "utf8"),
    packageName,
    architecture,
  );

  let packagePath: string | null = null;
  if (!request.metadataOnly) {
    packagePath = path.join(
      outputDir,
      `${packageName}_${selected.packageVersion}_${architecture}.deb`,
    );
    await download(`${repository}/${selected.repositoryPath}`, packagePath, 60000);
    verifyIndexedFile(packagePath, selected, path.basename(packagePath));
  }

  const metadata: Metadata = {
    ...selected,
    repository: assertSingleLine(repository, "repository URL"),
    path: packagePath,
  };
  writeMetadata(metadataPath, metadata);
  return metadata;
}
