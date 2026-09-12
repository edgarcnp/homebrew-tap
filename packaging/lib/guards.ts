// Centralized input validation. Every resolver and command validates through
// these helpers so host pinning, path containment and single-line rules cannot
// drift between oracles.

import * as path from "node:path";

export function fail(message: string): never {
  throw new Error(message);
}

// Hosts GitHub serves release assets from. Shared so an oracle cannot forget
// one and fail only when GitHub picks a different edge.
export const GITHUB_ASSET_HOSTS: readonly string[] = [
  "github.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

export function assertSingleLine(value: string, label: string): string {
  if (/[\r\n\u0000]/.test(value)) {
    fail(`${label} must not contain newlines or NUL bytes`);
  }
  return value;
}

export function assertMatches(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) fail(`Invalid ${label}: ${value}`);
  return value;
}

// Package/cask/asset identifiers: no path separators, no leading dash.
export function assertSafeName(value: string, label: string): string {
  return assertMatches(value, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, label);
}

export function assertSha256Hex(value: string, label: string): string {
  return assertMatches(value, /^[0-9a-f]{64}$/, label);
}

export function assertHttpsUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`Invalid ${label}: ${raw}`);
  }
  if (url.protocol !== "https:") {
    fail(`${label} must be https (got ${url.protocol}): ${raw}`);
  }
  if (url.search || url.hash) {
    fail(`${label} must not contain a query or fragment: ${raw}`);
  }
  return url;
}

export function assertHostAllowed(url: URL, allowed: readonly string[], label: string): void {
  if (!allowed.includes(url.hostname)) {
    fail(`Unexpected ${label} host (${url.hostname})`);
  }
}

export function assertInside(child: string, parent: string, label: string): string {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild !== resolvedParent && !resolvedChild.startsWith(resolvedParent + path.sep)) {
    fail(`${label} must be inside ${resolvedParent}`);
  }
  return resolvedChild;
}

export function assertPositiveSize(size: number, max: number, label: string): number {
  if (!Number.isSafeInteger(size) || size <= 0 || size > max) {
    fail(`${label} is not a sane byte count: ${size}`);
  }
  return size;
}

// ELF string tables are position sensitive: a same-length replacement is the
// only safe in-place edit, so every endpoint patch asserts it here.
export function assertSameLength(from: string, to: string, label: string): void {
  if (from.length !== to.length) {
    fail(`${label} patch length mismatch: ${from.length} vs ${to.length}`);
  }
}
