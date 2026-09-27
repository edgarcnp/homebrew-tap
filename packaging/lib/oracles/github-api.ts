// GitHub REST access shared by the release-asset and electron-feed oracles: the
// repository-URL check, download-base derivation, authenticated JSON fetch and
// release-listing helpers.

import { assertSingleLine, fail, isRecord } from "../core/guards.ts";
import { fetchOnce, httpFailure } from "../core/http.ts";
import { GITHUB_API_REPOSITORY } from "../core/patterns.ts";

export const GITHUB_API_PREFIX = "https://api.github.com/repos/";
export const GITHUB_DOWNLOAD_PREFIX = "https://github.com/";
const RELEASES_PER_PAGE = 100;
// A repo with more than 300 releases is far beyond any app this tap builds;
// the cap keeps a pathological list bounded.
const MAX_RELEASE_PAGES = 3;

export interface RepositoryCoordinates {
  owner: string;
  repo: string;
}

// The one repository URL shape every GitHub oracle pins; anything else could
// point an oracle at an attacker-controlled host.
export function assertRepositoryUrl(repository: string): string {
  const normalized = repository.replace(/\/+$/, "");
  if (!GITHUB_API_REPOSITORY.test(normalized)) {
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

// The release scans must see past the first page: with only the newest page, a
// repo that publishes many releases without the asset (or many prereleases)
// would look like it has no release at all.
export async function fetchReleaseList(
  repository: string,
  token: string,
): Promise<Record<string, unknown>[]> {
  const releases: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const batch = asReleaseList(await githubApiFetch(`${releasesApiUrl(repository)}&page=${page}`, token));
    releases.push(...batch);
    if (batch.length < RELEASES_PER_PAGE) break;
  }
  return releases;
}

export function releaseByTagApiUrl(repository: string, tag: string): string {
  return `${assertRepositoryUrl(repository)}/releases/tags/${encodeURIComponent(tag)}`;
}

// Authenticated api.github.com JSON fetch: the host and redirect policy are
// pinned here, so the API call cannot be redirected elsewhere.
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
  const response = await fetchOnce(url, { headers, redirect: "error", timeoutMs: 30000 });
  if (!response.ok) {
    // A rate-limited 403 or 5xx is the API being busy; a 404 or 401 is not, and
    // must not be dressed up as something to retry.
    throw httpFailure(response, `GitHub API request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

export interface ReleaseAssetRecord {
  name: string;
  digest: string;
  size: number;
}

// A release the pipeline may build from: neither a draft nor a prerelease.
export function isPublishedRelease(release: Record<string, unknown>): boolean {
  return release["draft"] !== true && release["prerelease"] !== true;
}

export function releaseTag(release: Record<string, unknown>): string | undefined {
  const tag = release["tag_name"];
  return typeof tag === "string" ? tag : undefined;
}

// Indexes a release's assets by name, dropping entries missing name/digest/size.
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
