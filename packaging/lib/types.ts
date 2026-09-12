// Shared types for the tap's build tooling: the app descriptor (the single
// source of truth for one package) and the metadata every resolver emits.

export type Architecture = "amd64" | "arm64";

export const ARCHITECTURES: readonly Architecture[] = ["amd64", "arm64"];

export function isArchitecture(value: unknown): value is Architecture {
  return value === "amd64" || value === "arm64";
}

// Emitted by every resolver and consumed by the build scripts and CI.
// JSON key names are part of the contract with the shell pipeline.
export interface Metadata {
  package: string;
  version: string;
  packageVersion: string;
  architecture: Architecture;
  repositoryPath: string;
  sha256: string;
  size: number;
  depends: string;
  repository: string;
  path: string | null;
}

// ---------------------------------------------------------------------------
// Resolvers ("oracles": where the upstream version and payload come from)
// ---------------------------------------------------------------------------

export interface AptOracle {
  kind: "apt";
  repository: string;
  packageName: string;
  fingerprint: string;
  keyBase64Path: string;
}

export interface GithubReleaseOracle {
  kind: "github-release";
  repository: string;
  // Legacy layout: "<assetPrefix>-<arch>.deb". Absent in the versioned-asset
  // flavor, where assetNameTemplate names the file instead.
  assetPrefix?: string;
  // Optional versioned-asset flavor (e.g. CommandCode, whose filenames embed
  // the version): when assetNameTemplate is present, tagPrefix and packageName
  // must be present and assetPrefix must be absent; when absent, the legacy
  // layout applies. {version} and {arch} (deb arch) are substituted.
  assetNameTemplate?: string;
  tagPrefix?: string;
  packageName?: string;
}

// electron-updater feed: a 302 whose Location names the exact release tag.
export interface ElectronFeedOracle {
  kind: "electron-feed";
  repository: string;
  githubRepository: string;
  tagPrefix: string;
  // Upstream package identity recorded in the metadata document.
  packageName: string;
  // Expected upstream AppImage name; {version} and {arch} are substituted.
  assetNameTemplate: string;
}

// A CDN download redirect that is itself the version source.
export interface CdnRedirectOracle {
  kind: "cdn-redirect";
  repository: string;
  // Hosts the download may resolve to after redirecting.
  redirectHosts: string[];
  // Upstream package identity recorded in the metadata document.
  packageName: string;
  // Upstream .deb name, used for the scratch filename.
  debName: string;
}

export type Oracle =
  | AptOracle
  | GithubReleaseOracle
  | ElectronFeedOracle
  | CdnRedirectOracle;

export type OracleKind = Oracle["kind"];

// ---------------------------------------------------------------------------
// Payload staging
// ---------------------------------------------------------------------------

export type PayloadKind = "deb-tree" | "deb-files" | "appimage-tree";

export interface Payload {
  kind: PayloadKind;
  // deb-tree: directory inside the extracted .deb to stage into AppDir/bin.
  tree?: string;
  // deb-files: paths inside the extracted .deb to stage into AppDir/bin.
  files?: string[];
  // appimage-tree: entry name -> staged name.
  rename?: Record<string, string>;
  // appimage-tree: entry names skipped while staging (exact or *.ext glob).
  exclude?: string[];
  // appimage-tree: move the payload's vendored usr/ to the AppDir root.
  moveUsrToRoot?: boolean;
}

// ---------------------------------------------------------------------------
// Updater neutralization: one implementation, descriptor-selected behavior
// ---------------------------------------------------------------------------

export interface EndpointPatch {
  from: string;
  // Replacement for non-ELF files; may differ in length from `from`.
  textReplacement: string;
  // Replacement for ELF files; MUST be byte-identical in length to `from`.
  binaryReplacement: string;
  // Paths relative to the AppDir, or "all" to walk the whole AppDir.
  targets: string[] | "all";
}

