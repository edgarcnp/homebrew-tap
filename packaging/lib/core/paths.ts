// Repository layout, defined once. Every containment check derives from these
// so a module move cannot silently change what counts as "inside the repo".

import * as fs from "node:fs";
import * as path from "node:path";

// Walk up from this module until the tap root (the directory holding both
// package.json and packaging/) is found, so moving this file between folders
// does not need a depth recalculation here.
function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "packaging"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not locate the tap repository root");
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(import.meta.dirname);
export const PACKAGING_DIR = path.join(REPO_ROOT, "packaging");
export const APPS_DIR = path.join(PACKAGING_DIR, "apps");
export const CASKS_DIR = path.join(REPO_ROOT, "Casks");

export function appDir(app: string): string {
  return path.join(APPS_DIR, app);
}

export function descriptorPath(app: string): string {
  return path.join(appDir(app), "app.json");
}

export function caskPath(cask: string): string {
  return path.join(CASKS_DIR, `${cask}.rb`);
}
