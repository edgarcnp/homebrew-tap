// The one place that reads or writes a cask file. The publish pipeline, the
// version gate and the smoke test each used to parse Casks/*.rb with their own
// sed, grep or Python regexes; they now share this module, and CI checks that
// every cask agrees with its app descriptor.

import * as fs from "node:fs";
import { assertSha256Hex, fail } from "./guards.ts";
import { writeFileAtomic } from "./http.ts";
import type { AppDescriptor, Architecture, CaskState } from "./types.ts";

const VERSION_STANZA = /^[ \t]*version "([^"]*)"/gm;
const ARM64_SHA256 = /arm64_linux:[ \t]*"([0-9a-f]{64})"/g;
const X86_64_SHA256 = /x86_64_linux:[ \t]*"([0-9a-f]{64})"/g;

function exactlyOne(source: string, pattern: RegExp, label: string): string {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    fail(`cask must contain exactly one ${label} (found ${matches.length})`);
  }
  const value = matches[0]?.[1];
  if (value === undefined) fail(`cask ${label} has no captured value`);
  return value;
}

export function readCask(source: string): CaskState {
  const version = exactlyOne(source, VERSION_STANZA, "version stanza");
  if (version === "") fail("cask version is empty");
  const arm64 = exactlyOne(source, ARM64_SHA256, "arm64_linux sha256");
  const x86_64 = exactlyOne(source, X86_64_SHA256, "x86_64_linux sha256");
  const sha256: Record<Architecture, string> = {
    arm64: assertSha256Hex(arm64, "arm64 sha256"),
    amd64: assertSha256Hex(x86_64, "x86_64 sha256"),
  };
  return { version, sha256 };
}

export function readCaskFile(caskFile: string): CaskState {
  return readCask(fs.readFileSync(caskFile, "utf8"));
}

function replaceOnce(
  source: string,
  pattern: RegExp,
  replacer: (...groups: string[]) => string,
  label: string,
): string {
  if ([...source.matchAll(pattern)].length !== 1) {
    fail(`cask must contain exactly one ${label} to update`);
  }
  return source.replace(pattern, (_match, ...groups: string[]) => replacer(...groups));
}

// Rewrites the version and both pinned checksums, preserving the file's own
// spacing and indentation. Each pattern must match exactly once, so a cask
// restructuring fails loudly instead of being silently half-updated.
export function updateCask(source: string, state: CaskState): string {
  const version = assertVersionLine(state.version);
  const arm64 = assertSha256Hex(state.sha256.arm64, "arm64 sha256");
  const x86_64 = assertSha256Hex(state.sha256.amd64, "x86_64 sha256");
  let updated = replaceOnce(
    source,
    /^([ \t]*)version "[^"]*"/gm,
    (indent = "") => `${indent}version "${version}"`,
    "version stanza",
  );
  updated = replaceOnce(
    updated,
    /(arm64_linux:[ \t]*)"[0-9a-f]{64}"/g,
    (prefix = "") => `${prefix}"${arm64}"`,
    "arm64_linux sha256",
  );
  updated = replaceOnce(
    updated,
    /(x86_64_linux:[ \t]*)"[0-9a-f]{64}"/g,
    (prefix = "") => `${prefix}"${x86_64}"`,
    "x86_64_linux sha256",
  );
  return updated;
}

function assertVersionLine(version: string): string {
  if (version === "" || /["\\\r\n]/.test(version)) fail(`Unsafe cask version: ${version}`);
  return version;
}

export function writeCask(caskFile: string, state: CaskState): void {
  const source = fs.readFileSync(caskFile, "utf8");
  writeFileAtomic(caskFile, updateCask(source, state));
}

export function expectedCaskUrl(descriptor: AppDescriptor): string {
  return (
    `https://github.com/${descriptor.sourceRepo}/releases/download/` +
    `${descriptor.tagPrefix}#{version}/${descriptor.assetPrefix}-#{version}-#{arch}.AppImage`
  );
}

// Problems (empty when consistent) tying a cask to its descriptor.
export function checkCask(descriptor: AppDescriptor, source: string): string[] {
  const problems: string[] = [];
  const require = (condition: boolean, message: string): void => {
    if (!condition) problems.push(message);
  };

  require(source.includes(`cask "${descriptor.cask}" do`), "cask token does not match the file");

  const versionMatches = [...source.matchAll(VERSION_STANZA)];
  require(versionMatches.length === 1, `expected one version stanza, found ${versionMatches.length}`);

  const arm64 = [...source.matchAll(ARM64_SHA256)];
  const x86_64 = [...source.matchAll(X86_64_SHA256)];
  require(arm64.length === 1, `expected one arm64_linux sha256, found ${arm64.length}`);
  require(x86_64.length === 1, `expected one x86_64_linux sha256, found ${x86_64.length}`);

  const expectedUrl = expectedCaskUrl(descriptor);
  require(source.includes(`url "${expectedUrl}"`), `url does not match ${expectedUrl}`);
  require(source.includes(`^${descriptor.tagPrefix}`), "livecheck does not match the tag prefix");

  const asset =
    `${descriptor.assetPrefix}-#{version}-#{arch}.AppImage`;
  require(source.includes(`app_image "${asset}"`), `missing app_image "${asset}"`);
  for (const target of descriptor.binaryTargets) {
    require(source.includes(`target: "${target}"`), `missing binary target "${target}"`);
  }

  require(source.includes("depends_on :linux"), "missing depends_on :linux");
  require(source.includes("auto_updates false"), "missing auto_updates false");
  require(source.includes("postflight_steps do"), "missing postflight_steps");

  const iconTarget = `.local/share/icons/hicolor/${descriptor.icon.size}/apps/${descriptor.cask}.png`;
  const desktopTarget = `.local/share/applications/${descriptor.cask}.desktop`;
  require(source.includes(iconTarget), `postflight does not install the icon to ${iconTarget}`);
  require(source.includes(desktopTarget), `postflight does not write ${desktopTarget}`);
  require(source.includes(`~/${iconTarget}`), `zap does not remove ~/${iconTarget}`);
  require(source.includes(`~/${desktopTarget}`), `zap does not remove ~/${desktopTarget}`);

  return problems;
}
