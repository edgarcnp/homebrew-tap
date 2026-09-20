// The pipeline's architecture table. Descriptors name architectures by their
// deb spelling (amd64/arm64); every other layer spells them differently (the
// AppImage suffix, the Homebrew cask symbol, a host's uname). This is the one
// place that maps between them, so the cask check, the shell stages and the
// CLI cannot disagree about which arch a build is for.

import { fail } from "./guards.ts";
import type { Architecture } from "./types.ts";

// AppImage arch suffix: <app>-<version>-x86_64.AppImage.
export const APPIMAGE_ARCH: Record<Architecture, string> = {
  amd64: "x86_64",
  arm64: "aarch64",
};

// Homebrew cask `arch arm: "…", intel: "…"` symbol values.
export const BREW_ARCH: Record<Architecture, string> = {
  amd64: "x86_64",
  arm64: "arm64",
};

// Accepts every spelling a host or CI may hand us (deb, AppImage, uname).
export function resolveArchitecture(value: string): Architecture {
  switch (value) {
    case "amd64":
    case "x86_64":
      return "amd64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return fail(
        `Unsupported AppImage architecture: ${value} (upstream packages support amd64 and arm64 only)`,
      );
  }
}

// The cask's `depends_on arch: :<symbol>` value back to the pipeline arch.
export function resolveBrewArch(value: string): Architecture {
  switch (value) {
    case "x86_64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      return fail(`unsupported depends_on arch: ${value}`);
  }
}
