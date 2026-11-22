// Repository layout, defined once for every containment check.

import * as path from "node:path";

// This file lives at packaging/lib/core/paths.ts, so three levels up is the
// tap root. A fixed relative path keeps the module free of import-time
// filesystem work; the layout is part of the repository contract.
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
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
