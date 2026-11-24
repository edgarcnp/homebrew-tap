// The app descriptor: one JSON document per app, the single source of truth
// for identity, upstream artifact, staging, updater neutralization and CI
// inputs. Zod validates the shape; validate.ts adds the cross-field and
// path/host invariants the schema cannot express.

import { z } from "zod";
import type { Architecture } from "../core/architecture.ts";
import { artifactSchema } from "./artifact.ts";
import { payloadSchema } from "./payload.ts";
import {
  appId,
  archPackageName,
  iconSize,
  nonEmptyString,
  owner,
  ownerRepo,
  relativePath,
  safeReference,
} from "./scalars.ts";
import { updaterSchema } from "./updater.ts";
import { watchSchema } from "./watch.ts";

const iconSchema = z.strictObject({
  // Path to the icon: inside the extracted payload, or under the app directory
  // when `base` is "app".
  source: relativePath,
  // hicolor directory: a WxH size, e.g. 512x512, or "scalable" for an SVG.
  size: iconSize,
  // "payload" (default) or "app" for a repo-owned icon the upstream tarball
  // does not ship.
  base: z.enum(["payload", "app"]).exactOptional(),
});

const caskDesktopEntrySchema = z.strictObject({
  // Payload-relative path, e.g. share/applications/dev.zed.Zed.desktop.
  from: relativePath,
  // The line the cask rewrites, e.g. Exec=zed.
  exec: nonEmptyString,
});

const extraFileSchema = z.strictObject({
  source: relativePath,
  target: relativePath,
});

const appDirLinkSchema = z.strictObject({
  link: relativePath,
  target: relativePath,
});

const smokeSchema = z.strictObject({
  // Process comm values a defunct descendant may carry without failing the
  // gate; the semantic pass enforces the 15-byte kernel cap and uniqueness.
  ignoreDefunct: z.array(z.string()).exactOptional(),
});

// The toolkit switch the Wayland-only hook exports. One value per family, so a
// descriptor names its toolkit rather than spelling the variable, and a typo
// fails the load instead of exporting nothing. `auto` is the explicit "nothing
// to export": the toolkit already follows WAYLAND_DISPLAY.
const waylandBackendSchema = z.enum(["auto", "gdk", "electron", "moz"]);

const quickSharunSchema = z.strictObject({
  // pkgforge hooks to deploy (ADD_HOOKS); names are checked semantically.
  hooks: z.array(z.string()).exactOptional(),
  // Absolute paths in the build environment of libraries the app only dlopens
  // at runtime; checked semantically.
  libraries: z.array(z.string()).exactOptional(),
  // AppDir-relative executables the payload runs but does not stage in bin/
  // (a bundled runtime, for instance). quick-sharun deploys them like the
  // staged binaries, so they run under the bundled loader, not the host's.
  targets: z.array(relativePath).min(1).exactOptional(),
  // Extra quick-sharun environment variables, passed through verbatim.
  env: z.record(z.string(), z.string()).exactOptional(),
});

export const appDescriptorSchema = z.strictObject({
  id: appId,
  // Human-readable app name used in release titles.
  appName: nonEmptyString,
  // Desktop entry Name= value.
  displayName: nonEmptyString,
  // Desktop entry Comment= value.
  comment: nonEmptyString,
  // Desktop entry file name and icon name. Absent means the cask token; set
  // it when the generic name is already taken on a user's desktop by another
  // program.
  desktopId: appId.exactOptional(),
  // Cask token: Casks/<cask>.rb.
  cask: appId,
  // Optional release-watch block polled by the API's watcher; absent means the
  // app ships but is not watched for new upstream versions.
  watch: watchSchema.exactOptional(),
  // Release asset filename prefix.
  assetPrefix: appId,
  // Release tag prefix; the tag is <tagPrefix><version>.
  tagPrefix: safeReference,
  // Upstream repository to build from when reachable (owner/repo).
  sourceRepo: ownerRepo,
  // Owner of the fallback fork, used only when sourceRepo is unreachable.
  sourceOwner: owner,
  // Directory holding this app's templates and build script.
  sourceDir: relativePath,
  // Command run from sourceDir to produce the AppImage.
  buildCommand: nonEmptyString,
  // Flags for pkgforge's get-debloated-pkgs.
  debloatArgs: nonEmptyString,
  // Arch packages CI installs into the build container for this app, beyond
  // the shared toolchain.
  buildPackages: z.array(archPackageName).exactOptional(),
  // Architectures this app ships; absent means every supported architecture.
  architectures: z.array(z.enum(["amd64", "arm64"])).min(1).exactOptional(),
  // Names the cask must expose on PATH (checkCask asserts the agreement).
  binaryTargets: z.array(safeReference).min(1),
  // AppDir-relative paths (under bin/) the app executes outside the mount.
  hostHelpers: z.array(relativePath).min(1).exactOptional(),
  artifact: artifactSchema,
  payload: payloadSchema,
  icon: iconSchema,
  // Desktop entry template, relative to sourceDir.
  desktopTemplate: relativePath,
  // Payload-relative desktop entry the cask installs, with its Exec line
  // rewritten to the Homebrew binary.
  caskDesktopEntry: caskDesktopEntrySchema.exactOptional(),
  // Files copied verbatim from sourceDir into the AppDir after quick-sharun.
  extraFiles: z.array(extraFileSchema).min(1).exactOptional(),
  // Relative symlinks created in the finished AppDir before packing.
  appDirLinks: z.array(appDirLinkSchema).min(1).exactOptional(),
  // Post-build smoke-gate exceptions for this app, if any.
  smoke: smokeSchema.exactOptional(),
  // The finished AppImage refuses to start without a Wayland session unless
  // this is false; only a runtime that cannot draw on Wayland sets it. A
  // default rather than a tri-state, so every consumer reads one boolean.
  waylandOnly: z.boolean().default(true),
  // The toolkit switch the Wayland-only hook exports for this app, so the
  // window is the toolkit's native Wayland one whatever the host environment
  // says. `auto` means the toolkit follows WAYLAND_DISPLAY by itself.
  waylandBackend: waylandBackendSchema.exactOptional(),
  updater: updaterSchema.exactOptional(),
  quickSharun: quickSharunSchema.exactOptional(),
});

export type IconConfig = z.infer<typeof iconSchema>;
export type WaylandBackend = z.infer<typeof waylandBackendSchema>;
export type CaskDesktopEntry = z.infer<typeof caskDesktopEntrySchema>;
export type ExtraFile = z.infer<typeof extraFileSchema>;
export type AppDirLink = z.infer<typeof appDirLinkSchema>;
export type SmokeConfig = z.infer<typeof smokeSchema>;
export type QuickSharunConfig = z.infer<typeof quickSharunSchema>;
export type AppDescriptorInput = z.infer<typeof appDescriptorSchema>;

// The validated shape every pipeline consumer sees: defaults applied and
// required members guaranteed.
export type AppDescriptor =
  & Omit<AppDescriptorInput, "architectures" | "buildPackages" | "quickSharun" | "updater">
  & {
    architectures: Architecture[];
    buildPackages: string[];
    quickSharun: QuickSharunConfig;
    updater: z.infer<typeof updaterSchema>;
  };
