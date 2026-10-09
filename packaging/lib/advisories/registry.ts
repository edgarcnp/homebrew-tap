// Advisory dispatch. The switch is exhaustive, so adding a resolver kind without
// handling it here is a type error rather than a runtime surprise.

import { fail } from "../core/guards.ts";
import type { Metadata, Advisory, AdvisoryKind } from "../core/types.ts";
import { resolveWithApt } from "./apt.ts";
import { resolveWithCdnRedirect } from "./cdn-redirect.ts";
import { resolveWithAvakot } from "./custom/avakot.ts";
import { resolveWithElectronFeed } from "./electron-feed.ts";
import { resolveWithGithubRelease } from "./github-release.ts";
import type { ResolveRequest } from "./shared.ts";
import { resolveWithUpdateManifest } from "./update-manifest.ts";

export type AdvisoryResolver<K extends AdvisoryKind> = (
  advisory: Extract<Advisory, { kind: K }>,
  request: ResolveRequest,
) => Promise<Metadata>;

type Registry = { [K in AdvisoryKind]: AdvisoryResolver<K> };

export const ADVISORY_RESOLVERS: Registry = {
  apt: resolveWithApt,
  "github-release": resolveWithGithubRelease,
  "electron-feed": resolveWithElectronFeed,
  "cdn-redirect": resolveWithCdnRedirect,
  "update-manifest": resolveWithUpdateManifest,
  avakot: resolveWithAvakot,
};

export function resolveWith(advisory: Advisory, request: ResolveRequest): Promise<Metadata> {
  switch (advisory.kind) {
    case "apt":
      return ADVISORY_RESOLVERS.apt(advisory, request);
    case "github-release":
      return ADVISORY_RESOLVERS["github-release"](advisory, request);
    case "electron-feed":
      return ADVISORY_RESOLVERS["electron-feed"](advisory, request);
    case "cdn-redirect":
      return ADVISORY_RESOLVERS["cdn-redirect"](advisory, request);
    case "update-manifest":
      return ADVISORY_RESOLVERS["update-manifest"](advisory, request);
    case "avakot":
      return ADVISORY_RESOLVERS.avakot(advisory, request);
  }
  const exhaustive: never = advisory;
  return fail(`Unsupported resolver kind: ${JSON.stringify(exhaustive)}`);
}
