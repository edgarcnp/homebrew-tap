// App descriptors: packaging/apps/<id>/app.json is the single source of truth
// for one packaged app. Everything the pipeline does to an app is derived from
// here, so a new app is data plus its templates, not a fork of the pipeline.

import * as fs from "node:fs";
import { assertSameLength, assertSingleLine, fail } from "./guards.ts";
import { APPS_DIR, descriptorPath } from "./paths.ts";
import type {
  AppDescriptor,
  IconConfig,
  Oracle,
  Payload,
  ResidualScan,
  UpdaterConfig,
} from "./types.ts";

const SAFE_ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
    case "github-release":
      return {
        kind,
        repository: str(source, "repository", label),
        assetPrefix: str(source, "assetPrefix", label),
      };
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

function validateIcon(raw: unknown, label: string): IconConfig {
  const source = asObject(raw, label);
  const size = str(source, "size", label);
  if (!/^\d+x\d+$/.test(size)) fail(`${label}.size must look like 512x512`);
  return {
    source: relativePath(str(source, "source", label), `${label}.source`),
    size,
  };
}

export function validateDescriptor(raw: unknown, expectedId: string): AppDescriptor {
  const label = `apps/${expectedId}/app.json`;
  const source = asObject(raw, label);
  const id = str(source, "id", label);
  if (id !== expectedId) fail(`${label}: id ${id} does not match directory ${expectedId}`);

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
    binaryTargets: strArray(source, "binaryTargets", label),
    oracle: validateOracle(source["oracle"], `${label}.oracle`),
    payload: validatePayload(source["payload"], `${label}.payload`),
    icon: validateIcon(source["icon"], `${label}.icon`),
    desktopTemplate: relativePath(str(source, "desktopTemplate", label), `${label}.desktopTemplate`),
    updater: validateUpdater(source["updater"], `${label}.updater`),
  };

  for (const [field, value] of [
    ["cask", descriptor.cask],
    ["assetPrefix", descriptor.assetPrefix],
    ["tagPrefix", descriptor.tagPrefix],
  ] as const) {
    if (!PACKAGE_NAME.test(value)) fail(`${label}.${field} is not a safe name: ${value}`);
  }
  if (!descriptor.sourceRepo.includes("/")) {
    fail(`${label}.sourceRepo must be "owner/repo"`);
  }
  // The pipeline names the built artifact after the cask token (so the cask
  // can pin its own release URL), while CI uploads and looks up release assets
  // by assetPrefix. They must be the same string or the build is unfindable.
  if (descriptor.assetPrefix !== descriptor.cask) {
    fail(`${label}.assetPrefix (${descriptor.assetPrefix}) must equal cask (${descriptor.cask})`);
  }
  if (descriptor.binaryTargets.length === 0) {
    fail(`${label}.binaryTargets must not be empty`);
  }
  return descriptor;
}

export function loadDescriptor(app: string): AppDescriptor {
  const file = descriptorPath(app);
  if (!PACKAGE_NAME.test(app)) fail(`Invalid app name: ${app}`);
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

export interface DescriptorExport {
  id: string;
  name: string;
  cask: string;
  asset_prefix: string;
  tag_prefix: string;
  source_repo: string;
  source_owner: string;
  source_dir: string;
  build_command: string;
  debloat_args: string;
  needs_webkit: string;
}

export function descriptorExport(descriptor: AppDescriptor): DescriptorExport {
  return {
    id: descriptor.id,
    name: descriptor.appName,
    cask: descriptor.cask,
    asset_prefix: descriptor.assetPrefix,
    tag_prefix: descriptor.tagPrefix,
    source_repo: descriptor.sourceRepo,
    source_owner: descriptor.sourceOwner,
    source_dir: descriptor.sourceDir,
    build_command: descriptor.buildCommand,
    debloat_args: descriptor.debloatArgs,
    needs_webkit: descriptor.needsWebkit ? "true" : "false",
  };
}

// KEY=VALUE lines for the two consumers in CI: `env` (uppercase) is written to
// $GITHUB_ENV so shell steps read plain variables, `output` (lowercase) is
// written to $GITHUB_OUTPUT because job outputs cannot read the env context.
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
    `ASSET_PREFIX=${values.asset_prefix}`,
    `TAG_PREFIX=${values.tag_prefix}`,
    `SOURCE_REPO=${values.source_repo}`,
    `SOURCE_OWNER=${values.source_owner}`,
    `SOURCE_DIR=${values.source_dir}`,
    `BUILD_COMMAND=${values.build_command}`,
    `DEBLOAT_ARGS=${values.debloat_args}`,
    `NEEDS_WEBKIT=${values.needs_webkit}`,
  ];
}
