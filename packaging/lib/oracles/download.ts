// The one download path every oracle shares: fetch with retry, enforce the host
// allow-list and size cap, verify the digest(s), write atomically.

import { assertHostAllowed } from "../core/guards.ts";
import {
  MAX_PAYLOAD_BYTES,
  digestMatchesHex,
  fetchWithRetry,
  readPayload,
  sha256Digest,
  sha512Base64,
  writeFileAtomic,
} from "../core/http.ts";

// What the caller knows before downloading. All optional: the CDN oracle has
// no checksum, while the GitHub-backed ones carry a SHA-256 (the electron feed
// also a SHA-512).
export interface PayloadExpectation {
  sha256?: string;
  sha512?: string;
  size?: number;
}

export interface FetchVerifiedOptions {
  // Hosts the request may resolve to, after any redirect.
  allowedHosts: readonly string[];
  // Prefix for error messages, e.g. "gitbutler" or the destination basename.
  label: string;
  // assertHostAllowed's label; defaults to "download".
  hostLabel?: string;
  redirect?: "follow" | "error" | "manual";
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchedPayload {
  bytes: Buffer;
  // Final URL after redirects; the CDN oracle parses it as its version source.
  finalUrl: URL;
}

// Fetches and validates the transport-level invariants: a 2xx response, HTTPS
// after any redirect, an allow-listed host, and a body under the size cap.
export async function fetchVerified(
  url: string,
  options: FetchVerifiedOptions,
): Promise<FetchedPayload> {
  const maxBytes = options.maxBytes ?? MAX_PAYLOAD_BYTES;
  const response = await fetchWithRetry(url, {
    redirect: options.redirect ?? "follow",
    timeoutMs: options.timeoutMs ?? 60000,
  });
  if (!response.ok) {
    throw new Error(`${options.label} download failed (${response.status}) for ${url}`);
  }
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") {
    throw new Error(
      `${options.label} redirected to non-HTTPS URL (${finalUrl.protocol}) for ${url}`,
    );
  }
  assertHostAllowed(finalUrl, options.allowedHosts, options.hostLabel ?? "download");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${options.label} too large (Content-Length ${contentLength}) for ${url}`);
  }
  return { bytes: await readPayload(response, maxBytes), finalUrl };
}

// Verifies against whatever the caller could pin, checking size → SHA-256 →
// SHA-512 so the cheapest failing expectation reports first.
export function verifyPayload(bytes: Buffer, expected: PayloadExpectation, label: string): void {
  if (expected.size !== undefined && bytes.length !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, got ${bytes.length}`);
  }
  if (expected.sha256 !== undefined && !digestMatchesHex(expected.sha256, sha256Digest(bytes))) {
    throw new Error(
      `${label} SHA256 mismatch: expected ${expected.sha256}, got ${sha256Digest(bytes).toString("hex")}`,
    );
  }
  if (expected.sha512 !== undefined && sha512Base64(bytes) !== expected.sha512) {
    throw new Error(`${label} SHA512 mismatch against the upstream update feed`);
  }
}

// The common case: download, verify, write. Bytes are not returned, so a caller
// cannot pin unverified content by accident.
export async function downloadVerified(
  url: string,
  destination: string,
  expected: PayloadExpectation,
  options: FetchVerifiedOptions,
): Promise<void> {
  const { bytes } = await fetchVerified(url, options);
  verifyPayload(bytes, expected, options.label);
  writeFileAtomic(destination, bytes);
}
