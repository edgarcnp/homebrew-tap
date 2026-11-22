// Mozilla release artifact: the release tarball plus its detached `.asc`
// signature, verified against a pinned release key before the bytes are
// hashed. There is no package index and no .deb in this path. A missing
// tarball or signature, or a signature that does not verify, is not-ready:
// the release the API asked for is not published in a trustworthy form yet.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertHttpsUrl,
  assertMatches,
  assertPackageName,
  assertPositiveSize,
  assertSha256Hex,
  fail,
} from "../core/guards.ts";
import { MAX_PAYLOAD_BYTES, sha256Hex, writeFileAtomic } from "../core/http.ts";
import { makeMetadata, writeMetadata } from "../core/metadata.ts";
import { REPO_ROOT } from "../core/paths.ts";
import { substitutePlaceholders } from "../core/template.ts";
import type { Architecture } from "../core/architecture.ts";
import type { Metadata } from "../core/metadata.ts";
import type { MozillaReleaseArtifact } from "../descriptor/artifact.ts";
import { fetchVerified } from "./download.ts";
import {
  isNotFound,
  notReady,
  prepareOutput,
  ready,
  type ResolveOutcome,
  type ResolveRequest,
} from "./shared.ts";

const MAX_KEY_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;

// The signature does not verify over the bytes: a release problem, which the
// resolver reports as not-ready. A missing tool or a pinned-key mismatch stays
// a plain Error (a repository/toolchain failure), so it is never mistaken for
// "the vendor has not published it yet".
export class SignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureVerificationError";
  }
}

