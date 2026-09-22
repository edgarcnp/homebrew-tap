// App descriptors: apps/<id>/app.json is the single source of truth for one
// app, so a new app is data plus templates, not a fork of the pipeline.

import * as fs from "node:fs";
import { assertSameLength, assertSingleLine, fail } from "../core/guards.ts";
import { APPS_DIR, descriptorPath } from "../core/paths.ts";
import { GITHUB_API_REPOSITORY, SAFE_IDENTIFIER, SAFE_REFERENCE } from "../core/patterns.ts";
import { ARCHITECTURES, isArchitecture } from "../core/types.ts";
import type {
  AppDescriptor,
  Architecture,
  IconConfig,
  Oracle,
  Payload,
  QuickSharunConfig,
  ResidualScan,
  UpdaterConfig,
  WatchConfig,
} from "../core/types.ts";

const SAFE_ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

type Json = Record<string, unknown>;

function asObject(value: unknown, label: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Json;
}

function str(source: Json, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") fail(`${label}.${key} must be a non-empty string`);
  return assertSingleLine(value, `${label}.${key}`);
}

function optionalStr(source: Json, key: string, label: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  return str(source, key, label);
}

function bool(source: Json, key: string, label: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") fail(`${label}.${key} must be a boolean`);
  return value;
}

function strArray(source: Json, key: string, label: string): string[] {
  const value = source[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${label}.${key} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry === "") {
      fail(`${label}.${key}[${index}] must be a non-empty string`);
    }
    return assertSingleLine(entry, `${label}.${key}[${index}]`);
  });
}

// Relative, in-repo paths only: descriptors must not point outside the app.
function relativePath(value: string, label: string): string {
  if (value.startsWith("/") || value.includes("..")) {
    fail(`${label} must be a repository-relative path: ${value}`);
  }
  return value;
}

function validateOracle(raw: unknown, label: string): Oracle {
  const source = asObject(raw, label);
  const kind = str(source, "kind", label);
  switch (kind) {
    case "apt":
      return {
        kind,
        repository: str(source, "repository", label),
        packageName: str(source, "packageName", label),
        fingerprint: str(source, "fingerprint", label),
        keyBase64Path: relativePath(str(source, "keyBase64Path", label), `${label}.keyBase64Path`),
      };
    case "github-release": {
      const repository = str(source, "repository", label);
      if (!GITHUB_API_REPOSITORY.test(repository)) {
        fail(`${label}.repository must be a GitHub API repository URL: ${repository}`);
      }
      const hasPrefix = source["assetPrefix"] !== undefined;
      const hasTemplate = source["assetNameTemplate"] !== undefined;
      const hasTag = source["tagPrefix"] !== undefined;
      const hasPackage = source["packageName"] !== undefined;
      if (hasTemplate || hasTag || hasPackage) {
        if (hasPrefix) fail(`${label}: assetPrefix and assetNameTemplate are mutually exclusive`);
        if (!hasTemplate || !hasTag || !hasPackage) {
          fail(`${label}: assetNameTemplate, tagPrefix and packageName must be set together`);
        }
        const tagPrefix = str(source, "tagPrefix", label);
        if (!SAFE_REFERENCE.test(tagPrefix)) {
          fail(`${label}.tagPrefix is not a safe tag prefix: ${tagPrefix}`);
        }
        const assetNameTemplate = str(source, "assetNameTemplate", label);
        if (!assetNameTemplate.includes("{version}")) {
          fail(`${label}.assetNameTemplate must contain {version}: ${assetNameTemplate}`);
        }
        return {
          kind,
          repository,
          assetNameTemplate,
          tagPrefix,
          packageName: str(source, "packageName", label),
        };
      }
      return { kind, repository, assetPrefix: str(source, "assetPrefix", label) };
    }
    case "electron-feed":
      return {
        kind,
        repository: str(source, "repository", label),
        githubRepository: str(source, "githubRepository", label),
        tagPrefix: str(source, "tagPrefix", label),
        packageName: str(source, "packageName", label),
        assetNameTemplate: str(source, "assetNameTemplate", label),
      };
    case "cdn-redirect": {
      const redirectHosts = strArray(source, "redirectHosts", label);
      if (redirectHosts.length === 0) fail(`${label}.redirectHosts must not be empty`);
      return {
        kind,
        repository: str(source, "repository", label),
        redirectHosts,
        packageName: str(source, "packageName", label),
        debName: str(source, "debName", label),
      };
    }
    case "update-manifest": {
      const downloadHosts = strArray(source, "downloadHosts", label);
      if (downloadHosts.length === 0) fail(`${label}.downloadHosts must not be empty`);
      const assetTemplate = str(source, "assetTemplate", label);
      if (!assetTemplate.includes("{arch}")) {
        fail(`${label}.assetTemplate must contain {arch}: ${assetTemplate}`);
      }
      return {
        kind,
        repository: str(source, "repository", label),
        downloadHosts,
        packageName: str(source, "packageName", label),
        assetTemplate,
      };
    }
    case "avakot": {
      // Provider-specific manifest (see oracles/custom/): a fixed artifacts
      // key names the payload, so no {arch} placeholder is required.
      const downloadHosts = strArray(source, "downloadHosts", label);
      if (downloadHosts.length === 0) fail(`${label}.downloadHosts must not be empty`);
      return {
        kind,
        repository: str(source, "repository", label),
        downloadHosts,
        packageName: str(source, "packageName", label),
        assetTemplate: str(source, "assetTemplate", label),
      };
    }
    default:
      return fail(`Unknown resolver kind: ${kind}`);
  }
}

