// Release concerns for the cask gate: comparing published assets against the
// cask pin, and rendering/pruning the release set. DWARFS AppImages are not
// byte reproducible, so a rebuild can change an asset without a version bump.

import * as fs from "node:fs";
import * as path from "node:path";
import { APPIMAGE_ARCH } from "../core/architecture.ts";
import { fail } from "../core/guards.ts";
import { sha256Hex } from "../core/http.ts";
import type { AppDescriptor, Architecture, CaskState } from "../core/types.ts";
import { sortDebVersions } from "../core/version.ts";

export interface UpstreamRecord {
  sha256: string;
  url: string;
}

// The release body: a checksum table (upstream packages plus the AppImage
// hashes the cask pins) and the source URLs.
export function renderReleaseNotes(
  descriptor: AppDescriptor,
  upstreams: Partial<Record<Architecture, UpstreamRecord>>,
  assetDir: string,
): string {
  const lines: string[] = [];
  const upstreamSha = (architecture: Architecture): string =>
    upstreams[architecture]?.sha256 || "n/a";

  lines.push("## Artifact checksums", "");
  lines.push(
    `Upstream package integrity is verified against the release source (signed APT index or download-time SHA-256) before packaging; the AppImage hashes are enforced by the \`${descriptor.cask}\` cask at install.`,
    "",
  );
  lines.push("| Artifact | SHA-256 |", "| --- | --- |");
  lines.push(`| Upstream package (amd64) | \`${upstreamSha("amd64")}\` |`);
  if (upstreams.arm64 !== undefined) {
    lines.push(`| Upstream package (arm64) | \`${upstreamSha("arm64")}\` |`);
  }
  for (const file of releasedAssets(assetDir, descriptor.assetPrefix)) {
    lines.push(
      `| AppImage (${appimageArchOf(file)}) | \`${sha256Hex(fs.readFileSync(path.join(assetDir, file)))}\` |`,
    );
  }
  lines.push("", "### Sources");
  lines.push(`- Upstream package (amd64): ${upstreams.amd64?.url ?? ""}`);
  if (upstreams.arm64 !== undefined) {
    lines.push(`- Upstream package (arm64): ${upstreams.arm64.url}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface PrunePlan {
  // Every version found under the tag prefix, dpkg-ordered ascending.
  versions: string[];
  // The oldest versions beyond `keep`, i.e. the ones to delete (ascending).
  stale: string[];
}

// Selects which releases to prune, newest by dpkg ordering (never `sort -V`,
// which disagrees) so the newest is never dropped. An unparseable version
// fails here rather than silently pruning a short list.
export function planReleasePrune(
  tags: readonly string[],
  prefix: string,
  keep: number,
): PrunePlan {
  const versions = tags
    .filter((tag) => tag !== "")
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => {
      const version = tag.slice(prefix.length);
      if (version === "") fail(`release tag ${tag} has an empty version`);
      return version;
    });
  const sorted = sortDebVersions(versions);
  const stale = sorted.slice(0, Math.max(0, sorted.length - keep));
  return { versions: sorted, stale };
}

export interface AssetComparison {
  // true/false when the comparison ran; null when it could not (a missing or
  // duplicated asset for a shipped architecture), which the gate treats as
  // "no evidence" rather than a match.
  matches: boolean | null;
  notes: string[];
}

// Every AppImage asset in `assetDir` for this prefix, optionally narrowed to
// one architecture, in stable (sorted) order.
function releasedAssets(
  assetDir: string,
  assetPrefix: string,
  architecture?: Architecture,
): string[] {
  const suffix =
    architecture === undefined ? ".AppImage" : `-${APPIMAGE_ARCH[architecture]}.AppImage`;
  return fs
    .readdirSync(assetDir)
    .filter((name) => name.startsWith(`${assetPrefix}-`) && name.endsWith(suffix))
    .sort();
}

// "<prefix>-<version>-<appimageArch>.AppImage" -> "<appimageArch>".
function appimageArchOf(fileName: string): string {
  const base = fileName.endsWith(".AppImage")
    ? fileName.slice(0, -".AppImage".length)
    : fileName;
  return base.slice(base.lastIndexOf("-") + 1);
}

// Compares the downloaded release assets for every architecture the descriptor
// ships against the cask's pinned checksums.
export function compareReleasedAssets(
  descriptor: AppDescriptor,
  cask: CaskState,
  assetDir: string,
): AssetComparison {
  const notes: string[] = [];
  let matches = true;

  for (const architecture of descriptor.architectures) {
    const files = releasedAssets(assetDir, descriptor.assetPrefix, architecture);
    // Exactly one asset per shipped arch: zero means the release is incomplete,
    // several mean the layout is not the one the cask pins.
    if (files.length !== 1) {
      notes.push(
        `expected exactly one ${APPIMAGE_ARCH[architecture]} asset for ${descriptor.assetPrefix}, found ${files.length}`,
      );
      return { matches: null, notes };
    }
    const expected = cask.sha256[architecture];
    if (expected === undefined) {
      notes.push(`cask does not pin the ${architecture} checksum`);
      return { matches: null, notes };
    }
    const fileName = files[0];
    if (fileName === undefined) {
      notes.push(`no ${APPIMAGE_ARCH[architecture]} asset found`);
      return { matches: null, notes };
    }
    const actual = sha256Hex(fs.readFileSync(path.join(assetDir, fileName)));
    if (actual !== expected) {
      notes.push(`${architecture} asset ${fileName} hashes to ${actual}, not the pinned ${expected}`);
      matches = false;
    }
  }

  return { matches, notes };
}
