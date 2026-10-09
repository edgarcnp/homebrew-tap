// `fbr`: the packaging pipeline's CLI. Every command declares its flags, so an
// unknown or duplicate flag is a usage error (exit 2), never ignored.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { APPIMAGE_ARCH, resolveArchitecture } from "./core/architecture.ts";
import {
  ChecksumMismatchError,
  GuardViolationError,
  UpdaterResidualError,
  UpstreamUnavailableError,
} from "./core/errors.ts";
import { checkCask, readCaskFile, writeCask } from "./pipeline/cask.ts";
import { descriptorLines, listApps, loadDescriptor, resolveApp } from "./pipeline/descriptor.ts";
import { planGate } from "./pipeline/gate.ts";
import {
  buildReport,
  EVIDENCE_KEY_PATTERN,
  FAILURE_CODES,
  REPORT_PHASES,
  REPORT_SKIP_REASONS,
  REPORT_STAGES,
  writeFailureFragment,
  writePublicReport,
  writeReport,
  type FailureCode,
  type ReportPhase,
  type ReportSkipReason,
  type ReportStage,
} from "./pipeline/report.ts";
import { readRetryPlan, RETRY_CONCLUSIONS, type RetryConclusion } from "./pipeline/retry.ts";
import { fetchFeedVersion } from "./pipeline/watch.ts";
import { readMetadataField } from "./core/metadata.ts";
import {
  compareReleasedAssets,
  planReleasePrune,
  renderReleaseNotes,
  type UpstreamRecord,
} from "./pipeline/release.ts";
import { finalizeApp, neutralizeUpdater } from "./pipeline/neutralize.ts";
import { resolveWith } from "./advisories/registry.ts";
import { writeDesktopEntry } from "./pipeline/render.ts";
import type { AppDescriptor, Architecture } from "./core/types.ts";
import { ARCHITECTURES, isArchitecture } from "./core/types.ts";
import { compareDebVersions, sortDebVersions } from "./core/version.ts";

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
  const sha256 = spec.slice(first + 1, second);
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new UsageError(`--upstream sha256 must be 64 hex characters, got "${sha256}"`);
  }
  const url = spec.slice(second + 1);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new UsageError(`--upstream url is not a URL: "${url}"`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new UsageError(`--upstream url must be https: "${url}"`);
  }
  return [architecture, { sha256: sha256.toLowerCase(), url }];
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
    summary: "Resolve an app name (id == cask token) to the app id (--name)",
    options: { name: { type: "string" } },
    run: (flags) => {
      const name = flags.str("name");
      const app = resolveApp(name);
      if (app === undefined) {
        process.stderr.write(
          `[ERROR] unknown app '${name}' (known: ${listApps().join(", ")})\n`,
        );
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
    summary: `Resolve upstream metadata (--app, --arch <${ARCHITECTURES.join("|")}>, --output-dir, --metadata, [--metadata-only], [--failure-out F])`,
    options: {
      app: APP,
      arch: { type: "string" },
      "output-dir": { type: "string" },
      metadata: { type: "string" },
      "metadata-only": { type: "boolean" },
      "failure-out": { type: "string" },
    },
    run: async (flags) => {
      const descriptor = descriptorFor(flags);
      const architecture = flags.str("arch");
      if (!isArchitecture(architecture)) {
        throw new UsageError(`--arch must be one of ${ARCHITECTURES.join(", ")}`);
      }
      const metadata = await resolveWith(descriptor.advisory, {
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
      "Print the cask gate decision (--app, --upstream-version, [--requested-version V], [--release-exists], [--release-matches-cask true|false], [--tap])",
    options: {
      app: APP,
      tap: TAP,
      "upstream-version": { type: "string" },
      "requested-version": { type: "string" },
      "release-exists": { type: "boolean" },
      "release-matches-cask": { type: "string" },
    },
    run: (flags) => {
      const descriptor = descriptorFor(flags);
      const cask = readCaskFile(caskFileFor(flags, descriptor));
      const decision = planGate({
        cask,
        upstreamVersion: flags.str("upstream-version"),
        requestedVersion: flags.optStr("requested-version"),
        releaseExists: flags.bool("release-exists"),
        releaseMatchesCask: parseReleaseMatch(flags.optStr("release-matches-cask")),
      });
      // Emitted as $GITHUB_OUTPUT lines; the workflow consumes them directly.
      for (const line of [
        `cask_version=${cask.version}`,
        `action=${decision.action}`,
        `reason=${decision.reason}`,
        `not_ready=${decision.reasonCode === "not-ready"}`,
        `skipped=${decision.action === "skip"}`,
        `repair_cask=${decision.action === "repair-cask"}`,
      ]) {
        process.stdout.write(`${line}\n`);
      }
      return 0;
    },
  },
  {
    name: "feed-version",
    summary:
      "Newest version the release feed advertises (--app, [--tap]); prints feed_version=. Advisory: the caller compares it against resolved_version and cask_version",
    options: {
      app: APP,
      tap: TAP,
    },
    run: async (flags) => {
      const descriptor = descriptorFor(flags);
      const feedVersion =
        descriptor.watch === undefined ? null : await fetchFeedVersion(descriptor.watch);
      // One KEY=VALUE line; the workflow parses it out of stdout.
      process.stdout.write(`feed_version=${feedVersion ?? ""}\n`);
      return 0;
    },
  },
  {
    name: "report",
    summary:
      "Write the machine-readable run record (--app, --phase, --stage, --message, --run-id, --run-attempt, --output, [--code], [--reason], [--event-id ID], [--request-id ID], [--public-output F], [--resolved-version], [--cask-version], [--feed-version], [--evidence k=v]...)",
    options: {
      app: APP,
      phase: { type: "string" },
      stage: { type: "string" },
      code: { type: "string" },
      reason: { type: "string" },
      "request-id": { type: "string" },
      "event-id": { type: "string" },
      message: { type: "string" },
      "run-id": { type: "string" },
      "run-attempt": { type: "string" },
      "resolved-version": { type: "string" },
      "cask-version": { type: "string" },
      "feed-version": { type: "string" },
      evidence: { type: "string", multiple: true },
      output: { type: "string" },
      "public-output": { type: "string" },
    },
    run: (flags) => {
      // Validated here as usage errors: a bad record is a caller bug, and the
      // API must never receive a document this repository could not classify.
      const phase = flags.str("phase");
      if (!(REPORT_PHASES as readonly string[]).includes(phase)) {
        throw new UsageError(`--phase must be one of ${REPORT_PHASES.join(", ")}`);
      }
      const stage = flags.str("stage");
      if (!(REPORT_STAGES as readonly string[]).includes(stage)) {
        throw new UsageError(`--stage must be one of ${REPORT_STAGES.join(", ")}`);
      }
      const code = flags.optStr("code");
      if (code !== undefined && !Object.hasOwn(FAILURE_CODES, code)) {
        throw new UsageError(`--code must be one of ${Object.keys(FAILURE_CODES).join(", ")}`);
      }
      if (phase === "failed" && code === undefined) {
        throw new UsageError("--phase failed needs --code");
      }
      if (phase !== "failed" && code !== undefined) {
        throw new UsageError(`--phase ${phase} carries no --code`);
      }
      const reason = flags.optStr("reason");
      if (reason !== undefined && !(REPORT_SKIP_REASONS as readonly string[]).includes(reason)) {
        throw new UsageError(`--reason must be one of ${REPORT_SKIP_REASONS.join(", ")}`);
      }
      if (reason !== undefined && phase !== "skipped") {
        throw new UsageError(`--phase ${phase} carries no --reason`);
      }
      const rawRunId = flags.str("run-id");
      const runId = Number(rawRunId);
      if (!Number.isSafeInteger(runId) || runId <= 0) {
        throw new UsageError(`--run-id must be a positive run number, got "${rawRunId}"`);
      }
      const rawRunAttempt = flags.str("run-attempt");
      const runAttempt = Number(rawRunAttempt);
      if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
        throw new UsageError(`--run-attempt must be a positive attempt number, got "${rawRunAttempt}"`);
      }
      // An empty value means "not supplied": a version the caller could not
      // read stores as null. The workflow passes --request-id "${REQUEST_ID}"
      // even for a manual run with no dispatch id, so an empty request id is a
      // normal input.
      const optional = (value: string | undefined): string | undefined =>
        value === undefined || value === "" ? undefined : value;
      const version = (value: string | undefined): string | null => optional(value) ?? null;

      const evidence: Record<string, string> = {};
      for (const spec of flags.strList("evidence")) {
        const separator = spec.indexOf("=");
        if (separator <= 0) throw new UsageError(`--evidence must be key=value, got "${spec}"`);
        const key = spec.slice(0, separator);
        const value = spec.slice(separator + 1);
        if (!EVIDENCE_KEY_PATTERN.test(key)) {
          throw new UsageError(`--evidence key must be snake_case, got "${key}"`);
        }
        if (/[\r\n\u0000]/.test(value)) {
          throw new UsageError(`--evidence value for ${key} must be a single line`);
        }
        if (Object.hasOwn(evidence, key)) throw new UsageError(`Duplicate --evidence key ${key}`);
        evidence[key] = value;
      }

      const output = flags.str("output");
      const publicOutput = flags.optStr("public-output");
      // Same path would replace the full record the API must receive with the
      // redacted copy; a caller bug, not a silent demotion.
      if (
        publicOutput !== undefined &&
        publicOutput !== "" &&
        path.resolve(publicOutput) === path.resolve(output)
      ) {
        throw new UsageError("--public-output must differ from --output");
      }
      const report = buildReport({
        app: flags.str("app"),
        runId,
        runAttempt,
        phase: phase as ReportPhase,
        stage: stage as ReportStage,
        code: code as FailureCode | undefined,
        reason: reason as ReportSkipReason | undefined,
        message: flags.str("message"),
        requestId: version(flags.optStr("request-id")),
        eventId: optional(flags.optStr("event-id")),
        resolvedVersion: version(flags.optStr("resolved-version")),
        caskVersion: version(flags.optStr("cask-version")),
        feedVersion: version(flags.optStr("feed-version")),
        evidence,
      });
      process.stdout.write(`${writeReport(output, report)}\n`);
      // The artifact copy is what the public sees; it must not carry the
      // dispatch correlation id. Empty means the caller opted out.
      if (publicOutput !== undefined && publicOutput !== "") {
        writePublicReport(publicOutput, report);
      }
      return 0;
    },
  },
  {
    name: "retry-plan",
    summary:
      "Decide whether a completed run's reports are worth a re-run (--reports-dir, --attempt N, --conclusion S); prints the plan JSON",
    options: {
      "reports-dir": { type: "string" },
      attempt: { type: "string" },
      conclusion: { type: "string" },
    },
    run: (flags) => {
      const rawAttempt = flags.str("attempt");
      const attempt = Number(rawAttempt);
      if (!Number.isSafeInteger(attempt) || attempt <= 0) {
        throw new UsageError(`--attempt must be a positive attempt number, got "${rawAttempt}"`);
      }
      const conclusion = flags.str("conclusion");
      if (!(RETRY_CONCLUSIONS as readonly string[]).includes(conclusion)) {
        throw new UsageError(`--conclusion must be one of ${RETRY_CONCLUSIONS.join(", ")}`);
      }
      const plan = readRetryPlan(
        flags.str("reports-dir"),
        attempt,
        conclusion as RetryConclusion,
      );
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
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
        if (upstreams[architecture] !== undefined) {
          throw new UsageError(`--upstream given more than once for ${architecture}`);
        }
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
    summary: "Neutralize the in-AppDir updater (--app, --appdir, [--failure-out F])",
    options: { app: APP, appdir: { type: "string" }, "failure-out": { type: "string" } },
    run: (flags) => {
      const appdir = flags.str("appdir");
      const descriptor = descriptorFor(flags);
      const report = neutralizeUpdater(descriptor, appdir);
      for (const file of report.patchedFiles) process.stderr.write(`[INFO] patched ${file}\n`);
      for (const file of report.removedFeedFiles) {
        process.stderr.write(`[INFO] removed update feed ${file}\n`);
      }
      if (report.removedJsonKeys.length > 0) {
        process.stderr.write(`[INFO] removed ${report.removedJsonKeys.join(", ")}\n`);
      }
      for (const warning of report.warnings) process.stderr.write(`[WARN] ${warning}\n`);
      if (descriptor.updater.residualScan !== undefined && report.survivors.length === 0) {
        process.stderr.write(`[INFO] verified no residual updater endpoints in ${appdir}\n`);
      }
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

// A classified failure is a verdict, not just an error: the CLI writes it to the
// run-record fragment the workflow uploads (--failure-out) and exits with a code
// that says "this one was classified", so the workflow passes it through
// unchanged. Every other error stays exit 1 — the record reports those as
// UNCLASSIFIED, which the retry workflow re-runs within its attempt cap.
interface FailureVerdict {
  readonly code: FailureCode;
  readonly exitCode: number;
  readonly evidence?: Record<string, string>;
}

function classifyFailure(error: unknown): FailureVerdict | undefined {
  if (error instanceof UpstreamUnavailableError) {
    return { code: "UPSTREAM_UNAVAILABLE", exitCode: 3, evidence: { ...error.evidence } };
  }
  if (error instanceof GuardViolationError) return { code: "GUARD_VIOLATION", exitCode: 4 };
  if (error instanceof ChecksumMismatchError) return { code: "CHECKSUM_MISMATCH", exitCode: 5 };
  if (error instanceof UpdaterResidualError) return { code: "UPDATER_RESIDUAL", exitCode: 6 };
  return undefined;
}

// The process exit code for a failed command: usage errors keep 2, classified
// failures use their own code (3-6), everything else is the generic 1.
export function errorExitCode(error: unknown): number {
  if (isUsageError(error)) return error.exitCode;
  return classifyFailure(error)?.exitCode ?? 1;
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
      tokens: true,
    });
  } catch (error) {
    // node:util's parse errors are usage errors, not crashes: an unknown or
    // valueless flag exits 2 with the parser's explanation.
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  // parseArgs keeps the last value of a repeated option, so a duplicate would
  // silently retarget the command; the CLI contract says exit 2 instead.
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    const option = command.options[token.name];
    if (option?.multiple === true) continue;
    if (seen.has(token.name)) {
      throw new UsageError(`Option --${token.name} was given more than once`);
    }
    seen.add(token.name);
  }
  const flags = new Flags(parsed.values as Values);
  try {
    // Awaited: several commands are async, so a failure arrives as a rejected
    // promise rather than a thrown value.
    return await command.run(flags, [...parsed.positionals]);
  } catch (error) {
    const verdict = classifyFailure(error);
    const failureOut = flags.optStr("failure-out");
    if (verdict !== undefined && failureOut !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      writeFailureFragment(failureOut, {
        code: verdict.code,
        message,
        evidence: verdict.evidence,
      });
    }
    throw error;
  }
}

export function isUsageError(error: unknown): error is UsageError {
  return error instanceof UsageError;
}