function validatePayload(raw: unknown, label: string): Payload {
  const source = asObject(raw, label);
  const kind = str(source, "kind", label);
  if (kind === "deb-tree") {
    return {
      kind,
      tree: relativePath(str(source, "tree", label).replace(/^\/+/, ""), `${label}.tree`),
    };
  }
  if (kind === "deb-files") {
    const files = strArray(source, "files", label).map((entry) =>
      relativePath(entry.replace(/^\/+/, ""), `${label}.files`),
    );
    if (files.length === 0) fail(`${label}.files must not be empty`);
    return { kind, files };
  }
  if (kind === "appimage-tree") {
    const renameRaw = source["rename"];
    const rename: Record<string, string> = {};
    if (renameRaw !== undefined) {
      for (const [from, to] of Object.entries(asObject(renameRaw, `${label}.rename`))) {
        if (typeof to !== "string" || to === "") fail(`${label}.rename.${from} must be a string`);
        rename[assertSingleLine(from, `${label}.rename`)] = assertSingleLine(
          to,
          `${label}.rename.${from}`,
        );
      }
    }
    const moveUsr = source["moveUsrToRoot"];
    return {
      kind,
      rename,
      exclude: strArray(source, "exclude", label),
      moveUsrToRoot: moveUsr === undefined ? false : bool(source, "moveUsrToRoot", label),
    };
  }
  return fail(`Unknown payload kind: ${kind}`);
}

function validateResidualScan(raw: unknown, label: string): ResidualScan {
  const source = asObject(raw, label);
  const patterns = strArray(source, "patterns", label);
  if (patterns.length === 0) fail(`${label}.patterns must not be empty`);
  const severity = str(source, "severity", label);
  if (severity !== "error" && severity !== "warning") {
    fail(`${label}.severity must be "error" or "warning"`);
  }
  return { patterns, severity };
}

