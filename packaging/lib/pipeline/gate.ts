// The cask gate: whether a run builds, skips, or only repairs the cask pin.
// There is exactly one version in play — the requested version the API
// dispatched (or the cask pin for a manual run) — and resolve has already said
// whether that version's artifact exists. A unit-tested decision table, so the
// workflow needs no shell for it.

import { compareDebVersions } from "../core/version.ts";
import type { CaskState } from "./cask.ts";

export type GateAction = "build" | "skip" | "repair-cask";

export interface GateInput {
  cask: CaskState;
  // The one version this run may build: the API's dispatched version, or the
  // cask pin for a manual run. There is no second, newest-upstream version.
  requestedVersion: string;
  // The version resolve actually found a payload for, or null when resolve
  // reported not-ready.
  artifactVersion: string | null;
  releaseExists: boolean;
  // Smoke runs rebuild the requested version even when the cask already pins
  // it or the release exists; publishing is disabled separately.
  force?: boolean | undefined;
}

export interface GateDecision {
  action: GateAction;
  reason: string;
  // A typed readiness signal for the run record: present only when the API's
  // requested version is not published upstream yet, so the API can wait and
  // ask again instead of matching on the human `reason`.
  reasonCode?: "not-ready" | undefined;
}

// A cask version that is empty or non-numeric cannot be compared; treat it as
// "needs building" so a broken pin is repaired rather than skipped.
export function isNewer(caskVersion: string, requestedVersion: string): boolean {
  if (caskVersion === "" || !/^\d/.test(caskVersion)) return true;
  if (caskVersion === requestedVersion) return false;
  try {
    return compareDebVersions(caskVersion, requestedVersion) <= 0;
  } catch {
    // Uncomparable versions are not evidence of an up-to-date pin.
    return true;
  }
}

export function planGate(input: GateInput): GateDecision {
  const caskVersion = input.cask.version;
  const requested = input.requestedVersion;

  // resolve found no payload for the request: the vendor has not published it
  // yet. Report a typed not-ready skip, never a build of another version.
  if (input.artifactVersion === null) {
    return {
      action: "skip",
      reason: `not-ready: no published artifact for ${requested}`,
      reasonCode: "not-ready",
    };
  }

  // resolve is required to return the requested version. A mismatch is a
  // resolver bug, but it still must not build: fail closed as not-ready.
  if (input.artifactVersion !== requested) {
    return {
      action: "skip",
      reason: `not-ready: resolved ${input.artifactVersion} does not match requested ${requested}`,
      reasonCode: "not-ready",
    };
  }

  if (input.force === true) {
    return {
      action: "build",
      reason: `Forced smoke build of requested ${requested}; release and cask pin ignored`,
    };
  }

  if (isNewer(caskVersion, requested)) {
    return input.releaseExists
      ? {
          action: "repair-cask",
          reason: `Release ${requested} is already published; catching cask ${caskVersion} up`,
        }
      : {
          action: "build",
          reason: `Requested ${requested} is newer than cask ${caskVersion}; building`,
        };
  }

  if (caskVersion === requested) {
    return {
      action: "skip",
      reason: `Cask ${caskVersion} already at requested ${requested}; skipping`,
    };
  }

  return {
    action: "skip",
    reason: `Cask ${caskVersion} is ahead of requested ${requested}; skipping`,
  };
}
