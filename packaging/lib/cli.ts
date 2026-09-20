// `fbr`: the single command-line entry point for the packaging pipeline. Every
// command declares its flags, so an unknown or duplicate flag is a usage error
// instead of a silently ignored argument (the old per-resolver parsers each
// behaved differently).

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { APPIMAGE_ARCH, resolveArchitecture } from "./architecture.ts";
import { checkCask, readCaskFile, writeCask } from "./cask.ts";
import { descriptorLines, listApps, loadDescriptor, resolveApp } from "./descriptor.ts";
import { planGate } from "./gate.ts";
import { readMetadataField } from "./metadata.ts";
import {
  compareReleasedAssets,
  planReleasePrune,
  renderReleaseNotes,
  type UpstreamRecord,
} from "./release.ts";
import { finalizeApp, neutralizeUpdater } from "./neutralize.ts";
import { resolveWith } from "./oracles/registry.ts";
import { writeDesktopEntry } from "./render.ts";
import type { AppDescriptor, Architecture } from "./types.ts";
import { ARCHITECTURES, isArchitecture } from "./types.ts";
import { compareDebVersions, sortDebVersions } from "./version.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, unknown>;

export class UsageError extends Error {
  readonly exitCode: number;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

class Flags {
  values: Values;

  constructor(values: Values) {
    this.values = values;
  }

  str(name: string): string {
    const value = this.values[name];
    if (typeof value !== "string" || value === "") {
      throw new UsageError(`Missing required flag --${name}`);
    }
    return value;
  }

  optStr(name: string): string | undefined {
    const value = this.values[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new UsageError(`Flag --${name} takes a value`);
    return value;
  }

  bool(name: string): boolean {
    const value = this.values[name];
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw new UsageError(`Flag --${name} is a flag`);
    return value;
  }

  // A repeatable option: parseArgs returns an array when `multiple` is set, a
  // bare string otherwise.
  strList(name: string): string[] {
    const value = this.values[name];
    if (value === undefined) return [];
    if (typeof value === "string") return [value];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value as string[];
    }
    throw new UsageError(`Flag --${name} takes a value`);
  }
}

const APP = { type: "string" } as const;
const TAP = { type: "string" } as const;

// The gate's asset comparison is tri-state: the workflow omits the flag when
// the comparison could not run, and passes "true" or "false" when it did.
function parseReleaseMatch(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`Flag --release-matches-cask must be "true" or "false", got "${value}"`);
}

// --upstream <arch>=<sha256>=<url>, one per shipped architecture.
function parseUpstreamSpec(spec: string): [Architecture, UpstreamRecord] {
  const first = spec.indexOf("=");
  const second = spec.indexOf("=", first + 1);
  if (first < 0 || second < 0) {
    throw new UsageError(`--upstream must be <arch>=<sha256>=<url>, got "${spec}"`);
  }
  const architecture = spec.slice(0, first);
  if (!isArchitecture(architecture)) {
    throw new UsageError(`--upstream arch must be amd64 or arm64, got "${architecture}"`);
  }
  return [architecture, { sha256: spec.slice(first + 1, second), url: spec.slice(second + 1) }];
}

interface Command {
  name: string;
  summary: string;
  options: Options;
  positionals?: boolean;
  run: (flags: Flags, positionals: string[]) => Promise<number> | number;
}

function descriptorFor(flags: Flags): AppDescriptor {
  return loadDescriptor(flags.str("app"));
}

function caskFileFor(flags: Flags, descriptor: AppDescriptor): string {
  const tap = flags.optStr("tap") ?? ".";
  return path.join(tap, "Casks", `${descriptor.cask}.rb`);
}

function reportCaskProblems(descriptor: AppDescriptor, file: string): number {
  if (!fs.existsSync(file)) {
    process.stderr.write(`[ERROR] missing cask ${file}\n`);
    return 1;
  }
  const problems = checkCask(descriptor, fs.readFileSync(file, "utf8"));
  for (const problem of problems) {
    process.stderr.write(`[ERROR] ${descriptor.cask}: ${problem}\n`);
  }
  return problems.length;
}

// The two architectures a cask can pin, with the flag that carries each one.
// Kept as data so the set-version path has one loop instead of two mirrored
// amd64/arm64 blocks.
const CASK_SHA256_FLAGS: ReadonlyArray<{ architecture: Architecture; flag: string }> = [
  { architecture: "amd64", flag: "sha256-x86-64" },
  { architecture: "arm64", flag: "sha256-arm-64" },
];

