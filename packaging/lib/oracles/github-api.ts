// GitHub REST access shared by the release-asset and electron-feed oracles:
// one repository-URL shape check, one download-base derivation, one
// authenticated JSON fetch, and the release-listing helpers both scanning
// oracles use. Keeping them here means host pinning and pagination cannot
// drift between the two resolvers.

import { assertSingleLine, fail } from "../guards.ts";
import { fetchWithRetry } from "../http.ts";

export const GITHUB_API_PREFIX = "https://api.github.com/repos/";
export const GITHUB_DOWNLOAD_PREFIX = "https://github.com/";
const RELEASES_PER_PAGE = 30;

const REPOSITORY_PATTERN =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface RepositoryCoordinates {
  owner: string;
  repo: string;
}

// The API repository URL is the one shape every GitHub-backed oracle pins;
// accepting anything else would let a descriptor point an oracle at an
// attacker-controlled host.
export function assertRepositoryUrl(repository: string): string {
  const normalized = repository.replace(/\/+$/, "");
  if (!REPOSITORY_PATTERN.test(normalized)) {
    fail(`Unsafe GitHub API repository URL: ${repository}`);
  }
  return normalized;
}

export function repositoryCoordinates(repository: string): RepositoryCoordinates {
  const normalized = assertRepositoryUrl(repository);
  const [owner, repo] = normalized.slice(GITHUB_API_PREFIX.length).split("/");
  if (owner === undefined || repo === undefined) {
    fail(`Unsafe GitHub API repository URL: ${repository}`);
  }
  return { owner, repo };
}

// https://api.github.com/repos/<owner>/<repo> -> https://github.com/<owner>/<repo>/releases/download
export function githubDownloadBase(repository: string): string {
  const normalized = assertRepositoryUrl(repository);
  return `${normalized.replace(GITHUB_API_PREFIX, GITHUB_DOWNLOAD_PREFIX)}/releases/download`;
}

export function releasesApiUrl(repository: string): string {
  return `${assertRepositoryUrl(repository)}/releases?per_page=${RELEASES_PER_PAGE}`;
}

export function releaseByTagApiUrl(repository: string, tag: string): string {
  return `${assertRepositoryUrl(repository)}/releases/tags/${encodeURIComponent(tag)}`;
}

// Authenticated api.github.com JSON fetch. Every call site pins the host and
// the redirect policy, so a descriptor cannot redirect the API call elsewhere.
export async function githubApiFetch(url: string, token: string): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") fail(`URL must be https: ${url}`);
  if (parsed.hostname !== "api.github.com") fail(`unexpected host: ${url}`);
  if (parsed.hash !== "") fail(`URL must not contain a fragment: ${url}`);
  const headers: Record<string, string> = {
    "User-Agent": "homebrew-tap-appimage-builder",
    Accept: "application/vnd.github+json",
  };
  if (token !== "") headers["Authorization"] = `Bearer ${assertSingleLine(token, "token")}`;
  const response = await fetchWithRetry(url, { headers, redirect: "error", timeoutMs: 30000 });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

export interface ReleaseAssetRecord {
  name: string;
  digest: string;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A release the pipeline may build from: neither a draft nor a prerelease.
export function isPublishedRelease(release: Record<string, unknown>): boolean {
  return release["draft"] !== true && release["prerelease"] !== true;
}

export function releaseTag(release: Record<string, unknown>): string | undefined {
  const tag = release["tag_name"];
  return typeof tag === "string" ? tag : undefined;
}

// Indexes a release's assets by name, dropping entries without the name,
// digest and size every consumer needs.
export function releaseAssetMap(
  release: Record<string, unknown>,
): Map<string, ReleaseAssetRecord> {
  const byName = new Map<string, ReleaseAssetRecord>();
  const assets = release["assets"];
  if (!Array.isArray(assets)) return byName;
  for (const raw of assets) {
    if (!isRecord(raw)) continue;
    const { name, digest, size } = raw;
    if (typeof name !== "string") continue;
    if (typeof digest !== "string" || typeof size !== "number") continue;
    byName.set(name, { name, digest, size });
  }
  return byName;
}

export function asReleaseList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("GitHub API did not return a release list");
  return value.filter(isRecord);
}
