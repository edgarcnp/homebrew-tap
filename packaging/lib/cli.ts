// `fbr`: the single command-line entry point for the packaging pipeline. Every
// command declares its flags, so an unknown or duplicate flag is a usage error
// instead of a silently ignored argument (the old per-resolver parsers each
// behaved differently).

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { checkCask, readCaskFile, writeCask } from "./cask.ts";
import { descriptorLines, listApps, loadDescriptor } from "./descriptor.ts";
import { planGate } from "./gate.ts";
import { readMetadataField } from "./metadata.ts";
import { finalizeApp, neutralizeUpdater } from "./neutralize.ts";
import { resolveWith } from "./oracles/registry.ts";
import { writeDesktopEntry } from "./render.ts";
import type { AppDescriptor } from "./types.ts";
import { ARCHITECTURES, isArchitecture } from "./types.ts";
import { compareDebVersions } from "./version.ts";

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
    run: (flags) => {
      const action = flags.optStr("action") ?? "read";
      const app = flags.optStr("app");

      if (action === "check" && app === undefined) {
        let problems = 0;
        for (const id of listApps()) {
          const descriptor = loadDescriptor(id);
          problems += reportCaskProblems(descriptor, caskFileFor(flags, descriptor));
        }
        return problems === 0 ? 0 : 1;
      }

      const descriptor = descriptorFor(flags);
      const file = caskFileFor(flags, descriptor);
      if (action === "read") {
        process.stdout.write(`${JSON.stringify(readCaskFile(file))}\n`);
        return 0;
      }
      if (action === "set-version") {
        writeCask(file, {
          version: flags.str("version"),
          sha256: {
            amd64: flags.str("sha256-x86-64"),
            arm64: flags.str("sha256-arm-64"),
          },
        });
        process.stdout.write(`${file}\n`);
        return 0;
      }
      if (action === "check") {
        return reportCaskProblems(descriptor, file) === 0 ? 0 : 1;
      }
      throw new UsageError(`Unknown cask action: ${action}`);
    },
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
    name: "version-compare",
    summary: "Compare two Debian versions, printing -1, 0 or 1",
    options: {},
    positionals: true,
    run: (_flags, positionals) => {
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
