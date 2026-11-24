// Updater neutralization: one implementation, descriptor-selected behavior —
// feed removal, JSON key removal, in-place endpoint patching (same-length for
// ELF) and a residual scan that fails when a declared endpoint survives.

import * as fs from "node:fs";
import * as path from "node:path";
import { assertSameLength, assertSingleLine, fail } from "../core/guards.ts";
import { GuardViolationError, UpdaterResidualError } from "../core/errors.ts";
import { appDir, PACKAGING_DIR } from "../core/paths.ts";
import type { AppDescriptor, WaylandBackend } from "../descriptor/app.ts";
import type { EndpointPatch } from "../descriptor/updater.ts";

// Vendored trees are never patched, but are still scanned for survivors.
const PATCH_SKIP_DIRS = new Set(["node_modules", ".git"]);
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
// A 00- prefix puts the guard at the front of the AppRun hook glob, ahead of
// quick-sharun's own 01-/05- hooks (an app may deploy a 00- of its own, e.g.
// wfhelper's electron-ldd fix, which then sorts just before it).
const WAYLAND_HOOK_NAME = "00-wayland-only.hook";
const WAYLAND_HOOK_SOURCE = path.join(PACKAGING_DIR, "lib", "shell", "wayland-only.hook");
// Appended to the shared guard, so one file carries the tap's rule plus only
// the switches this app's toolkit actually reads.
//
// Electron needs both lines: 38 made `--ozone-platform=auto` the default and
// removed `ELECTRON_OZONE_PLATFORM_HINT`, while 20-37 only understand the hint.
// Measured on the bundled 41: with `WAYLAND_DISPLAY` set it opens a Wayland
// connection whatever `XDG_SESSION_TYPE` says, so the session-type line is what
// a real session exports anyway rather than the switch that decides.
//
// Firefox needs both too, for the opposite reason: with `MOZ_ENABLE_WAYLAND=1`
// alone it logs "fallback to X11" and starts on Xwayland when the socket is
// missing, while `GDK_BACKEND=wayland` makes GTK refuse the X11 backend instead.
const WAYLAND_BACKEND_EXPORTS: Record<WaylandBackend, readonly string[]> = {
  auto: [],
  gdk: ["export GDK_BACKEND=wayland"],
  electron: ["export XDG_SESSION_TYPE=wayland", "export ELECTRON_OZONE_PLATFORM_HINT=wayland"],
  moz: ["export GDK_BACKEND=wayland", "export MOZ_ENABLE_WAYLAND=1"],
};

export interface NeutralizeReport {
  patchedFiles: string[];
  removedFeedFiles: string[];
  removedJsonKeys: string[];
  survivors: Array<{ file: string; pattern: string }>;
  warnings: string[];
}

function walk(root: string, skipDirs: ReadonlySet<string>): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        visit(full);
        continue;
      }
      if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

function replaceAllBytes(
  bytes: Buffer,
  from: Buffer,
  to: Buffer,
  sameLength: boolean,
): Buffer {
  if (sameLength && from.length !== to.length) {
    fail(`refusing to patch with a different-length replacement: ${from.length} vs ${to.length}`);
  }
  const chunks: Buffer[] = [];
  let last = 0;
  for (;;) {
    const index = bytes.indexOf(from, last);
    if (index === -1) break;
    chunks.push(bytes.subarray(last, index));
    chunks.push(to);
    last = index + from.length;
  }
  if (last === 0) return bytes;
  chunks.push(bytes.subarray(last));
  return Buffer.concat(chunks);
}

export function isElf(bytes: Buffer): boolean {
  return bytes.length >= ELF_MAGIC.length && bytes.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC);
}

function patchEndpoint(appDirPath: string, patch: EndpointPatch, report: NeutralizeReport): void {
  const from = Buffer.from(patch.from, "utf8");
  const textTo = Buffer.from(patch.textReplacement, "utf8");
  const binaryTo = Buffer.from(patch.binaryReplacement, "utf8");
  assertSameLength(patch.from, patch.binaryReplacement, "endpoint");

  const targets =
    patch.targets === "all"
      ? walk(appDirPath, PATCH_SKIP_DIRS)
      : patch.targets.map((relative) => path.join(appDirPath, relative));

  for (const file of targets) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (patch.targets !== "all") fail(`endpoint patch target does not exist: ${file}`);
      continue;
    }
    const original = fs.readFileSync(file);
    if (!original.includes(from)) continue;
    const elf = isElf(original);
    const updated = replaceAllBytes(original, from, elf ? binaryTo : textTo, elf);
    if (elf && updated.length !== original.length) {
      fail(`ELF patch changed the size of ${file}: ${original.length} -> ${updated.length}`);
    }
    fs.writeFileSync(file, updated);
    report.patchedFiles.push(file);
  }
}