function caskRead(flags: Flags): number {
  const descriptor = descriptorFor(flags);
  process.stdout.write(`${JSON.stringify(readCaskFile(caskFileFor(flags, descriptor)))}\n`);
  return 0;
}

// Every app's cask against its descriptor; one problem anywhere fails the run.
function caskCheckAll(flags: Flags): number {
  let problems = 0;
  for (const id of listApps()) {
    const descriptor = loadDescriptor(id);
    problems += reportCaskProblems(descriptor, caskFileFor(flags, descriptor));
  }
  return problems === 0 ? 0 : 1;
}

function caskCheck(flags: Flags): number {
  if (flags.optStr("app") === undefined) return caskCheckAll(flags);
  const descriptor = descriptorFor(flags);
  return reportCaskProblems(descriptor, caskFileFor(flags, descriptor)) === 0 ? 0 : 1;
}

function caskSetVersion(flags: Flags): number {
  const descriptor = descriptorFor(flags);
  const sha256: Partial<Record<Architecture, string>> = {};
  for (const { architecture, flag } of CASK_SHA256_FLAGS) {
    const value = flags.optStr(flag);
    if (descriptor.architectures.includes(architecture)) {
      if (value === undefined) throw new UsageError(`Missing required flag --${flag}`);
      sha256[architecture] = value;
    } else if (value !== undefined) {
      throw new UsageError(
        `--${flag} is unexpected for single-arch (${descriptor.architectures.join(",")}) ${descriptor.id}`,
      );
    }
  }
  const file = caskFileFor(flags, descriptor);
  writeCask(file, { version: flags.str("version"), sha256 });
  process.stdout.write(`${file}\n`);
  return 0;
}

function caskCommand(flags: Flags): number {
  const action = flags.optStr("action") ?? "read";
  if (action === "read") return caskRead(flags);
  if (action === "check") return caskCheck(flags);
  if (action === "set-version") return caskSetVersion(flags);
  throw new UsageError(`Unknown cask action: ${action}`);
}