function validateUpdater(raw: unknown, label: string): UpdaterConfig {
  if (raw === undefined) return {};
  const source = asObject(raw, label);
  const updater: UpdaterConfig = {};

  const removeJsonKeys = source["removeJsonKeys"];
  if (removeJsonKeys !== undefined) {
    const keysSource = asObject(removeJsonKeys, `${label}.removeJsonKeys`);
    updater.removeJsonKeys = {
      file: relativePath(
        str(keysSource, "file", `${label}.removeJsonKeys`),
        `${label}.removeJsonKeys.file`,
      ),
      keys: strArray(keysSource, "keys", `${label}.removeJsonKeys`),
    };
    if (updater.removeJsonKeys.keys.length === 0) {
      fail(`${label}.removeJsonKeys.keys must not be empty`);
    }
  }

  const patch = source["patchEndpoint"];
  if (patch !== undefined) {
    const patchSource = asObject(patch, `${label}.patchEndpoint`);
    const targets = patchSource["targets"];
    const from = str(patchSource, "from", `${label}.patchEndpoint`);
    const binaryReplacement = str(patchSource, "binaryReplacement", `${label}.patchEndpoint`);
    // Enforced at load time: an in-place ELF edit must not shift bytes.
    assertSameLength(from, binaryReplacement, `${label}.patchEndpoint`);
    updater.patchEndpoint = {
      from,
      textReplacement: str(patchSource, "textReplacement", `${label}.patchEndpoint`),
      binaryReplacement,
      targets:
        targets === "all" ? "all" : strArray(patchSource, "targets", `${label}.patchEndpoint`),
    };
  }

  const removeFeed = source["removeFeed"];
  if (removeFeed !== undefined) {
    const feedSource = asObject(removeFeed, `${label}.removeFeed`);
    const paths = strArray(feedSource, "paths", `${label}.removeFeed`).map((entry) =>
      relativePath(entry, `${label}.removeFeed.paths`),
    );
    if (paths.length === 0) fail(`${label}.removeFeed.paths must not be empty`);
    updater.removeFeed = {
      paths,
      required: bool(feedSource, "required", `${label}.removeFeed`),
    };
  }

  const envRaw = source["env"];
  if (envRaw !== undefined) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(asObject(envRaw, `${label}.env`))) {
      if (!SAFE_ENV_KEY.test(key)) fail(`${label}.env key is not a valid name: ${key}`);
      if (typeof value !== "string") fail(`${label}.env.${key} must be a string`);
      env[key] = assertSingleLine(value, `${label}.env.${key}`);
    }
    updater.env = env;
  }

  const hook = optionalStr(source, "hook", label);
  if (hook !== undefined) updater.hook = relativePath(hook, `${label}.hook`);

  const scan = source["residualScan"];
  if (scan !== undefined) updater.residualScan = validateResidualScan(scan, `${label}.residualScan`);

  return updater;
}

// Hooks are colon-joined into ADD_HOOKS, so a name must not contain ":" or
// whitespace that would split the list.
function validateQuickSharun(raw: unknown, label: string): QuickSharunConfig {
  if (raw === undefined) return {};
  const source = asObject(raw, label);
  const config: QuickSharunConfig = {};

  const hooks = strArray(source, "hooks", label);
  for (const [index, hook] of hooks.entries()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hook)) {
      fail(`${label}.hooks[${index}] is not a hook name: ${hook}`);
    }
  }
  if (hooks.length > 0) config.hooks = hooks;

  // Absolute paths: the pipeline passes them to quick-sharun unchanged, and a
  // relative one would resolve against whatever directory CI runs in.
  const libraries = strArray(source, "libraries", label);
  for (const [index, library] of libraries.entries()) {
    if (!library.startsWith("/")) {
      fail(`${label}.libraries[${index}] must be an absolute path: ${library}`);
    }
  }
  if (libraries.length > 0) config.libraries = libraries;

  const envRaw = source["env"];
  if (envRaw !== undefined) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(asObject(envRaw, `${label}.env`))) {
      if (!SAFE_ENV_KEY.test(key)) fail(`${label}.env key is not a valid name: ${key}`);
      if (typeof value !== "string") fail(`${label}.env.${key} must be a string`);
      env[key] = assertSingleLine(value, `${label}.env.${key}`);
    }
    config.env = env;
  }

  return config;
}

function validateArchitectures(raw: unknown, label: string): Architecture[] {
  if (raw === undefined) return [...ARCHITECTURES];
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(`${label}.architectures must be a non-empty array`);
  }
  const seen = new Set<string>();
  const architectures: Architecture[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isArchitecture(entry)) {
      fail(`${label}.architectures[${index}] must be one of ${ARCHITECTURES.join(", ")}`);
    }
    if (seen.has(entry)) fail(`${label}.architectures must not contain duplicates`);
    seen.add(entry);
    architectures.push(entry);
  }
  return architectures;
}

function validateHostHelpers(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail(`${label} must be an array`);
  return raw.map((entry, index) => {
    if (typeof entry !== "string" || entry === "") {
      fail(`${label}[${index}] must be a non-empty string`);
    }
    const helper = assertSingleLine(entry, `${label}[${index}]`);
    if (helper.startsWith("/") || helper.includes("..")) {
      fail(`${label}[${index}] must be an AppDir-relative path: ${helper}`);
    }
    if (!helper.startsWith("bin/") || helper === "bin/") {
      fail(`${label}[${index}] must be a file under bin/: ${helper}`);
    }
    return helper;
  });
}

