// Descriptor validation, split into two layers:
//
//  1. appDescriptorSchema.safeParse checks the shape, every scalar pattern,
//     array bounds and unknown fields. The Zod schema in app.ts is the one
//     source: AppDescriptorInput is inferred from it.
//  2. the semantic pass below expresses what the schema cannot: path
//     containment, cross-field identity, artifact/payload compatibility and
//     the single-line rules the shell pipeline depends on.

import { ARCHITECTURES } from "../core/architecture.ts";
import { DescriptorError } from "../core/errors.ts";
import {
  assertHttpsUrl,
  assertMatches,
  assertSafeName,
  assertSameLength,
  assertSingleLine,
  fail,
  isRecord,
} from "../core/guards.ts";
import { GITHUB_API_REPOSITORY, GITHUB_RELEASE_FEED, SAFE_REFERENCE } from "../core/patterns.ts";
import { hasPlaceholder } from "../core/template.ts";
import { ARTIFACT_KINDS, type Artifact } from "./artifact.ts";
import { appDescriptorSchema, type AppDescriptor, type AppDescriptorInput, type QuickSharunConfig, type SmokeConfig } from "./app.ts";
import { PAYLOAD_KINDS, type Payload } from "./payload.ts";
import type { UpdaterConfig } from "./updater.ts";
import type { WatchConfig } from "./watch.ts";

interface IssueLike {
  readonly path: readonly (string | number | symbol)[];
  readonly code: string;
  readonly message: string;
  readonly keys?: readonly string[];
}

// A Zod issue rewritten in the descriptor's vocabulary. Unknown keys get the
// authored property path; every other issue keeps Zod's own explanation.
function formatIssues(label: string, issues: readonly IssueLike[]): string {
  const issue = issues[0];
  if (issue === undefined) return `${label} is invalid`;
  const path = issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : "";
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys ?? [];
    return keys.map((key) => `${label}${path}.${key} is not a known field`).join("; ");
  }
  return `${label}${path}: ${issue.message}`;
}

function requireKind(
  value: unknown,
  label: string,
  key: "artifact" | "payload",
  allowed: readonly string[],
): void {
  if (!isRecord(value)) fail(`${label}.${key} must be an object`);
  const kind = value["kind"];
  if (typeof kind !== "string" || !allowed.includes(kind)) {
    fail(`Unknown ${key} kind: ${String(kind)}`);
  }
}

// Repository-relative paths only: a descriptor must not point outside the app.
// `RelativePath` already rejects an absolute path; this is the segment check.
function relativePath(value: string, label: string): string {
  if (value.startsWith("/") || value.split("/").includes("..")) {
    fail(`${label} must be a repository-relative path: ${value}`);
  }
  return value;
}

// An entry name or glob applied to the top level of a payload tree.
function topLevelEntry(value: string, label: string): string {
  if (value.includes("/") || value.includes("..")) {
    fail(`${label} must be a top-level name or glob: ${value}`);
  }
  return value;
}

function compiledPattern(value: string, label: string): string {
  try {
    new RegExp(value);
  } catch {
    fail(`${label} must be a valid regular expression: ${value}`);
  }
  return value;
}

function validateArtifact(artifact: Artifact, label: string): void {
  switch (artifact.kind) {
    case "github-release":
      assertMatches(artifact.repository, GITHUB_API_REPOSITORY, `${label}.repository`);
      if (!hasPlaceholder(artifact.assetNameTemplate)) {
        fail(`${label}.assetNameTemplate must contain a placeholder: ${artifact.assetNameTemplate}`);
      }
      assertMatches(artifact.tagPrefix, SAFE_REFERENCE, `${label}.tagPrefix`);
      assertMatches(artifact.packageName, SAFE_REFERENCE, `${label}.packageName`);
      break;
    case "json-asset":
      assertHttpsUrl(artifact.url, `${label}.url`);
      unique(artifact.downloadHosts, `${label}.downloadHosts`);
      for (const [index, host] of artifact.downloadHosts.entries()) {
        assertSafeName(host, `${label}.downloadHosts[${index}]`);
      }
      assertMatches(artifact.packageName, SAFE_REFERENCE, `${label}.packageName`);
      break;
    case "mozilla-release":
      assertHttpsUrl(artifact.urlTemplate, `${label}.urlTemplate`);
      if (!artifact.urlTemplate.includes("{version}")) {
        fail(`${label}.urlTemplate must contain {version}: ${artifact.urlTemplate}`);
      }
      if (!artifact.signatureTemplate.includes("{url}")) {
        fail(`${label}.signatureTemplate must contain {url}: ${artifact.signatureTemplate}`);
      }
      relativePath(artifact.keyPath, `${label}.keyPath`);
      assertMatches(artifact.packageName, SAFE_REFERENCE, `${label}.packageName`);
      break;
    case "update-manifest":
      assertHttpsUrl(artifact.repository, `${label}.repository`);
      unique(artifact.downloadHosts, `${label}.downloadHosts`);
      for (const [index, host] of artifact.downloadHosts.entries()) {
        assertSafeName(host, `${label}.downloadHosts[${index}]`);
      }
      if (!artifact.assetTemplate.includes("{arch}")) {
        fail(`${label}.assetTemplate must contain {arch}: ${artifact.assetTemplate}`);
      }
      assertMatches(artifact.packageName, SAFE_REFERENCE, `${label}.packageName`);
      break;
    case "avakot":
      assertHttpsUrl(artifact.repository, `${label}.repository`);
      unique(artifact.downloadHosts, `${label}.downloadHosts`);
      for (const [index, host] of artifact.downloadHosts.entries()) {
        assertSafeName(host, `${label}.downloadHosts[${index}]`);
      }
      assertMatches(artifact.packageName, SAFE_REFERENCE, `${label}.packageName`);
      break;
  }
}

