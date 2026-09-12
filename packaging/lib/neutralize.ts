// Updater neutralization: one implementation, four descriptor-selected
// configurations. Covers removing the electron-updater feed, deleting update
// keys from product.json, rewriting a compiled endpoint in place (same-length
// for ELF files, where shifting bytes would corrupt the image), and asserting
// that nothing survived anywhere in the AppDir.

import * as fs from "node:fs";
import * as path from "node:path";
import { assertSameLength, assertSingleLine, fail } from "./guards.ts";
import { appDir } from "./paths.ts";
import type { AppDescriptor, EndpointPatch } from "./types.ts";

// Vendored dependency trees are never patched (unchanged from the previous
// implementation), but they are still scanned for survivors.
const PATCH_SKIP_DIRS = new Set(["node_modules", ".git"]);
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

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
  if (!fs.existsSync(full)) return;
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
      if (required) fail(`expected upstream update feed is missing: ${full}`);
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
        fail(`updater neutralization incomplete: ${detail}`);
      }
      report.warnings.push(`updater neutralization incomplete: ${detail}`);
    }
  }
  return report;
}

// Runs after quick-sharun: the AppDir's .env and the runtime hook both belong
// to the finished AppDir.
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

  return notes;
}
