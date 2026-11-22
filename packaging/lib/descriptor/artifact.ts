// Where the exact requested version's payload comes from. The union is
// discriminated by `kind`; Zod validates the selected branch and rejects
// unknown fields inside it.

import { z } from "zod";
import {
  dottedField,
  fingerprint,
  githubApiRepository,
  host,
  httpsUrl,
  nonEmptyString,
  relativePath,
  safeReference,
} from "./scalars.ts";

export const githubReleaseArtifactSchema = z.strictObject({
  kind: z.literal("github-release"),
  repository: githubApiRepository,
  // {version}, {arch} and {appimage_arch} substitute; must contain a
  // placeholder so the template can name the requested version's asset.
  assetNameTemplate: nonEmptyString,
  tagPrefix: safeReference,
  packageName: safeReference,
});

// A pinned https JSON feed that names the exact asset for its version and
// publishes its SHA-256, e.g. VS Code's linux-x64 update endpoint.
export const jsonAssetArtifactSchema = z.strictObject({
  kind: z.literal("json-asset"),
  url: httpsUrl,
  // Hosts the asset URL must resolve to after redirecting.
  downloadHosts: z.array(host).min(1),
  // Dotted paths inside the document: asset URL, SHA-256 and version.
  urlField: dottedField,
  sha256Field: dottedField,
  versionField: dottedField,
  packageName: safeReference,
});

// A Mozilla release tarball plus its detached signature, verified against a
// pinned release key before the bytes are hashed.
export const mozillaReleaseArtifactSchema = z.strictObject({
  kind: z.literal("mozilla-release"),
  // {version} and the arch tokens substitute.
  urlTemplate: httpsUrl,
  // {url} and the other tokens substitute; e.g. "{url}.asc".
  signatureTemplate: nonEmptyString,
  packageName: safeReference,
  fingerprint,
  keyPath: relativePath,
});

// A pinned https JSON manifest that publishes the version and per-asset
// SHA-256/size, e.g. opencode's update API.
export const updateManifestArtifactSchema = z.strictObject({
  kind: z.literal("update-manifest"),
  repository: httpsUrl,
  packageName: safeReference,
  // Asset name template; {arch} is the deb architecture (amd64/arm64).
  assetTemplate: nonEmptyString,
  downloadHosts: z.array(host).min(1),
});

// Provider-specific manifest artifact (see advisories/custom/): avakot's
// manifest.json serves {version, artifacts: {<name>: {url, sha256, [size],
// [version]}}} with static download URLs and no published size.
export const avakotArtifactSchema = z.strictObject({
  kind: z.literal("avakot"),
  repository: httpsUrl,
  packageName: safeReference,
  // Artifacts key naming the payload ({arch} substituted when present).
  assetTemplate: nonEmptyString,
  downloadHosts: z.array(host).min(1),
});

export const artifactSchema = z.discriminatedUnion("kind", [
  githubReleaseArtifactSchema,
  jsonAssetArtifactSchema,
  mozillaReleaseArtifactSchema,
  updateManifestArtifactSchema,
  avakotArtifactSchema,
]);

export type GithubReleaseArtifact = z.infer<typeof githubReleaseArtifactSchema>;
export type JsonAssetArtifact = z.infer<typeof jsonAssetArtifactSchema>;
export type MozillaReleaseArtifact = z.infer<typeof mozillaReleaseArtifactSchema>;
export type UpdateManifestArtifact = z.infer<typeof updateManifestArtifactSchema>;
export type AvakotArtifact = z.infer<typeof avakotArtifactSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactKind = Artifact["kind"];

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "github-release",
  "json-asset",
  "mozilla-release",
  "update-manifest",
  "avakot",
];
