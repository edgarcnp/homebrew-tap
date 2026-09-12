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
const SINGLE_SHA256 = /^[ \t]*sha256 "([0-9a-f]{64})"/gm;
const DEPENDS_ARCH = /depends_on arch: :(x86_64|arm64)/g;

const APPIMAGE_ARCH: Record<Architecture, string> = {
  amd64: "x86_64",
  arm64: "aarch64",
};

function isDualArch(architectures: readonly Architecture[]): boolean {
  return architectures.length === 2 && architectures.includes("amd64") && architectures.includes("arm64");
}

function singleArch(architectures: readonly Architecture[]): Architecture {
  if (architectures.length !== 1 || architectures[0] === undefined) {
    fail(`expected a single architecture, got [${architectures.join(", ")}]`);
  }
  return architectures[0];
}

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
  const arm64Count = [...source.matchAll(ARM64_SHA256)].length;
  const x86Count = [...source.matchAll(X86_64_SHA256)].length;
  const singleMatches = [...source.matchAll(SINGLE_SHA256)];
  if (arm64Count === 1 && x86Count === 1 && singleMatches.length === 0) {
    const arm64 = exactlyOne(source, ARM64_SHA256, "arm64_linux sha256");
    const x86_64 = exactlyOne(source, X86_64_SHA256, "x86_64_linux sha256");
    return {
      version,
      sha256: {
        arm64: assertSha256Hex(arm64, "arm64 sha256"),
        amd64: assertSha256Hex(x86_64, "x86_64 sha256"),
      },
    };
  }
  if (arm64Count === 0 && x86Count === 0 && singleMatches.length === 1) {
    const hash = singleMatches[0]?.[1] ?? fail("cask single sha256 has no captured value");
    const archMatches = [...source.matchAll(DEPENDS_ARCH)];
    if (archMatches.length !== 1) {
      fail(`single-arch cask must contain exactly one depends_on arch (found ${archMatches.length})`);
    }
    const brewArch = archMatches[0]?.[1];
    const architecture: Architecture = brewArch === "x86_64" ? "amd64" : brewArch === "arm64" ? "arm64" : fail(`unsupported depends_on arch: ${brewArch}`);
    const appimageArch = APPIMAGE_ARCH[architecture];
    if (!source.includes(`-${appimageArch}.AppImage`)) {
      fail(`single-arch cask URL does not contain -${appimageArch}.AppImage`);
    }
    const sha256: Partial<Record<Architecture, string>> = {};
    sha256[architecture] = assertSha256Hex(hash, `${architecture} sha256`);
    return { version, sha256 };
  }
  fail(
    `cask must pin either both arch checksums (arm64_linux + x86_64_linux) or one single sha256 (found arm64=${arm64Count}, x86_64=${x86Count}, single=${singleMatches.length})`,
  );
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

// Rewrites the version and the pinned checksums, preserving the file's own
// spacing and indentation. Each pattern must match exactly once, so a cask
// restructuring fails loudly instead of being silently half-updated.
export function updateCask(source: string, state: CaskState): string {
  const version = assertVersionLine(state.version);
  const arm64Count = [...source.matchAll(ARM64_SHA256)].length;
  const x86Count = [...source.matchAll(X86_64_SHA256)].length;
  const singleCount = [...source.matchAll(SINGLE_SHA256)].length;
  let updated = replaceOnce(
    source,
    /^([ \t]*)version "[^"]*"/gm,
    (indent = "") => `${indent}version "${version}"`,
    "version stanza",
  );
  if (arm64Count === 1 && x86Count === 1 && singleCount === 0) {
    if (state.sha256.arm64 === undefined || state.sha256.amd64 === undefined) {
      fail("dual-arch cask update requires both arm64 and amd64 checksums");
    }
    const arm64 = assertSha256Hex(state.sha256.arm64, "arm64 sha256");
    const x86_64 = assertSha256Hex(state.sha256.amd64, "x86_64 sha256");
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
  if (arm64Count === 0 && x86Count === 0 && singleCount === 1) {
    const archMatches = [...updated.matchAll(DEPENDS_ARCH)];
    if (archMatches.length !== 1) fail("single-arch cask must contain exactly one depends_on arch");
    const brewArch = archMatches[0]?.[1];
    const architecture: Architecture = brewArch === "x86_64" ? "amd64" : brewArch === "arm64" ? "arm64" : fail(`unsupported depends_on arch: ${brewArch}`);
    const hash = state.sha256[architecture];
    if (hash === undefined) fail(`single-arch cask update requires the ${architecture} checksum`);
    const other: Architecture = architecture === "amd64" ? "arm64" : "amd64";
    if (state.sha256[other] !== undefined) {
      fail(`single-arch (${architecture}) cask update must not carry the ${other} checksum`);
    }
    const normalized = assertSha256Hex(hash, `${architecture} sha256`);
    updated = replaceOnce(
      updated,
      /^([ \t]*sha256 ")[0-9a-f]{64}(")/gm,
      (indent = "", suffix = "") => `${indent}${normalized}${suffix}`,
      "single sha256",
    );
    return updated;
  }
  fail(
    `cask must pin either both arch checksums (arm64_linux + x86_64_linux) or one single sha256 (found arm64=${arm64Count}, x86_64=${x86Count}, single=${singleCount})`,
  );
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
  const base =
    `https://github.com/${descriptor.sourceRepo}/releases/download/` +
    `${descriptor.tagPrefix}#{version}/${descriptor.assetPrefix}-#{version}-`;
  if (isDualArch(descriptor.architectures)) return `${base}#{arch}.AppImage`;
  const arch = singleArch(descriptor.architectures);
  return `${base}${APPIMAGE_ARCH[arch]}.AppImage`;
}

export function expectedAppImageAsset(descriptor: AppDescriptor): string {
  if (isDualArch(descriptor.architectures)) {
    return `${descriptor.assetPrefix}-#{version}-#{arch}.AppImage`;
  }
  const arch = singleArch(descriptor.architectures);
  return `${descriptor.assetPrefix}-#{version}-${APPIMAGE_ARCH[arch]}.AppImage`;
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
  const single = [...source.matchAll(SINGLE_SHA256)];
  if (isDualArch(descriptor.architectures)) {
    require(arm64.length === 1, `expected one arm64_linux sha256, found ${arm64.length}`);
    require(x86_64.length === 1, `expected one x86_64_linux sha256, found ${x86_64.length}`);
    require(single.length === 0, `dual-arch cask must not carry a single sha256 (found ${single.length})`);
    require(source.includes('arch arm: "aarch64", intel: "x86_64"'), "missing arch arm/intel mapping");
  } else {
    const arch = singleArch(descriptor.architectures);
    const brewArch = arch === "amd64" ? "x86_64" : "arm64";
    require(arm64.length === 0, `single-arch cask must not carry arm64_linux sha256 (found ${arm64.length})`);
    require(x86_64.length === 0, `single-arch cask must not carry x86_64_linux sha256 (found ${x86_64.length})`);
    require(single.length === 1, `expected one single sha256, found ${single.length}`);
    require(source.includes(`depends_on arch: :${brewArch}`), `missing depends_on arch: :${brewArch}`);
    require(!source.includes('arch arm: "aarch64"'), "single-arch cask must not define an arch mapping");
  }

  const expectedUrl = expectedCaskUrl(descriptor);
  require(source.includes(`url "${expectedUrl}"`), `url does not match ${expectedUrl}`);
  require(source.includes(`^${descriptor.tagPrefix}`), "livecheck does not match the tag prefix");

  const asset = expectedAppImageAsset(descriptor);
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
