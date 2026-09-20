// Release-asset comparison for the cask gate. DWARFS AppImages are not byte
// reproducible, so a rebuild can change a published asset without a version
// bump; the gate compares the release's assets against the cask's pinned
// checksums to decide whether the cask needs repairing.

import * as fs from "node:fs";
import * as path from "node:path";
import { APPIMAGE_ARCH } from "./architecture.ts";
import { sha256Hex } from "./http.ts";
import type { AppDescriptor, Architecture, CaskState } from "./types.ts";

export interface AssetComparison {
  // true/false when the comparison ran; null when it could not (a missing or
  // duplicated asset for a shipped architecture), which the gate treats as
  // "no evidence" rather than a match.
  matches: boolean | null;
  notes: string[];
}

// Every asset in `assetDir` named "<assetPrefix>-<...>-<appimageArch>.AppImage".
function releasedAssets(assetDir: string, assetPrefix: string, architecture: Architecture): string[] {
  const suffix = `-${APPIMAGE_ARCH[architecture]}.AppImage`;
  return fs
    .readdirSync(assetDir)
    .filter((name) => name.startsWith(`${assetPrefix}-`) && name.endsWith(suffix));
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
