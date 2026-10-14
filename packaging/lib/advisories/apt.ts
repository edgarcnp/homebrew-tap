// Signed apt repository advisory: pinned key -> InRelease -> Packages SHA-256 ->
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
} from "../core/guards.ts";
import { ChecksumMismatchError, UpstreamConflictError } from "../core/errors.ts";
import { MAX_PAYLOAD_BYTES, writeFileAtomic } from "../core/http.ts";
import {
  assertReleaseFreshness,
  extractClearSignedPayload,
  parseDeb822,
  parseReleaseSha256,
} from "../core/deb822.ts";
import { makeMetadata, writeMetadata } from "../core/metadata.ts";
import { REPO_ROOT } from "../core/paths.ts";
import type { AptAdvisory, Architecture, Metadata } from "../core/types.ts";
import { compareDebVersions, normalizeUpstreamVersion } from "../core/version.ts";
import { fetchVerified, verifyPayload } from "./download.ts";
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
    .map((line) => (line.split(":")[9] ?? "").toUpperCase());
  if (!fingerprints.includes(expectedFingerprint.toUpperCase())) {
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

// The apt repository pins itself: both the index and the payload must stay on
// the host the descriptor named (no edge hosts are allowed).
async function download(url: string, destination: string, timeoutMs = 30000): Promise<void> {
  const requestUrl = assertHttpsUrl(url, "download URL");
  const { bytes } = await fetchVerified(url, {
    allowedHosts: [requestUrl.hostname],
    label: "Download",
    timeoutMs,
  });
  writeFileAtomic(destination, bytes);
}

export function verifyIndexedFile(
  filePath: string,
  expected: { sha256: string; size: number },
  label: string,
): void {
  verifyPayload(fs.readFileSync(filePath), expected, label);
}

// How many times the index pair is read before its disagreement is believed:
// two reads that both contradict the same signed index mean the publisher is in
// flux, and a third would only spend another copy of the index.
const INDEX_PAIR_READS = 2;

export interface IndexedPackagesSource {
  // The index entry the InRelease must name, e.g. "main/binary-amd64/Packages";
  // also the label a mismatch reports.
  readonly relative: string;
  // Downloads the signed InRelease, verifies it against the pinned key and
  // returns the clear-signed payload.
  readonly readRelease: () => Promise<string>;
  // Downloads the file the InRelease indexes; fresh, because the point of a
  // re-read is that the edge may have moved on.
  readonly readPackages: () => Promise<Buffer>;
  // Where the re-read notice goes; defaults to console.warn.
  readonly warn?: (message: string) => void;
}

// The signed index and the file it indexes are two CDN objects with their own
// caches: a mid-republish edge serves an InRelease of one generation with a
// Packages of the previous one, and the size/digest check then fails on bytes
// that were never wrong. So read the pair again, and believe a mismatch only
// when it survives that — a re-read cannot weaken the check, because an
// accepted pair still comes from an InRelease verified against the pinned key.
// What survives is an upstream conflict (transient: the next generation heals
// it), not a checksum failure.
export async function readIndexedPackages(source: IndexedPackagesSource): Promise<Buffer> {
  const warn = source.warn ?? ((message: string) => console.warn(message));
  let mismatch = "";
  for (let read = 1; read <= INDEX_PAIR_READS; read++) {
    const payload = await source.readRelease();
    const indexed = parseReleaseSha256(payload).get(source.relative);
    if (!indexed) throw new Error(`Signed InRelease does not index ${source.relative}`);
    const bytes = await source.readPackages();
    try {
      verifyPayload(bytes, indexed, source.relative);
      return bytes;
    } catch (error) {
      // Only a mismatch earns another read: a transport failure or a guard trip
      // already carries a classification of its own.
      if (!(error instanceof ChecksumMismatchError)) throw error;
      mismatch = error.message;
      if (read < INDEX_PAIR_READS) {
        warn(`${source.relative} disagrees with the signed InRelease (${mismatch}); re-reading the pair`);
      }
    }
  }
  throw new UpstreamConflictError(
    `Upstream served an inconsistent ${source.relative} on ${INDEX_PAIR_READS} reads: ${mismatch}`,
    { reason: "index_generation_mismatch" },
  );
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
    if (!/^pool\/[A-Za-z0-9._+~/-]+\.deb$/.test(filename)) {
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
  const resolvedKey = path.resolve(REPO_ROOT, keyBase64Path);
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
  advisory: AptAdvisory,
  request: ResolveRequest,
): Promise<Metadata> {
  const packageName = assertMatches(
    advisory.packageName,
    /^[a-z0-9][a-z0-9.+_-]*$/,
    "package name",
  );
  const fingerprint = assertMatches(advisory.fingerprint, /^[0-9A-Fa-f]{40}$/, "key fingerprint");
  const repository = String(assertHttpsUrl(advisory.repository, "repository URL")).replace(
    /\/+$/,
    "",
  );
  const suite = assertMatches(advisory.suite ?? "stable", /^[A-Za-z0-9][A-Za-z0-9._-]*$/, "suite");
  const { outputDir, metadataPath } = prepareOutput(request);
  const architecture = request.architecture;

  const keyPath = path.join(outputDir, "repository-key.gpg");
  writeFileAtomic(keyPath, Buffer.from(resolveKeyBase64(advisory.keyBase64Path, outputDir), "base64"));

  const packagesRelative = `main/binary-${architecture}/Packages`;
  const inReleasePath = path.join(outputDir, "InRelease");
  const packagesPath = path.join(outputDir, `Packages.${architecture}`);
  // One read fetches both objects, so a re-read sees one generation or the
  // other and never another mix of the two.
  const packages = await readIndexedPackages({
    relative: packagesRelative,
    readRelease: async () => {
      await download(`${repository}/dists/${suite}/InRelease`, inReleasePath);
      const payload = verifyInRelease(inReleasePath, keyPath, fingerprint);
      assertReleaseFreshness(payload);
      return payload;
    },
    readPackages: async () => {
      await download(`${repository}/dists/${suite}/${packagesRelative}`, packagesPath);
      return fs.readFileSync(packagesPath);
    },
  });
  const selected = selectLatestPackage(packages.toString("utf8"), packageName, architecture);

  let packagePath: string | null = null;
  if (!request.metadataOnly) {
    packagePath = path.join(
      outputDir,
      `${packageName}_${selected.packageVersion}_${architecture}.deb`,
    );
    await download(`${repository}/${selected.repositoryPath}`, packagePath, 60000);
    verifyIndexedFile(packagePath, selected, path.basename(packagePath));
  }

  const metadata = makeMetadata({
    ...selected,
    repository: assertSingleLine(repository, "repository URL"),
    path: packagePath,
  });
  writeMetadata(metadataPath, metadata);
  return metadata;
}
