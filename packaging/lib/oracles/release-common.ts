// Helpers shared by the GitHub-backed oracles (release assets and the
// electron-updater feed, which cross-checks against the same API).

import { assertMatches } from "../guards.ts";

export function normalizeTagVersion(tag: string): string {
  const version = String(tag).replace(/^v/, "");
  return assertMatches(version, /^[0-9][0-9A-Za-z.+~_-]*$/, "release tag version");
}

// The one shape a GitHub release-asset digest may take. Tested without
// throwing so release scans can skip an asset; parsed to normalize the case.
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/i;

export function isSha256Digest(value: string): boolean {
  return SHA256_DIGEST.test(value);
}

export function parseSha256Digest(digest: string): string {
  const match = SHA256_DIGEST.exec(String(digest));
  if (!match || match[1] === undefined) {
    throw new Error(`Release asset digest is not a sha256 digest: ${digest}`);
  }
  return match[1].toLowerCase();
}
