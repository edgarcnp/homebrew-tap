// The descriptor domain's public surface: loading, app discovery and the CI
// projection. Consumers import from here, never from a pipeline module.

import * as fs from "node:fs";
import * as path from "node:path";
import { DescriptorError } from "../core/errors.ts";
import { APP_ID } from "../core/patterns.ts";
import { APPS_DIR, REPO_ROOT, appDir, descriptorPath } from "../core/paths.ts";
import type { AppDescriptor } from "./app.ts";
import { validateDescriptor } from "./validate.ts";

export { descriptorExport, descriptorLines, type DescriptorExport } from "./export.ts";
export { validateDescriptor } from "./validate.ts";
export type { Artifact, ArtifactKind } from "./artifact.ts";
export type { AppDescriptor, AppDescriptorInput } from "./app.ts";
export type { Payload, PayloadKind, PayloadTarget } from "./payload.ts";
export type { UpdaterConfig } from "./updater.ts";
export type { WatchConfig, WatchFormat } from "./watch.ts";

// Every repo-owned file the descriptor names must exist before a build starts:
// a typo in a template, hook or extra file otherwise fails minutes into the
// build, after the payload download.
function requireFile(root: string, relative: string, label: string): void {
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new DescriptorError(`${label} must stay inside ${root}: ${relative}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    throw new DescriptorError(`${label} does not exist: ${relative}`);
  }
  if (!stat.isFile()) throw new DescriptorError(`${label} is not a file: ${relative}`);
}

function verifyReferencedFiles(descriptor: AppDescriptor): void {
  const app = appDir(descriptor.id);
  const label = `apps/${descriptor.id}/app.json`;
  requireFile(app, descriptor.desktopTemplate, `${label}.desktopTemplate`);
  if (descriptor.icon.base === "app") {
    requireFile(app, descriptor.icon.source, `${label}.icon.source`);
  }
  if (descriptor.updater.hook !== undefined) {
    requireFile(app, descriptor.updater.hook, `${label}.updater.hook`);
  }
  for (const [index, file] of (descriptor.extraFiles ?? []).entries()) {
    requireFile(app, file.source, `${label}.extraFiles[${index}].source`);
  }
  if (descriptor.artifact.kind === "mozilla-release") {
    requireFile(REPO_ROOT, descriptor.artifact.keyPath, `${label}.artifact.keyPath`);
  }
}

export function loadDescriptor(app: string): AppDescriptor {
  const file = descriptorPath(app);
  if (!APP_ID.test(app)) throw new DescriptorError(`Invalid app name: ${app}`);
  if (!fs.existsSync(file)) throw new DescriptorError(`Unknown app "${app}" (no ${file})`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DescriptorError(`${file} is not valid JSON: ${detail}`);
  }
  const descriptor = validateDescriptor(raw, app);
  verifyReferencedFiles(descriptor);
  return descriptor;
}

export function listApps(): string[] {
  if (!fs.existsSync(APPS_DIR)) return [];
  return fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(descriptorPath(entry.name)))
    .map((entry) => entry.name)
    .sort();
}

// Dispatch passes an app id or a cask token; validateDescriptor requires them
// to be the same string, so this is a single lookup.
export function resolveApp(name: string): string | undefined {
  return listApps().includes(name) ? name : undefined;
}
