// The release-feed cross-check. The API's watcher dispatches a build off the
// feed a descriptor declares in `watch`, while `resolve` asks a different
// source (the oracle) which version to build. The two publish on their own
// schedules, so a run can land in the window where the feed already lists the
// new version and the oracle still serves the old one: gating on that stale
// read skips a build that is already due, and nothing retries it. This module
// reads the feed and decides whether to hold the run until the oracle agrees.

import { assertHttpsUrl, fail, isRecord } from "../core/guards.ts";
import { fetchWithRetry, readPayload } from "../core/http.ts";
import { DEB_VERSION } from "../core/patterns.ts";
import type { WatchConfig } from "../core/types.ts";
import { compareDebVersions, parseDebVersion } from "../core/version.ts";
import { isNewer } from "./gate.ts";

// Feeds are a few hundred entries of text; the cap keeps a runaway response
// from being read into memory whole.
const MAX_FEED_BYTES = 1024 * 1024;

// Text out of an XML element: CDATA unwrapped, then the character references a
// release title can legally carry. Numeric references resolve before the named
// ones so `&amp;lt;` decodes to the literal "&lt;" rather than to "<".
function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Entry titles only. The feed's own <title> is a label ("Release notes from
// ..."), never a version, so an unanchored pattern must not see it.
export function atomEntryTitles(xml: string): string[] {
  const titles: string[] = [];
  for (const entry of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(entry[1] ?? "");
    if (title?.[1] !== undefined) titles.push(decodeXmlText(title[1].trim()));
  }
  return titles;
}

// One dotted path step at a time; anything short of a string is "not there".
function dottedField(value: unknown, path: string): string | undefined {
  let current = value;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

// A feed entry is only a candidate when both the version charset and dpkg's
// own grammar accept it. An entry we cannot order is one we must not wait for
// — and, since a selected version is echoed into workflow annotations and
// parsed back out by the shell, one whose bytes must never get that far.
function comparableVersion(value: string | undefined): string | null {
  if (value === undefined || !DEB_VERSION.test(value)) return null;
  try {
    parseDebVersion(value);
  } catch {
    return null;
  }
  return value;
}

// Pure: the newest version a watch config matches in a feed body, or null when
// nothing matches (an unwatched app, an all-prerelease feed, a bad pattern).
// Newest means newest by dpkg ordering, not first in feed order: feeds sort by
// release date, where a backport of an older major line sits above a newer one.
export function selectFeedVersion(watch: WatchConfig, body: string): string | null {
  const raw: string[] = [];
  if (watch.format === "json") {
    if (watch.versionField === undefined) fail(`${watch.feedUrl}: json feed needs versionField`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      fail(`Release feed is not valid JSON: ${watch.feedUrl}`);
    }
    const value = dottedField(parsed, watch.versionField);
    if (value !== undefined) raw.push(value);
  } else {
    raw.push(...atomEntryTitles(body));
  }
  const skip = watch.skipPattern === undefined ? undefined : new RegExp(watch.skipPattern);
  const version = new RegExp(watch.versionPattern);
  let newest: string | null = null;
  for (const candidate of raw) {
    if (skip?.test(candidate) === true) continue;
    const hit = comparableVersion(version.exec(candidate)?.[1]);
    if (hit === null) continue;
    if (newest === null || compareDebVersions(hit, newest) > 0) newest = hit;
  }
  return newest;
}

// Fetches the descriptor's feed and selects its newest version. Throws on an
// unreachable, non-2xx or oversized feed: the caller decides whether that is
// fatal (the workflow treats the cross-check as advisory and warns instead).
export async function fetchFeedVersion(watch: WatchConfig): Promise<string | null> {
  const url = assertHttpsUrl(watch.feedUrl, "release feed");
  const response = await fetchWithRetry(url, { redirect: "follow", timeoutMs: 30000 });
  if (!response.ok) {
    throw new Error(`Release feed fetch failed (${response.status}) for ${url}`);
  }
  const bytes = await readPayload(response, MAX_FEED_BYTES);
  return selectFeedVersion(watch, bytes.toString("utf8"));
}

export interface HoldInput {
  caskVersion: string;
  upstreamVersion: string;
  // null when the app watches no feed, or the feed matched no version.
  feedVersion: string | null;
}

// Hold only when the feed advertises a version the cask does not have yet AND
// resolve has not moved past the cask: waiting is worth it solely when the run
// would otherwise make no progress. So a run that is already due builds at
// once, a run that is genuinely up to date skips at once, and only the
// lagging-oracle window waits.
export function planHold(input: HoldInput): boolean {
  const { caskVersion, upstreamVersion } = input;
  const feedVersion = comparableVersion(input.feedVersion ?? undefined);
  if (feedVersion === null) return false;
  if (!isNewer(caskVersion, feedVersion)) return false;
  return !isNewer(caskVersion, upstreamVersion);
}
