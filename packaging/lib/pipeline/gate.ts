// The cask gate: whether a run builds, skips, or only repairs the cask pin.
// A unit-tested decision table, so the workflow needs no shell for it.

import { compareDebVersions } from "../core/version.ts";
import type { GateDecision, GateInput } from "../core/types.ts";

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

// A version the caller gave that is provably newer than the upstream's: the
// upstream artifact for it is not published yet. Uncomparable pairs are not
// proof, so the normal gate decides instead.
function requestedNotPublished(requested: string, upstream: string): boolean {
  if (requested === "" || upstream === "") return false;
  if (!/^\d/.test(requested) || !/^\d/.test(upstream)) return false;
  if (requested === upstream) return false;
  try {
    return compareDebVersions(requested, upstream) > 0;
  } catch {
    return false;
  }
}

export function planGate(input: GateInput): GateDecision {
  const { cask, upstreamVersion, releaseExists } = input;
  const caskVersion = cask.version;

  // The API dispatches the version its feed decided to build. When the upstream
  // has not published that artifact yet, resolve sees an older one: veto the
  // build and report a not-ready skip, so the API can ask again later instead
  // of the tap building a version nobody asked for. A cask already at or ahead
  // of the requested version has nothing to wait for, so the normal gate
  // answers that case.
  if (
    input.requestedVersion !== undefined &&
    requestedNotPublished(input.requestedVersion, upstreamVersion) &&
    isNewer(caskVersion, input.requestedVersion)
  ) {
    return {
      action: "skip",
      reason: `not-ready: upstream publishes ${upstreamVersion}; requested ${input.requestedVersion}`,
      reasonCode: "not-ready",
    };
  }

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

  if (caskVersion !== upstreamVersion) {
    // Reachable only when the cask is ahead: isNewer() handled behind and
    // equal above. Ahead must skip even with no release for the upstream
    // version, or a feed regression rebuilds the older version and the cask
    // pin follows it down.
    return {
      action: "skip",
      reason: `Cask ${caskVersion} is ahead of upstream ${upstreamVersion}; skipping`,
    };
  }

  if (!releaseExists) {
    return {
      action: "build",
      reason: `Cask ${caskVersion} references a version with no release; (re)building`,
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
