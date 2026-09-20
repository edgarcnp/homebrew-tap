// The one download path every oracle shares: fetch with retry, enforce the
// host allow-list and the size cap, verify the published digest(s), then write
// atomically. Oracles supply only the URL, the expected content and the hosts,
// so host pinning and hashing cannot drift between resolvers.

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

// What the caller knows about the payload before downloading it. Every field
// is optional: the CDN oracle publishes no checksum and only the size is known
// after the fact, while the GitHub-backed oracles carry a SHA-256 (and the
// electron feed a cross-checked SHA-512).
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

// Verifies the payload against whatever the caller could pin. Checks run in a
// fixed order (size, then SHA-256, then SHA-512) so a mismatch reports the
// cheapest failing expectation first.
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

// The common case: download, verify, write. Bytes are never returned, so a
// caller that does not need them cannot accidentally pin unverified content.
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