const COMMANDS: Command[] = [
  {
    name: "list-apps",
    summary: "List app ids that have a descriptor",
    options: { json: { type: "boolean" } },
    run: (flags) => {
      const apps = listApps();
      if (flags.bool("json")) {
        process.stdout.write(`${JSON.stringify(apps)}\n`);
      } else {
        for (const app of apps) process.stdout.write(`${app}\n`);
      }
      return 0;
    },
  },
  {
    name: "resolve-app",
    summary: "Map an app id or cask token to the app id (--name)",
    options: { name: { type: "string" } },
    run: (flags) => {
      const name = flags.str("name");
      const app = resolveApp(name);
      if (app === undefined) {
        const known = listApps()
          .map((id) => `${id} (${loadDescriptor(id).cask})`)
          .join(", ");
        process.stderr.write(`[ERROR] unknown app or cask '${name}' (known: ${known})\n`);
        return 1;
      }
      process.stdout.write(`${app}\n`);
      return 0;
    },
  },
  {
    name: "descriptor",
    summary: "Print a validated descriptor, or one dotted field (--app, [--field])",
    options: { app: APP, field: { type: "string" } },
    run: (flags) => {
      const descriptor = descriptorFor(flags);
      const field = flags.optStr("field");
      if (field === undefined) {
        process.stdout.write(`${JSON.stringify(descriptor, null, 2)}\n`);
        return 0;
      }
      let current: unknown = descriptor;
      for (const segment of field.split(".")) {
        if (typeof current !== "object" || current === null) {
          throw new UsageError(`Descriptor has no field ${field}`);
        }
        current = (current as Record<string, unknown>)[segment];
      }
      if (current === undefined) throw new UsageError(`Descriptor has no field ${field}`);
      const rendered =
        typeof current === "string" || typeof current === "number" || typeof current === "boolean"
          ? String(current)
          : JSON.stringify(current);
      process.stdout.write(`${rendered}\n`);
      return 0;
    },
  },
  {
    name: "descriptor-env",
    summary: "Emit KEY=VALUE lines for $GITHUB_ENV or $GITHUB_OUTPUT (--app, [--format])",
    options: { app: APP, format: { type: "string" } },
    run: (flags) => {
      const format = flags.optStr("format") ?? "env";
      if (format !== "env" && format !== "output") {
        throw new UsageError("--format must be env or output");
      }
      for (const line of descriptorLines(descriptorFor(flags), format)) {
        process.stdout.write(`${line}\n`);
      }
      return 0;
    },
  },
  {
    name: "resolve",
    summary: `Resolve upstream metadata (--app, --arch <${ARCHITECTURES.join("|")}>, --output-dir, --metadata, [--metadata-only])`,
    options: {
      app: APP,
      arch: { type: "string" },
      "output-dir": { type: "string" },
      metadata: { type: "string" },
      "metadata-only": { type: "boolean" },
    },
    run: async (flags) => {
      const descriptor = descriptorFor(flags);
      const architecture = flags.str("arch");
      if (!isArchitecture(architecture)) {
        throw new UsageError(`--arch must be one of ${ARCHITECTURES.join(", ")}`);
      }
      const metadata = await resolveWith(descriptor.oracle, {
        architecture,
        outputDir: flags.str("output-dir"),
        metadataPath: flags.str("metadata"),
        metadataOnly: flags.bool("metadata-only"),
        token: process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "",
      });
      process.stdout.write(`${metadata.path ?? flags.str("metadata")}\n`);
      return 0;
    },
  },
  {
    name: "metadata",
    summary: "Read a field from a metadata document (--file, --field)",
    options: { file: { type: "string" }, field: { type: "string" } },
    run: (flags) => {
      process.stdout.write(`${readMetadataField(flags.str("file"), flags.str("field"))}\n`);
      return 0;
    },
  },
  {
    name: "gate",
    summary:
      "Print the cask gate decision (--app, --upstream-version, [--release-exists], [--release-matches-cask true|false], [--tap])",
    options: {
      app: APP,
      tap: TAP,
      "upstream-version": { type: "string" },
      "release-exists": { type: "boolean" },
      "release-matches-cask": { type: "string" },
    },
    run: (flags) => {
      const descriptor = descriptorFor(flags);
      const cask = readCaskFile(caskFileFor(flags, descriptor));
      const decision = planGate({
        cask,
        upstreamVersion: flags.str("upstream-version"),
        releaseExists: flags.bool("release-exists"),
        releaseMatchesCask: parseReleaseMatch(flags.optStr("release-matches-cask")),
      });
      // Emitted as $GITHUB_OUTPUT lines; the workflow consumes them directly.
      for (const line of [
        `cask_version=${cask.version}`,
        `action=${decision.action}`,
        `reason=${decision.reason}`,
        `skipped=${decision.action === "skip"}`,
        `repair_cask=${decision.action === "repair-cask"}`,
      ]) {
        process.stdout.write(`${line}\n`);
      }
      return 0;
    },
  },
  {
    name: "release-check",
    summary:
      "Compare downloaded release assets to the cask pin (--app, --asset-dir, [--tap]); prints true|false, or nothing when it could not compare",
    options: { app: APP, tap: TAP, "asset-dir": { type: "string" } },
    run: (flags) => {
      const descriptor = descriptorFor(flags);
      const cask = readCaskFile(caskFileFor(flags, descriptor));
      const { matches, notes } = compareReleasedAssets(descriptor, cask, flags.str("asset-dir"));
      for (const note of notes) process.stderr.write(`[WARN] ${note}\n`);
      // No output means the comparison could not run; the gate reads that as
      // "no evidence" and catches the cask up rather than trusting it.
      if (matches === null) return 0;
      process.stdout.write(`${matches}\n`);
      return 0;
    },
  },
  {
    name: "release-prune",
    summary:
      "Print the stale release versions to prune (--prefix, --keep, tags...), dpkg-ordered",
    options: { prefix: { type: "string" }, keep: { type: "string" } },
    positionals: true,
    run: (flags, positionals) => {
      const keep = Number(flags.str("keep"));
      if (!Number.isSafeInteger(keep) || keep < 0) {
        throw new UsageError("--keep must be a non-negative integer");
      }
      const { versions, stale } = planReleasePrune(positionals, flags.str("prefix"), keep);
      process.stderr.write(
        `[INFO] retaining the newest ${keep}; pruning ${stale.length} of ${versions.length} release(s)\n`,
      );
      for (const version of stale) process.stdout.write(`${version}\n`);
      return 0;
    },
  },
  {
    name: "release-notes",
    summary:
      "Render the release-notes markdown (--app, --asset-dir, [--upstream arch=SHA=URL]..., [--output])",
    options: {
      app: APP,
      "asset-dir": { type: "string" },
      upstream: { type: "string", multiple: true },
      output: { type: "string" },
    },
    run: (flags) => {
      const descriptor = descriptorFor(flags);
      const upstreams: Partial<Record<Architecture, UpstreamRecord>> = {};
      for (const spec of flags.strList("upstream")) {
        const [architecture, record] = parseUpstreamSpec(spec);
        upstreams[architecture] = record;
      }
      const notes = renderReleaseNotes(descriptor, upstreams, flags.str("asset-dir"));
      const output = flags.optStr("output");
      if (output === undefined) process.stdout.write(notes);
      else fs.writeFileSync(output, notes);
      return 0;
    },
  },
  {
    name: "cask",
    summary: "read | set-version | check a cask (--action, [--app], [--tap])",
    options: {
      action: { type: "string" },
      app: APP,
      tap: TAP,
      version: { type: "string" },
      "sha256-x86-64": { type: "string" },
      "sha256-arm-64": { type: "string" },
    },
    run: caskCommand,
  },
  {
    name: "neutralize",
    summary: "Neutralize the in-AppDir updater (--app, --appdir)",
    options: { app: APP, appdir: { type: "string" } },
    run: (flags) => {
      const appdir = flags.str("appdir");
      const report = neutralizeUpdater(descriptorFor(flags), appdir);
      for (const file of report.patchedFiles) process.stderr.write(`[INFO] patched ${file}\n`);
      for (const file of report.removedFeedFiles) {
        process.stderr.write(`[INFO] removed update feed ${file}\n`);
      }
      if (report.removedJsonKeys.length > 0) {
        process.stderr.write(`[INFO] removed ${report.removedJsonKeys.join(", ")}\n`);
      }
      for (const warning of report.warnings) process.stderr.write(`[WARN] ${warning}\n`);
      process.stderr.write(`[INFO] verified no residual updater endpoints in ${appdir}\n`);
      return 0;
    },
  },
  {
    name: "finalize",
    summary: "Write AppDir .env and install the runtime hook (--app, --appdir)",
    options: { app: APP, appdir: { type: "string" } },
    run: (flags) => {
      for (const note of finalizeApp(descriptorFor(flags), flags.str("appdir"))) {
        process.stderr.write(`[INFO] ${note}\n`);
      }
      return 0;
    },
  },
  {
    name: "render-desktop",
    summary: "Render the desktop entry into the AppDir (--app, --version, --appdir)",
    options: { app: APP, appdir: { type: "string" }, version: { type: "string" } },
    run: (flags) => {
      const descriptor = descriptorFor(flags);
      const destination = path.join(flags.str("appdir"), `${descriptor.cask}.desktop`);
      writeDesktopEntry(descriptor, flags.str("version"), destination);
      process.stdout.write(`${destination}\n`);
      return 0;
    },
  },
  {
    name: "arch",
    summary: `Map an arch spelling to "<deb-arch> <appimage-arch>" (--arch ${ARCHITECTURES.join("|")}|x86_64|aarch64)`,
    options: { arch: { type: "string" } },
    run: (flags) => {
      const architecture = resolveArchitecture(flags.str("arch"));
      process.stdout.write(`${architecture} ${APPIMAGE_ARCH[architecture]}\n`);
      return 0;
    },
  },
  {
    name: "version-compare",
    summary: "Compare two Debian versions (-1|0|1), or sort them with --sort",
    options: { sort: { type: "boolean" } },
    positionals: true,
    run: (flags, positionals) => {
      if (flags.bool("sort")) {
        if (positionals.length === 0) {
          throw new UsageError("version-compare --sort needs at least one version");
        }
        for (const version of sortDebVersions(positionals)) {
          process.stdout.write(`${version}\n`);
        }
        return 0;
      }
      const [a, b] = positionals;
      if (a === undefined || b === undefined) {
        throw new UsageError("version-compare needs two version arguments");
      }
      process.stdout.write(`${compareDebVersions(a, b)}\n`);
      return 0;
    },
  },
];

export function usage(): string {
  const lines = ["fbr <command> [flags]", "", "Commands:"];
  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(16)} ${command.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runCli(argv: string[]): Promise<number> {
  const [commandName, ...rest] = argv;
  if (commandName === undefined) {
    process.stdout.write(usage());
    return 2;
  }
  if (commandName === "--help" || commandName === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  const command = COMMANDS.find((candidate) => candidate.name === commandName);
  if (command === undefined) {
    throw new UsageError(`Unknown command: ${commandName}\n\n${usage()}`);
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: command.options,
      strict: true,
      allowPositionals: command.positionals ?? false,
    });
  } catch (error) {
    // node:util's parse errors are usage errors, not crashes: an unknown,
    // duplicated or valueless flag exits 2 with the parser's explanation.
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  return command.run(new Flags(parsed.values as Values), [...parsed.positionals]);
}

export function isUsageError(error: unknown): error is UsageError {
  return error instanceof UsageError;
}