// AppDir paths the pack stages own: quick-sharun writes the AppRun machinery
// and the sharun runtime, the finalize stage writes .env, and shared/ is the
// symlink tree it resolves through. A payload tree staged there is either
// overwritten silently or breaks packing, so it is refused up front.
const RESERVED_APP_DIR_TARGETS = new Set([
  ".env",
  "AppRun",
  "AppRun.lib",
  "AppRun.sh",
  "dash",
  "sharun",
]);

// A target a deb-files tree may not stage into: bin/ is where `files` goes, and
// the rest belong to the pack stages.
function assertStageableTreeTarget(target: string, label: string): void {
  const root = target.split("/")[0] ?? "";
  if (root === "bin") {
    fail(`${label} must stay outside bin/, which deb-files stages: ${target}`);
  }
  if (root === "shared" || RESERVED_APP_DIR_TARGETS.has(root)) {
    fail(`${label} is reserved by the pack stages: ${target}`);
  }
}

function validatePayload(payload: Payload, label: string): void {
  switch (payload.kind) {
    case "deb-tree":
      relativePath(payload.tree, `${label}.tree`);
      break;
    case "deb-files": {
      payload.files.forEach((file, index) => {
        relativePath(file, `${label}.files[${index}]`);
      });
      const treeTargets = new Set<string>();
      for (const [index, tree] of (payload.trees ?? []).entries()) {
        relativePath(tree.source, `${label}.trees[${index}].source`);
        relativePath(tree.target, `${label}.trees[${index}].target`);
        assertStageableTreeTarget(tree.target, `${label}.trees[${index}].target`);
        if (treeTargets.has(tree.target)) {
          fail(`${label}.trees[${index}].target duplicates ${tree.target}`);
        }
        treeTargets.add(tree.target);
      }
      break;
    }
    case "appimage-tree":
      for (const [from, to] of Object.entries(payload.rename ?? {})) {
        assertSafeName(from, `${label}.rename key`);
        relativePath(to, `${label}.rename.${from}`);
      }
      for (const [index, entry] of (payload.exclude ?? []).entries()) {
        topLevelEntry(entry, `${label}.exclude[${index}]`);
      }
      break;
    case "tarball-tree":
      if (payload.root !== undefined) relativePath(payload.root, `${label}.root`);
      for (const [index, entry] of (payload.exclude ?? []).entries()) {
        topLevelEntry(entry, `${label}.exclude[${index}]`);
      }
      break;
  }
}