function removeJsonKeys(
  appDirPath: string,
  file: string,
  keys: string[],
  report: NeutralizeReport,
): void {
  const full = path.join(appDirPath, file);
  if (!fs.existsSync(full)) {
    report.warnings.push(`${file} not found; no JSON updater keys removed`);
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
  let changed = false;
  for (const key of keys) {
    if (key in parsed) {
      delete parsed[key];
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(full, `${JSON.stringify(parsed, null, "\t")}\n`);
    report.removedJsonKeys.push(...keys.filter((key) => !(key in parsed)));
  }
  const remaining = keys.filter((key) => key in parsed);
  if (remaining.length > 0) fail(`${file} still declares ${remaining.join(", ")}`);
}

function removeFeeds(
  appDirPath: string,
  paths: string[],
  required: boolean,
  report: NeutralizeReport,
): void {
  for (const relative of paths) {
    const full = path.join(appDirPath, relative);
    if (!fs.existsSync(full)) {
      if (required) {
        // A required feed that disappeared is an upstream layout change, not a
        // transient build failure: classify it permanent so retry.yml opens an
        // issue instead of re-running the same build.
        throw new GuardViolationError(`expected upstream update feed is missing: ${full}`);
      }
      continue;
    }
    fs.unlinkSync(full);
    report.removedFeedFiles.push(full);
  }
}

function scanForSurvivors(
  appDirPath: string,
  patterns: string[],
  report: NeutralizeReport,
): void {
  const needles = patterns.map((pattern) => ({ pattern, bytes: Buffer.from(pattern, "utf8") }));
  for (const file of walk(appDirPath, new Set())) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    for (const { pattern, bytes: needle } of needles) {
      if (bytes.includes(needle)) report.survivors.push({ file, pattern });
    }
  }
}

export function neutralizeUpdater(descriptor: AppDescriptor, appDirPath: string): NeutralizeReport {
  const report: NeutralizeReport = {
    patchedFiles: [],
    removedFeedFiles: [],
    removedJsonKeys: [],
    survivors: [],
    warnings: [],
  };
  const updater = descriptor.updater;

  if (updater.removeJsonKeys !== undefined) {
    removeJsonKeys(
      appDirPath,
      updater.removeJsonKeys.file,
      updater.removeJsonKeys.keys,
      report,
    );
  }
  if (updater.removeFeed !== undefined) {
    removeFeeds(appDirPath, updater.removeFeed.paths, updater.removeFeed.required, report);
  }
  if (updater.patchEndpoint !== undefined) {
    patchEndpoint(appDirPath, updater.patchEndpoint, report);
  }
  if (updater.residualScan !== undefined) {
    const { patterns, severity } = updater.residualScan;
    scanForSurvivors(appDirPath, patterns, report);
    if (report.survivors.length > 0) {
      const detail = report.survivors.map((entry) => `${entry.file} (${entry.pattern})`).join(", ");
      if (severity === "error") {
        // The artifact still talks to its own updater: permanent, so the run
        // record must not invite a re-run.
        throw new UpdaterResidualError(`updater neutralization incomplete: ${detail}`);
      }
      report.warnings.push(`updater neutralization incomplete: ${detail}`);
    }
  }
  return report;
}

// Runs after quick-sharun: .env and the runtime hooks belong to the finished
// AppDir.
export function finalizeApp(descriptor: AppDescriptor, appDirPath: string): string[] {
  const notes: string[] = [];
  const updater = descriptor.updater;

  if (updater.env !== undefined) {
    const envPath = path.join(appDirPath, ".env");
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const lines = existing === "" ? [] : existing.split("\n").filter((line) => line !== "");
    for (const [key, value] of Object.entries(updater.env)) {
      const line = `${key}=${assertSingleLine(value, `env ${key}`)}`;
      if (!lines.includes(line)) lines.push(line);
    }
    fs.writeFileSync(envPath, `${lines.join("\n")}\n`);
    notes.push(`wrote ${Object.keys(updater.env).join(", ")} to ${envPath}`);
  }

  if (updater.hook !== undefined) {
    const source = path.join(appDir(descriptor.id), updater.hook);
    if (!fs.existsSync(source)) fail(`Missing runtime hook: ${source}`);
    const binDir = path.join(appDirPath, "bin");
    if (!fs.existsSync(binDir)) fail(`Missing AppDir bin directory: ${binDir}`);
    const destination = path.join(binDir, path.basename(source));
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o755);
    notes.push(`installed runtime hook ${destination}`);
  }

  // Wayland-only is the tap's rule, not this app's: the shared guard gives every
  // AppImage the same refusal, and the app's own `waylandBackend` decides
  // whether one toolkit variable rides along. An opt-out is one field.
  if (descriptor.waylandOnly) {
    const binDir = path.join(appDirPath, "bin");
    if (!fs.existsSync(binDir)) fail(`Missing AppDir bin directory: ${binDir}`);
    if (!fs.existsSync(WAYLAND_HOOK_SOURCE)) fail(`Missing Wayland-only hook: ${WAYLAND_HOOK_SOURCE}`);
    const guard = fs.readFileSync(WAYLAND_HOOK_SOURCE, "utf8");
    const backend = descriptor.waylandBackend;
    const exports = backend === undefined ? [] : WAYLAND_BACKEND_EXPORTS[backend];
    const content = exports.length === 0 ? guard : `${guard}\n${exports.join("\n")}\n`;
    // Replaced rather than truncated: a payload tree that shipped a symlink at
    // this name would otherwise turn the write into one at whatever it points
    // at. Writing a fresh file also makes `mode` apply, since it only does so
    // at creation.
    const destination = path.join(binDir, WAYLAND_HOOK_NAME);
    fs.rmSync(destination, { force: true });
    fs.writeFileSync(destination, content, { mode: 0o755 });
    notes.push(`installed Wayland-only hook ${destination}`);
  }

  for (const file of descriptor.extraFiles ?? []) {
    const source = path.join(appDir(descriptor.id), file.source);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      fail(`Missing extra file: ${source}`);
    }
    const destination = path.join(appDirPath, file.target);
    if (fs.existsSync(destination)) {
      // The payload owns its own paths: an identical copy is a no-op (so a
      // repeated local run does not fail), different bytes are a mistake
      // rather than something to overwrite.
      if (!fs.readFileSync(source).equals(fs.readFileSync(destination))) {
        fail(`Refusing to overwrite existing file: ${destination}`);
      }
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    fs.chmodSync(destination, 0o644);
    notes.push(`installed extra file ${file.target}`);
  }

  return notes;
}
