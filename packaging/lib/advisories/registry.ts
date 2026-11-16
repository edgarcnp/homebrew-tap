// Artifact dispatch. The switch is exhaustive, so adding a resolver kind
// without handling it here is a type error rather than a runtime surprise.

import { fail } from "../core/guards.ts";
import type { Artifact, ArtifactKind } from "../core/types.ts";
import { resolveWithAvakot } from "./custom/avakot.ts";
import { resolveWithGithubRelease } from "./github-release.ts";
import { resolveWithJsonAsset } from "./json-asset.ts";
import { resolveWithMozillaRelease } from "./mozilla-release.ts";
import type { ResolveOutcome, ResolveRequest } from "./shared.ts";
import { resolveWithUpdateManifest } from "./update-manifest.ts";

export type ArtifactResolver<K extends ArtifactKind> = (
  artifact: Extract<Artifact, { kind: K }>,
  request: ResolveRequest,
) => Promise<ResolveOutcome>;

type Registry = { [K in ArtifactKind]: ArtifactResolver<K> };

export const ARTIFACT_RESOLVERS: Registry = {
  "github-release": resolveWithGithubRelease,
  "json-asset": resolveWithJsonAsset,
  "mozilla-release": resolveWithMozillaRelease,
  "update-manifest": resolveWithUpdateManifest,
  avakot: resolveWithAvakot,
};

export function resolveWith(artifact: Artifact, request: ResolveRequest): Promise<ResolveOutcome> {
  switch (artifact.kind) {
    case "github-release":
      return ARTIFACT_RESOLVERS["github-release"](artifact, request);
    case "json-asset":
      return ARTIFACT_RESOLVERS["json-asset"](artifact, request);
    case "mozilla-release":
      return ARTIFACT_RESOLVERS["mozilla-release"](artifact, request);
    case "update-manifest":
      return ARTIFACT_RESOLVERS["update-manifest"](artifact, request);
    case "avakot":
      return ARTIFACT_RESOLVERS.avakot(artifact, request);
  }
  const exhaustive: never = artifact;
  return fail(`Unsupported artifact kind: ${JSON.stringify(exhaustive)}`);
}