function resolveKeyPath(keyPath: string): string {
  const resolved = path.resolve(REPO_ROOT, keyPath);
  if (resolved !== REPO_ROOT && !resolved.startsWith(REPO_ROOT + path.sep)) {
    fail(`release key path must be inside the tap repository: ${keyPath}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) fail(`release key is not a regular file: ${keyPath}`);
  if (stat.size > MAX_KEY_BYTES) fail(`release key is too large: ${keyPath}`);
  return resolved;
}

// gpg --show-keys lists every fingerprint in the file (primary and subkeys).
// Pinning any of them is deliberate: a key rotation must be a repository
// change, not something an upstream can do silently.
export function verifySigningKey(keyPath: string, expectedFingerprint: string): void {
  const result = childProcess.spawnSync(
    "gpg",
    ["--batch", "--show-keys", "--with-colons", keyPath],
    { encoding: "utf8", timeout: 10000, maxBuffer: MAX_KEY_BYTES },
  );
  if (result.error !== undefined) {
    throw new Error(`Could not inspect pinned signing key: ${result.error.message}`);
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

// gpgv needs a keyring, not an armored key file: dearmor when necessary.
function keyringFor(keyPath: string, outputDir: string): string {
  const raw = fs.readFileSync(keyPath);
  const armored = raw.subarray(0, 64).toString("utf8").includes("BEGIN PGP PUBLIC KEY BLOCK");
  const keyringPath = path.join(outputDir, "release-key.gpg");
  if (!armored) {
    writeFileAtomic(keyringPath, raw);
    return keyringPath;
  }
  const result = childProcess.spawnSync("gpg", ["--batch", "--dearmor"], {
    input: raw,
    timeout: 10000,
    maxBuffer: MAX_KEY_BYTES,
  });
  if (result.error !== undefined) {
    throw new Error(`Could not dearmor the pinned signing key: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Could not dearmor the pinned signing key: ${(result.stderr ?? "").toString().trim()}`);
  }
  writeFileAtomic(keyringPath, result.stdout);
  return keyringPath;
}

export function verifyDetachedSignature(
  dataPath: string,
  signaturePath: string,
  keyPath: string,
  expectedFingerprint: string,
  outputDir: string,
): void {
  verifySigningKey(keyPath, expectedFingerprint);
  const keyringPath = keyringFor(keyPath, outputDir);
  // gpgv does not enforce pinned-key expiry/revocation; key rotation must be
  // tracked in-repo.
  const result = childProcess.spawnSync(
    "gpgv",
    ["--keyring", keyringPath, signaturePath, dataPath],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1 << 20 },
  );
  if (result.error !== undefined) {
    throw new Error(`Release signature verification failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new SignatureVerificationError(
      `Release signature verification failed: ${(result.stderr ?? "").trim()}`,
    );
  }
}

function archValues(architecture: Architecture): Record<string, string> {
  return { arch: architecture, appimage_arch: architecture === "arm64" ? "aarch64" : "x86_64" };
}

export async function resolveWithMozillaRelease(
  artifact: MozillaReleaseArtifact,
  request: ResolveRequest,
): Promise<ResolveOutcome> {
  const packageName = assertPackageName(artifact.packageName, "package name");
  const fingerprint = assertMatches(artifact.fingerprint, /^[0-9A-Fa-f]{40}$/, "key fingerprint");
  const keyPath = resolveKeyPath(artifact.keyPath);
  // Fail fast on a key that does not match the pin, before any download.
  verifySigningKey(keyPath, fingerprint);
  const { outputDir, metadataPath } = prepareOutput(request);
  const values = { version: request.requestedVersion, ...archValues(request.architecture) };
  const url = assertHttpsUrl(
    substitutePlaceholders(artifact.urlTemplate, values),
    "release tarball URL",
  );
  const signatureUrl = assertHttpsUrl(
    substitutePlaceholders(artifact.signatureTemplate, { ...values, url: url.href }),
    "release signature URL",
  );
  if (signatureUrl.hostname !== url.hostname) {
    fail(
      `release signature host ${signatureUrl.hostname} does not match the tarball host ${url.hostname}`,
    );
  }
  const allowedHosts = [url.hostname];

  let signature: Buffer;
  let bytes: Buffer;
  try {
    ({ bytes: signature } = await fetchVerified(signatureUrl.href, {
      allowedHosts,
      label: "Release signature",
      hostLabel: "release signature",
      timeoutMs: 30000,
      maxBytes: MAX_SIGNATURE_BYTES,
    }));
    ({ bytes } = await fetchVerified(url.href, {
      allowedHosts,
      label: "Release tarball",
      hostLabel: "release tarball",
      timeoutMs: 60000,
    }));
  } catch (error) {
    if (isNotFound(error)) {
      return notReady(`no published release tarball or signature for ${request.requestedVersion}`);
    }
    throw error;
  }

  const extension = url.pathname.endsWith(".tar.xz")
    ? ".tar.xz"
    : path.extname(url.pathname);
  const payloadPath = path.join(
    outputDir,
    `${packageName}_${request.requestedVersion}_${request.architecture}${extension}`,
  );
  // Per-arch: two resolves into one output directory (a dual-arch build) must
  // not overwrite each other's signature before verification.
  const signaturePath = path.join(
    outputDir,
    `${packageName}_${request.requestedVersion}_${request.architecture}.sig`,
  );
  writeFileAtomic(signaturePath, signature);
  writeFileAtomic(payloadPath, bytes);
  try {
    verifyDetachedSignature(payloadPath, signaturePath, keyPath, fingerprint, outputDir);
  } catch (error) {
    // An unverifiable release is not ready, not a failure. A missing tool or a
    // key that does not match the pin stays a failure.
    if (error instanceof SignatureVerificationError) return notReady(error.message);
    throw error;
  } finally {
    fs.rmSync(signaturePath, { force: true });
  }

  const size = assertPositiveSize(bytes.length, MAX_PAYLOAD_BYTES, "release tarball size");
  const sha256 = assertSha256Hex(sha256Hex(bytes), "release tarball sha256");
  let packagePath: string | null = payloadPath;
  if (request.metadataOnly) {
    fs.rmSync(payloadPath, { force: true });
    packagePath = null;
  }
  const metadata: Metadata = makeMetadata({
    package: packageName,
    version: request.requestedVersion,
    architecture: request.architecture,
    repositoryPath: url.pathname.replace(/^\/+/, ""),
    sha256,
    size,
    repository: url.origin,
    path: packagePath,
  });
  writeMetadata(metadataPath, metadata);
  return ready(metadata);
}
