// The app descriptor and the metadata every resolver emits.

export type Architecture = "amd64" | "arm64";

export const ARCHITECTURES: readonly Architecture[] = ["amd64", "arm64"];

export function isArchitecture(value: unknown): value is Architecture {
  return value === "amd64" || value === "arm64";
}

// Emitted by every resolver; the JSON key names are the contract with the
// shell pipeline.
export interface Metadata {
  package: string;
  version: string;
  architecture: Architecture;
  repositoryPath: string;
  sha256: string;
  size: number;
  repository: string;
  path: string | null;
}

// ---------------------------------------------------------------------------
// Artifacts: where the exact requested version's payload comes from
// ---------------------------------------------------------------------------

export interface GithubReleaseArtifact {
  kind: "github-release";
  repository: string;
  // {version}, {arch} and {appimage_arch} substitute; must contain a
  // placeholder so the template can name the requested version's asset.
  assetNameTemplate: string;
  tagPrefix: string;
  packageName: string;
}

// A pinned https JSON feed that names the exact asset for its version and
// publishes its SHA-256, e.g. VS Code's linux-x64 update endpoint.
export interface JsonAssetArtifact {
  kind: "json-asset";
  // Pinned https endpoint returning the update document.
  url: string;
  // Hosts the asset URL must resolve to after redirecting.
  downloadHosts: string[];
  // Dotted paths inside the document: asset URL, SHA-256 and version.
  urlField: string;
  sha256Field: string;
  versionField: string;
  // Upstream package identity recorded in the metadata document.
  packageName: string;
}

// A Mozilla release tarball plus its detached signature, verified against a
// pinned release key before the bytes are hashed. No .deb is involved.
export interface MozillaReleaseArtifact {
  kind: "mozilla-release";
  // {version} and the arch tokens substitute.
  urlTemplate: string;
  // {url} and the other tokens substitute; e.g. "{url}.asc".
  signatureTemplate: string;
  // Upstream package identity recorded in the metadata document.
  packageName: string;
  // The pinned release key's fingerprint and repository-relative path.
  fingerprint: string;
  keyPath: string;
}

// A pinned https JSON manifest that publishes the version and per-asset
// SHA-256/size, e.g. opencode's update API: {version, metadata: {files:
// {<name>: {url, sha256, size}}}}. The digest verifies the payload at download.
export interface UpdateManifestArtifact {
  kind: "update-manifest";
  // Pinned https endpoint returning the update manifest.
  repository: string;
  // Upstream package identity recorded in the metadata document.
  packageName: string;
  // Asset name template; {arch} is the deb architecture (amd64/arm64).
  assetTemplate: string;
  // Hosts asset URLs must resolve to after redirecting.
  downloadHosts: string[];
}

// Provider-specific manifest artifact (see advisories/custom/): avakot's
// manifest.json serves {version, artifacts: {<name>: {url, sha256, [size],
// [version]}}} with static download URLs and no published size, so the
// version binds through the per-entry version field and the payload is
// measured from the verified download.
export interface AvakotArtifact {
  kind: "avakot";
  // Pinned https endpoint returning the avakot manifest.
  repository: string;
  // Upstream package identity recorded in the metadata document.
  packageName: string;
  // Artifacts key naming the payload ({arch} substituted when present).
  assetTemplate: string;
  // Hosts asset URLs must resolve to after redirecting.
  downloadHosts: string[];
}

export type Artifact =
  | GithubReleaseArtifact
  | JsonAssetArtifact
  | MozillaReleaseArtifact
  | UpdateManifestArtifact
  | AvakotArtifact;

export type ArtifactKind = Artifact["kind"];

// ---------------------------------------------------------------------------
// Payload staging
// ---------------------------------------------------------------------------

export type PayloadKind = "deb-tree" | "deb-files" | "appimage-tree" | "tarball-tree";

export type PayloadTarget = "root" | "bin";