function validateUpdater(updater: UpdaterConfig, label: string): void {
  const removeJsonKeys = updater.removeJsonKeys;
  if (removeJsonKeys !== undefined) {
    relativePath(removeJsonKeys.file, `${label}.removeJsonKeys.file`);
    removeJsonKeys.keys.forEach((key, index) => {
      assertSingleLine(key, `${label}.removeJsonKeys.keys[${index}]`);
    });
  }

  const patch = updater.patchEndpoint;
  if (patch !== undefined) {
    assertSingleLine(patch.from, `${label}.patchEndpoint.from`);
    assertSingleLine(patch.textReplacement, `${label}.patchEndpoint.textReplacement`);
    assertSingleLine(patch.binaryReplacement, `${label}.patchEndpoint.binaryReplacement`);
    // Enforced at load time: an in-place ELF edit must not shift bytes.
    assertSameLength(patch.from, patch.binaryReplacement, `${label}.patchEndpoint`);
    if (patch.targets !== "all") {
      patch.targets.forEach((target, index) => {
        relativePath(target, `${label}.patchEndpoint.targets[${index}]`);
      });
    }
  }

  const removeFeed = updater.removeFeed;
  if (removeFeed !== undefined) {
    removeFeed.paths.forEach((feed, index) => {
      relativePath(feed, `${label}.removeFeed.paths[${index}]`);
    });
  }

  for (const [key, value] of Object.entries(updater.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`${label}.env key is not a valid name: ${key}`);
    assertSingleLine(value, `${label}.env.${key}`);
  }

  if (updater.hook !== undefined) relativePath(updater.hook, `${label}.hook`);

  const scan = updater.residualScan;
  if (scan !== undefined) {
    scan.patterns.forEach((pattern, index) => {
      assertSingleLine(pattern, `${label}.residualScan.patterns[${index}]`);
    });
  }
}

function validateQuickSharun(config: QuickSharunConfig, label: string): void {
  // Hooks are colon-joined into ADD_HOOKS, so a name must not contain ":" or
  // whitespace that would split the list.
  for (const [index, hook] of (config.hooks ?? []).entries()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hook)) {
      fail(`${label}.hooks[${index}] is not a hook name: ${hook}`);
    }
  }
  // Absolute paths: the pipeline passes them to quick-sharun unchanged, and a
  // relative one would resolve against whatever directory CI runs in.
  for (const [index, library] of (config.libraries ?? []).entries()) {
    if (!library.startsWith("/")) {
      fail(`${label}.libraries[${index}] must be an absolute path: ${library}`);
    }
  }
  // AppDir-relative: the pipeline resolves them against the staged AppDir,
  // where bin/ files are targets already.
  const targets = new Set<string>();
  const names = new Set<string>();
  for (const [index, target] of (config.targets ?? []).entries()) {
    relativePath(target, `${label}.targets[${index}]`);
    if (target === "bin" || target.startsWith("bin/")) {
      fail(`${label}.targets[${index}] is a staged bin/ file, which is a target already: ${target}`);
    }
    if (targets.has(target)) fail(`${label}.targets[${index}] duplicates ${target}`);
    targets.add(target);
    // quick-sharun keeps one wrapper per basename: two targets with the same
    // name would both resolve to the same shared/bin entry.
    const name = target.slice(target.lastIndexOf("/") + 1);
    if (names.has(name)) {
      fail(`${label}.targets[${index}] shares the basename ${name} with another target`);
    }
    names.add(name);
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`${label}.env key is not a valid name: ${key}`);
    assertSingleLine(value, `${label}.env.${key}`);
  }
}

// /proc/<pid>/comm is capped at 15 bytes by the kernel, so a longer name could
// never match and would silently fail to exempt the process it names.
const DEFUNCT_PROCESS_NAME = /^[A-Za-z0-9._+-]{1,15}$/;

function validateSmoke(smoke: SmokeConfig, label: string): void {
  const names = smoke.ignoreDefunct;
  // An empty smoke block is a mistake: it says "there are exceptions" without
  // naming one.
  if (names === undefined) fail(`${label}.ignoreDefunct must not be empty`);
  if (names.length === 0) fail(`${label}.ignoreDefunct must not be empty`);
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (!DEFUNCT_PROCESS_NAME.test(name)) {
      fail(`${label}.ignoreDefunct[${index}] is not a process name: ${name}`);
    }
    if (seen.has(name)) fail(`${label}.ignoreDefunct[${index}] duplicates ${name}`);
    seen.add(name);
  }
}

function validateWatch(watch: WatchConfig, label: string): void {
  assertHttpsUrl(watch.feedUrl, `${label}.feedUrl`);
  // The GitHub releases transport fetches the pinned API path behind the
  // shared bearer PAT, so only that URL shape may name it.
  if (watch.format === "github-release") {
    if (!GITHUB_RELEASE_FEED.test(watch.feedUrl)) {
      fail(
        `${label}.feedUrl must be a GitHub releases-list URL ` +
          `(https://api.github.com/repos/<owner>/<repo>/releases): ${watch.feedUrl}`,
      );
    }
    if (watch.repo !== undefined) {
      const expected = `https://api.github.com/repos/${watch.repo}/releases`;
      if (watch.feedUrl.replace(/\/+$/, "") !== expected) {
        fail(`${label}.feedUrl does not match watch.repo ${watch.repo}`);
      }
    }
  }
  compiledPattern(watch.versionPattern, `${label}.versionPattern`);
  if (watch.skipPattern !== undefined) {
    compiledPattern(watch.skipPattern, `${label}.skipPattern`);
  }
  if (watch.format === "json") {
    if (watch.versionField === undefined) {
      fail(`${label}.versionField is required when format is "json"`);
    }
  } else if (watch.versionField !== undefined) {
    fail(`${label}.versionField requires format "json"`);
  }
}

