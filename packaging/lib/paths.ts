// Repository layout, defined once. Every containment check derives from these
// so a module move cannot silently change what counts as "inside the repo".

import * as path from "node:path";

// packaging/lib/paths.ts -> repository root
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
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