function validateIcon(raw: unknown, label: string): IconConfig {
  const source = asObject(raw, label);
  const size = str(source, "size", label);
  if (!/^\d+x\d+$/.test(size)) fail(`${label}.size must look like 512x512`);
  return {
    source: relativePath(str(source, "source", label), `${label}.source`),
    size,
  };
}

// The watcher compiles these as RegExp when it polls, so a malformed pattern
// must fail here rather than silently leaving the app unwatched.
function compiledPattern(value: string, label: string): string {
  try {
    new RegExp(value);
  } catch {
    fail(`${label} must be a valid regular expression: ${value}`);
  }
  return value;
}

function validateWatch(raw: unknown, label: string): WatchConfig | undefined {
  if (raw === undefined) return undefined;
  const source = asObject(raw, label);
  // Required, not defaulted: every descriptor declares its format, so an
  // omission is a mistake rather than a shorthand. The API's reader stays
  // liberal — a descriptor it did not write (or one written before this rule)
  // still reads an absent format as atom.
  const format = str(source, "format", label);
  if (format !== "atom" && format !== "json") {
    fail(`${label}.format must be "atom" or "json": ${format}`);
  }
  const watch: WatchConfig = {
    feedUrl: str(source, "feedUrl", label),
    format,
    versionPattern: compiledPattern(str(source, "versionPattern", label), `${label}.versionPattern`),
  };
  const skipPattern = optionalStr(source, "skipPattern", label);
  if (skipPattern !== undefined) {
    watch.skipPattern = compiledPattern(skipPattern, `${label}.skipPattern`);
  }
  const repo = optionalStr(source, "repo", label);
  if (repo !== undefined) watch.repo = repo;
  // JSON feeds (e.g. avakot's manifest) carry a single version string at a
  // dotted path instead of atom entry titles; atom feeds must not set it, so
  // a misplaced field fails here rather than being silently ignored.
  const versionField = optionalStr(source, "versionField", label);
  if (watch.format === "json") {
    if (versionField === undefined) fail(`${label}.versionField is required when format is "json"`);
    if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(versionField)) {
      fail(`${label}.versionField must be a dotted field path: ${versionField}`);
    }
    watch.versionField = versionField;
  } else if (versionField !== undefined) {
    fail(`${label}.versionField requires format "json"`);
  }
  return watch;
}

export function validateDescriptor(raw: unknown, expectedId: string): AppDescriptor {
  const label = `apps/${expectedId}/app.json`;
  const source = asObject(raw, label);
  const id = str(source, "id", label);
  if (id !== expectedId) fail(`${label}: id ${id} does not match directory ${expectedId}`);

  const watch = validateWatch(source["watch"], `${label}.watch`);
  const hostHelpers = validateHostHelpers(source["hostHelpers"], `${label}.hostHelpers`);
  const descriptor: AppDescriptor = {
    id,
    appName: str(source, "appName", label),
    displayName: str(source, "displayName", label),
    comment: str(source, "comment", label),
    cask: str(source, "cask", label),
    assetPrefix: str(source, "assetPrefix", label),
    tagPrefix: str(source, "tagPrefix", label),
    sourceRepo: str(source, "sourceRepo", label),
    sourceOwner: str(source, "sourceOwner", label),
    sourceDir: relativePath(str(source, "sourceDir", label), `${label}.sourceDir`),
    buildCommand: str(source, "buildCommand", label),
    debloatArgs: str(source, "debloatArgs", label),
    needsWebkit: bool(source, "needsWebkit", label),
    buildPackages: strArray(source, "buildPackages", label),
    architectures: validateArchitectures(source["architectures"], label),
    binaryTargets: strArray(source, "binaryTargets", label),
    oracle: validateOracle(source["oracle"], `${label}.oracle`),
    payload: validatePayload(source["payload"], `${label}.payload`),
    icon: validateIcon(source["icon"], `${label}.icon`),
    desktopTemplate: relativePath(str(source, "desktopTemplate", label), `${label}.desktopTemplate`),
    updater: validateUpdater(source["updater"], `${label}.updater`),
    quickSharun: validateQuickSharun(source["quickSharun"], `${label}.quickSharun`),
  };
  if (watch !== undefined) descriptor.watch = watch;
  if (hostHelpers !== undefined) descriptor.hostHelpers = hostHelpers;

  for (const [field, value] of [
    ["cask", descriptor.cask],
    ["assetPrefix", descriptor.assetPrefix],
    ["tagPrefix", descriptor.tagPrefix],
  ] as const) {
    if (!SAFE_IDENTIFIER.test(value)) fail(`${label}.${field} is not a safe name: ${value}`);
  }
  if (!descriptor.sourceRepo.includes("/")) {
    fail(`${label}.sourceRepo must be "owner/repo"`);
  }
  // The artifact is named after the cask token; CI looks it up by assetPrefix.
  // They must match or the build is unfindable.
  if (descriptor.assetPrefix !== descriptor.cask) {
    fail(`${label}.assetPrefix (${descriptor.assetPrefix}) must equal cask (${descriptor.cask})`);
  }
  // Dispatch reaches the app by id or cask token, so they must be one string —
  // keeping app id, cask token and asset prefix the same name.
  if (descriptor.id !== descriptor.cask) {
    fail(`${label}.id (${descriptor.id}) must equal cask (${descriptor.cask})`);
  }
  if (descriptor.binaryTargets.length === 0) {
    fail(`${label}.binaryTargets must not be empty`);
  }
  return descriptor;
}