function singleLine(value: string, label: string): void {
  assertSingleLine(value, label);
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) fail(`${label}[${index}] duplicates ${value}`);
    seen.add(value);
  }
}

function validateIdentity(descriptor: AppDescriptorInput, expectedId: string, label: string): void {
  if (descriptor.id !== expectedId) {
    fail(`${label}: id ${descriptor.id} does not match directory ${expectedId}`);
  }
  // Dispatch reaches the app by id or cask token, so they must be one string —
  // keeping app id, cask token and asset prefix the same name.
  if (descriptor.id !== descriptor.cask) {
    fail(`${label}.id (${descriptor.id}) must equal cask (${descriptor.cask})`);
  }
  if (descriptor.assetPrefix !== descriptor.cask) {
    fail(`${label}.assetPrefix (${descriptor.assetPrefix}) must equal cask (${descriptor.cask})`);
  }
  relativePath(descriptor.sourceDir, `${label}.sourceDir`);
  const expectedSourceDir = `packaging/apps/${expectedId}`;
  if (descriptor.sourceDir !== expectedSourceDir) {
    fail(`${label}.sourceDir must be ${expectedSourceDir}: ${descriptor.sourceDir}`);
  }
  if (descriptor.sourceRepo.split("/").some((part) => part === "." || part === "..")) {
    fail(`${label}.sourceRepo must not contain a dot segment: ${descriptor.sourceRepo}`);
  }
}

function validateText(descriptor: AppDescriptorInput, label: string): void {
  singleLine(descriptor.appName, `${label}.appName`);
  singleLine(descriptor.displayName, `${label}.displayName`);
  singleLine(descriptor.comment, `${label}.comment`);
  singleLine(descriptor.buildCommand, `${label}.buildCommand`);
  singleLine(descriptor.debloatArgs, `${label}.debloatArgs`);
  unique(descriptor.binaryTargets, `${label}.binaryTargets`);
  if (descriptor.architectures !== undefined) {
    unique(descriptor.architectures, `${label}.architectures`);
  }
  for (const [index, pkg] of (descriptor.buildPackages ?? []).entries()) {
    assertMatches(pkg, /^[a-z0-9][a-z0-9@._+-]*$/, `${label}.buildPackages[${index}]`);
  }
  if (descriptor.hostHelpers !== undefined) {
    unique(descriptor.hostHelpers, `${label}.hostHelpers`);
  }
  for (const [index, helper] of (descriptor.hostHelpers ?? []).entries()) {
    if (helper.startsWith("/") || helper.split("/").includes("..")) {
      fail(`${label}.hostHelpers[${index}] must be an AppDir-relative path: ${helper}`);
    }
    if (!helper.startsWith("bin/") || helper === "bin/") {
      fail(`${label}.hostHelpers[${index}] must be a file under bin/: ${helper}`);
    }
  }
}