export interface JsonKeyRemoval {
  file: string;
  keys: string[];
}

export interface FeedRemoval {
  paths: string[];
  // When true, a missing feed file is an error (the upstream build changed).
  required: boolean;
}

export type ScanSeverity = "error" | "warning";

export interface ResidualScan {
  patterns: string[];
  severity: ScanSeverity;
}

export interface UpdaterConfig {
  removeJsonKeys?: JsonKeyRemoval;
  patchEndpoint?: EndpointPatch;
  removeFeed?: FeedRemoval;
  // Written to AppDir/.env after packaging, e.g. CC_DISABLE_AUTO_UPDATE=1.
  env?: Record<string, string>;
  // Runtime hook sourced by the generated AppRun.sh; path relative to the app dir.
  hook?: string;
  // Fails (or warns) when any of these strings survive anywhere in the AppDir.
  residualScan?: ResidualScan;
}

// ---------------------------------------------------------------------------
// App descriptor
// ---------------------------------------------------------------------------

export interface IconConfig {
  // Path to the icon inside the extracted payload.
  source: string;
  // hicolor size directory, e.g. 512x512.
  size: string;
}

// Release-watch block: where the API's release watcher looks for this app's
// upstream versions. The pattern is matched against the atom entry *title*
// (the GitHub release name, not the tag) and capture group 1 is the version.
export interface WatchConfig {
  feedUrl: string;
  versionPattern: string;
  // Entries whose title matches are skipped, e.g. Gitbutler's "nightly/".
  skipPattern?: string;
  // Upstream repo (owner/repo), carried as the informational trigger_repo.
  repo?: string;
}

export interface AppDescriptor {
  id: string;
  // Human-readable app name used in release titles.
  appName: string;
  // Desktop entry Name= value.
  displayName: string;
  // Desktop entry Comment= value.
  comment: string;
  // Cask token: Casks/<cask>.rb.
  cask: string;
  // Optional release-watch block polled by the API's watcher; absent means the
  // app ships but is not watched for new upstream versions.
  watch?: WatchConfig;
  // Release asset filename prefix.
  assetPrefix: string;
  // Release tag prefix; the tag is <tagPrefix><version>.
  tagPrefix: string;
  // Upstream repository to build from when reachable (owner/repo).
  sourceRepo: string;
  // Owner of the fallback fork, used only when sourceRepo is unreachable.
  sourceOwner: string;
  // Directory holding this app's templates and build script.
  sourceDir: string;
  // Command run from sourceDir to produce the AppImage.
  buildCommand: string;
  // Flags for pkgforge's get-debloated-pkgs.
  debloatArgs: string;
  // Whether the build needs the webkit2gtk/GTK build dependencies.
  needsWebkit: boolean;
  // Architectures this app ships (subset of ["amd64", "arm64"]). Single-arch
  // apps (e.g. CommandCode, amd64-only upstream) ship one AppImage and pin one
  // checksum; the pipeline builds, publishes and checks only these arches.
  architectures: Architecture[];
  // Names the cask must expose on PATH (checkCask asserts the agreement).
  binaryTargets: string[];
  oracle: Oracle;
  payload: Payload;
  icon: IconConfig;
  // Desktop entry template, relative to sourceDir.
  desktopTemplate: string;
  updater: UpdaterConfig;
}

// ---------------------------------------------------------------------------
// Cask gate
// ---------------------------------------------------------------------------

export interface CaskState {
  version: string;
  // Architecture -> pinned SHA-256 (single-arch casks carry one entry).
  sha256: Partial<Record<Architecture, string>>;
}

export type GateAction = "build" | "skip" | "repair-cask";

export interface GateInput {
  cask: CaskState;
  upstreamVersion: string;
  releaseExists: boolean;
  // null when there is no release to compare against.
  releaseMatchesCask: boolean | null;
}

export interface GateDecision {
  action: GateAction;
  reason: string;
}