export function loadDescriptor(app: string): AppDescriptor {
  const file = descriptorPath(app);
  if (!SAFE_IDENTIFIER.test(app)) fail(`Invalid app name: ${app}`);
  if (!fs.existsSync(file)) fail(`Unknown app "${app}" (no ${file})`);
  return validateDescriptor(JSON.parse(fs.readFileSync(file, "utf8")), app);
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

export interface DescriptorExport {
  id: string;
  name: string;
  cask: string;
  // The release-watch block as compact JSON, or "" when the app has none.
  watch: string;
  asset_prefix: string;
  tag_prefix: string;
  source_repo: string;
  source_owner: string;
  source_dir: string;
  build_command: string;
  debloat_args: string;
  needs_webkit: string;
  // Space-separated; "" when the app declares no build packages.
  build_packages: string;
  architectures: string;
}

export function descriptorExport(descriptor: AppDescriptor): DescriptorExport {
  return {
    id: descriptor.id,
    name: descriptor.appName,
    cask: descriptor.cask,
    watch: descriptor.watch === undefined ? "" : JSON.stringify(descriptor.watch),
    asset_prefix: descriptor.assetPrefix,
    tag_prefix: descriptor.tagPrefix,
    source_repo: descriptor.sourceRepo,
    source_owner: descriptor.sourceOwner,
    source_dir: descriptor.sourceDir,
    build_command: descriptor.buildCommand,
    debloat_args: descriptor.debloatArgs,
    needs_webkit: descriptor.needsWebkit ? "true" : "false",
    build_packages: descriptor.buildPackages.join(" "),
    architectures: JSON.stringify(descriptor.architectures),
  };
}

// KEY=VALUE lines for CI: `env` (uppercase) goes to $GITHUB_ENV for shell
// steps, `output` (lowercase) to $GITHUB_OUTPUT, which cannot read env.
export function descriptorLines(
  descriptor: AppDescriptor,
  format: "env" | "output" = "env",
): string[] {
  const values = descriptorExport(descriptor);
  if (format === "output") {
    return Object.entries(values).map(([key, value]) => `${key}=${value}`);
  }
  return [
    `APP_ID=${values.id}`,
    `APP_NAME=${values.name}`,
    `APP_CASK=${values.cask}`,
    `WATCH=${values.watch}`,
    `ASSET_PREFIX=${values.asset_prefix}`,
    `TAG_PREFIX=${values.tag_prefix}`,
    `SOURCE_REPO=${values.source_repo}`,
    `SOURCE_OWNER=${values.source_owner}`,
    `SOURCE_DIR=${values.source_dir}`,
    `BUILD_COMMAND=${values.build_command}`,
    `DEBLOAT_ARGS=${values.debloat_args}`,
    `NEEDS_WEBKIT=${values.needs_webkit}`,
    `BUILD_PACKAGES=${values.build_packages}`,
    `APP_ARCHITECTURES=${values.architectures}`,
  ];
}