function validatePresentation(descriptor: AppDescriptorInput, label: string): void {
  relativePath(descriptor.icon.source, `${label}.icon.source`);
  relativePath(descriptor.desktopTemplate, `${label}.desktopTemplate`);

  const entry = descriptor.caskDesktopEntry;
  if (entry !== undefined) {
    relativePath(entry.from, `${label}.caskDesktopEntry.from`);
    assertSingleLine(entry.exec, `${label}.caskDesktopEntry.exec`);
    if (!/^Exec=[^"\\\r\n]+$/.test(entry.exec)) {
      fail(`${label}.caskDesktopEntry.exec must be one "Exec=<command>" line`);
    }
  }

  const targets = new Set<string>();
  for (const [index, file] of (descriptor.extraFiles ?? []).entries()) {
    relativePath(file.source, `${label}.extraFiles[${index}].source`);
    relativePath(file.target, `${label}.extraFiles[${index}].target`);
    if (targets.has(file.target)) fail(`${label}.extraFiles[${index}].target duplicates ${file.target}`);
    targets.add(file.target);
  }

  const links = new Set<string>();
  for (const [index, link] of (descriptor.appDirLinks ?? []).entries()) {
    relativePath(link.link, `${label}.appDirLinks[${index}].link`);
    relativePath(link.target, `${label}.appDirLinks[${index}].target`);
    if (link.link === "bin/" || link.link === "bin") {
      fail(`${label}.appDirLinks[${index}].link must not be the staged bin directory`);
    }
    if (links.has(link.link)) fail(`${label}.appDirLinks[${index}].link duplicates ${link.link}`);
    links.add(link.link);
  }
}

function validateCompatibility(descriptor: AppDescriptorInput, label: string): void {
  const { artifact, payload } = descriptor;
  const architectures = descriptor.architectures ?? [...ARCHITECTURES];

  if (artifact.kind === "mozilla-release") {
    if (payload.kind !== "tarball-tree") {
      fail(`${label}.payload must be tarball-tree for a mozilla-release artifact`);
    }
    if (
      architectures.length > 1 &&
      !artifact.urlTemplate.includes("{arch}") &&
      !artifact.urlTemplate.includes("{appimage_arch}")
    ) {
      fail(`${label}.artifact.urlTemplate must name the architecture for a multi-arch app`);
    }
  }

  if (artifact.kind === "update-manifest" || artifact.kind === "avakot") {
    if (payload.kind !== "deb-tree" && payload.kind !== "deb-files") {
      fail(`${label}.payload must be deb-tree or deb-files for a ${artifact.kind} artifact`);
    }
  }

  if (artifact.kind === "github-release") {
    const name = artifact.assetNameTemplate;
    if (name.endsWith(".deb")) {
      if (payload.kind !== "deb-tree" && payload.kind !== "deb-files") {
        fail(`${label}.payload must be deb-tree or deb-files for a .deb asset`);
      }
    } else if (name.endsWith(".AppImage")) {
      if (payload.kind !== "appimage-tree") {
        fail(`${label}.payload must be appimage-tree for an .AppImage asset`);
      }
    } else if (name.endsWith(".tar.gz") || name.endsWith(".tar.xz")) {
      if (payload.kind !== "tarball-tree") {
        fail(`${label}.payload must be tarball-tree for a tarball asset`);
      }
    } else {
      fail(`${label}.artifact.assetNameTemplate has an unsupported container: ${name}`);
    }
    if (
      architectures.length > 1 &&
      !name.includes("{arch}") &&
      !name.includes("{appimage_arch}")
    ) {
      fail(`${label}.artifact.assetNameTemplate must name the architecture for a multi-arch app`);
    }
  }
}

function normalize(input: AppDescriptorInput): AppDescriptor {
  const payload: Payload =
    input.payload.kind === "appimage-tree"
      ? {
          ...input.payload,
          rename: input.payload.rename ?? {},
          exclude: input.payload.exclude ?? [],
          moveUsrToRoot: input.payload.moveUsrToRoot ?? false,
        }
      : input.payload;
  return {
    ...input,
    payload,
    architectures: input.architectures ?? [...ARCHITECTURES],
    buildPackages: input.buildPackages ?? [],
    updater: input.updater ?? {},
    quickSharun: input.quickSharun ?? {},
  };
}

export function validateDescriptor(raw: unknown, expectedId: string): AppDescriptor {
  const label = `apps/${expectedId}/app.json`;
  try {
    if (!isRecord(raw)) fail(`${label} must be an object`);
    requireKind(raw["artifact"], label, "artifact", ARTIFACT_KINDS);
    requireKind(raw["payload"], label, "payload", PAYLOAD_KINDS);

    const parsed = appDescriptorSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DescriptorError(formatIssues(label, parsed.error.issues));
    }
    const input: AppDescriptorInput = parsed.data;

    validateIdentity(input, expectedId, label);
    validateText(input, label);
    validateArtifact(input.artifact, `${label}.artifact`);
    validatePayload(input.payload, `${label}.payload`);
    validatePresentation(input, label);
    if (input.watch !== undefined) validateWatch(input.watch, `${label}.watch`);
    if (input.smoke !== undefined) validateSmoke(input.smoke, `${label}.smoke`);
    validateUpdater(input.updater ?? {}, `${label}.updater`);
    validateQuickSharun(input.quickSharun ?? {}, `${label}.quickSharun`);
    validateCompatibility(input, label);
    return normalize(input);
  } catch (error) {
    if (error instanceof DescriptorError) throw error;
    // A semantic `fail` is a configuration defect too: classify it with the
    // shape failures so a bad descriptor never looks like an infrastructure
    // error the retry workflow would repeat.
    throw new DescriptorError(error instanceof Error ? error.message : String(error));
  }
}
