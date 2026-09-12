// The cask gate: decides whether a run builds, skips, or only repairs the cask
// pin. Extracted from the workflow's shell so the decision table is unit
// tested rather than re-read in a YAML file before every change.

import { compareDebVersions } from "./version.ts";
import type { GateDecision, GateInput } from "./types.ts";

// A cask version that is empty or non-numeric cannot be compared; treat it as
// "needs building" so a broken pin is repaired rather than skipped.
export function isNewer(caskVersion: string, upstreamVersion: string): boolean {
  if (caskVersion === "" || !/^\d/.test(caskVersion)) return true;
  if (caskVersion === upstreamVersion) return false;
  try {
    return compareDebVersions(caskVersion, upstreamVersion) <= 0;
  } catch {
    // Uncomparable versions are not evidence of an up-to-date pin.
    return true;
  }
}

export function planGate(input: GateInput): GateDecision {
  const { cask, upstreamVersion, releaseExists } = input;
  const caskVersion = cask.version;

  if (isNewer(caskVersion, upstreamVersion)) {
    return releaseExists
      ? {
          action: "repair-cask",
          reason: `Upstream ${upstreamVersion} is newer than cask ${caskVersion}; release already published, catching cask up`,
        }
      : {
          action: "build",
          reason: `Upstream ${upstreamVersion} is newer than cask ${caskVersion}; building`,
        };
  }

  if (!releaseExists) {
    return {
      action: "build",
      reason: `Cask ${caskVersion} references a version with no release; (re)building`,
    };
  }

  if (caskVersion !== upstreamVersion) {
    return {
      action: "skip",
      reason: `Cask ${caskVersion} is ahead of upstream ${upstreamVersion}; skipping`,
    };
  }

  if (input.releaseMatchesCask === true) {
    return {
      action: "skip",
      reason: `Cask ${caskVersion} already at upstream ${upstreamVersion}; skipping`,
    };
  }

  return {
    action: "repair-cask",
    reason:
      input.releaseMatchesCask === false
        ? `Cask ${caskVersion} at upstream version but release assets differ; catching cask up`
        : `Cask ${caskVersion} at upstream version but release assets could not be compared; catching cask up`,
  };
}