export interface Payload {
  kind: PayloadKind;
  // deb-tree: directory inside the extracted .deb to stage into AppDir/bin.
  tree?: string;
  // deb-files: paths inside the extracted .deb to stage into AppDir/bin.
  files?: string[];
  // appimage-tree: entry name -> staged name.
  rename?: Record<string, string>;
  // appimage-tree/tarball-tree: top-level entry names (or *.ext globs) skipped
  // while staging, e.g. upstream docs whose text would trip an updater scan.
  exclude?: string[];
  // appimage-tree: move the payload's vendored usr/ to the AppDir root.
  moveUsrToRoot?: boolean;
  // tarball-tree: directory inside the tarball holding the payload. Absent
  // when the tarball has exactly one top-level directory, which is then used.
  root?: string;
  // tarball-tree: "root" (the default) stages the tree at the AppDir root so a
  // bundle's bin/, libexec/, lib/ and share/ keep the relative paths its own
  // binaries resolve against ($ORIGIN/../lib, the CLI's ../libexec/zed-editor).
  // "bin" stages the tree's contents into AppDir/bin, the flat layout an
  // application tarball uses (Firefox, VS Code, GitComet).
  target?: PayloadTarget;
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
// quick-sharun build configuration
// ---------------------------------------------------------------------------

// quick-sharun reads its knobs from the environment; this is the descriptor's
// typed view, exported at pack time so CI and a local build.sh agree.
export interface QuickSharunConfig {
  // pkgforge hooks to deploy (ADD_HOOKS), e.g. ["fix-namespaces.hook"].
  // quick-sharun itself rejects a name it does not know.
  hooks?: string[];
  // Absolute paths in the build environment of libraries the app only dlopens
  // at runtime (so they are absent from the ELF closure and ldd would never
  // surface them), e.g. ["/usr/lib/libayatana-appindicator3.so.1"]. Passed to
  // quick-sharun as deploy targets, which bundles each one's ldd closure.
  libraries?: string[];
  // Extra quick-sharun environment variables, passed through verbatim.
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// App descriptor
// ---------------------------------------------------------------------------

export interface IconConfig {
  // Path to the icon: inside the extracted payload, or under the app directory
  // when `base` is "app".
  source: string;
  // hicolor directory: a WxH size, e.g. 512x512, or "scalable" for an SVG.
  size: string;
  // "payload" (default) or "app" for a repo-owned icon the upstream tarball
  // does not ship.
  base?: "payload" | "app";
}
// Desktop entry the payload ships: the cask patches its Exec line to the
// Homebrew-installed binary and installs that file, instead of writing a
// generated entry of its own. Absent when the cask writes the entry.
export interface CaskDesktopEntry {
  // Payload-relative path, e.g. share/applications/dev.zed.Zed.desktop.
  from: string;
  // The line the cask rewrites, e.g. Exec=zed.
  exec: string;
}


// A file copied verbatim from sourceDir into the AppDir after quick-sharun,
// e.g. Firefox default prefs under bin/defaults/pref. `target` is
// AppDir-relative; an existing target whose bytes differ fails the build
// rather than overwriting the payload's own file.
export interface ExtraFile {
  source: string;
  target: string;
}

// Release-watch block. versionPattern matches the feed entry *title*: an atom
// entry title, the GitHub release `name` (or its `tag_name` when the name is
// empty) for `"github-release"`, or the JSON `versionField` value for
// `format: "json"` feeds; capture group 1 is the version.
export type WatchFormat = "atom" | "json" | "github-release";

export interface WatchConfig {
  feedUrl: string;
  versionPattern: string;
  // Entries whose title matches are skipped, e.g. GitComet's "-rc" releases.
  skipPattern?: string;
  // Upstream repo (owner/repo) the watch feed belongs to; informational for
  // the API's watcher.
  repo?: string;
  // Feed format: "atom" parses releases.atom entry titles, "github-release"
  // reads the GitHub releases list from the pinned API URL, and "json" reads a
  // single version string at `versionField` (e.g. avakot's manifest). The
  // validator requires it — every descriptor declares it — while the API's
  // reader still treats an absent one as atom.
  format: WatchFormat;
  // Dotted path to the version string in a JSON feed; required with "json",
  // rejected otherwise.
  versionField?: string;
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
  // Arch packages CI installs into the build container for this app, beyond
  // the shared toolchain: only for libraries that must exist at build time
  // (e.g. a dlopened library listed in quickSharun.libraries). Empty when the
  // shared toolchain is enough.
  buildPackages: string[];
  // Architectures this app ships; the pipeline builds, publishes and checks
  // only these.
  architectures: Architecture[];
  // Names the cask must expose on PATH (checkCask asserts the agreement).
  binaryTargets: string[];
  // AppDir-relative paths (under bin/) the app executes outside the mount, so
  // they must stay host-runnable: the pipeline restores them from the pristine
  // payload after quick-sharun instead of shipping sharun wrappers (e.g. an
  // Electron app that copies bin/resources/<helper> to userData and spawns it
  // there — a sharun wrapper dies outside the mount with "Interpreter not
  // found!"). Absent when the app runs everything inside the mount.
  hostHelpers?: string[];
  artifact: Artifact;
  payload: Payload;
  icon: IconConfig;
  // Desktop entry template, relative to sourceDir.
  desktopTemplate: string;
  // Payload-relative desktop entry the cask installs, with its Exec line
  // rewritten to the Homebrew binary. Absent when the cask writes a generated
  // entry from desktopTemplate instead.
  caskDesktopEntry?: CaskDesktopEntry;
  // Files copied verbatim from sourceDir into the AppDir after quick-sharun.
  // Absent when the app ships none.
  extraFiles?: ExtraFile[];
  updater: UpdaterConfig;
  // quick-sharun build knobs, exported as environment variables at pack time.
  quickSharun: QuickSharunConfig;
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
  // The one version this run may build: the API's dispatched version, or the
  // cask pin for a manual run. There is no second, newest-upstream version.
  requestedVersion: string;
  // The version resolve actually found a payload for, or null when resolve
  // reported not-ready.
  artifactVersion: string | null;
  releaseExists: boolean;
}

export interface GateDecision {
  action: GateAction;
  reason: string;
  // A typed readiness signal for the run record: present only when the API's
  // requested version is not published upstream yet, so the API can wait and
  // ask again instead of matching on the human `reason`.
  reasonCode?: "not-ready" | undefined;
}
