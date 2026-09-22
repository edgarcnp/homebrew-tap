// Oracle dispatch. The switch is exhaustive, so adding a resolver kind without
// handling it here is a type error rather than a runtime surprise.

import { fail } from "../core/guards.ts";
import type { Metadata, Oracle, OracleKind } from "../core/types.ts";
import { resolveWithApt } from "./apt.ts";
import { resolveWithCdnRedirect } from "./cdn-redirect.ts";
import { resolveWithAvakot } from "./custom/avakot.ts";
import { resolveWithElectronFeed } from "./electron-feed.ts";
import { resolveWithGithubRelease } from "./github-release.ts";
import type { ResolveRequest } from "./shared.ts";
import { resolveWithUpdateManifest } from "./update-manifest.ts";

export type OracleResolver<K extends OracleKind> = (
  oracle: Extract<Oracle, { kind: K }>,
  request: ResolveRequest,
) => Promise<Metadata>;

type Registry = { [K in OracleKind]: OracleResolver<K> };

export const ORACLE_RESOLVERS: Registry = {
  apt: resolveWithApt,
  "github-release": resolveWithGithubRelease,
  "electron-feed": resolveWithElectronFeed,
  "cdn-redirect": resolveWithCdnRedirect,
  "update-manifest": resolveWithUpdateManifest,
  avakot: resolveWithAvakot,
};

export function resolveWith(oracle: Oracle, request: ResolveRequest): Promise<Metadata> {
  switch (oracle.kind) {
    case "apt":
      return ORACLE_RESOLVERS.apt(oracle, request);
    case "github-release":
      return ORACLE_RESOLVERS["github-release"](oracle, request);
    case "electron-feed":
      return ORACLE_RESOLVERS["electron-feed"](oracle, request);
    case "cdn-redirect":
      return ORACLE_RESOLVERS["cdn-redirect"](oracle, request);
    case "update-manifest":
      return ORACLE_RESOLVERS["update-manifest"](oracle, request);
    case "avakot":
      return ORACLE_RESOLVERS.avakot(oracle, request);
  }
  const exhaustive: never = oracle;
  return fail(`Unsupported resolver kind: ${JSON.stringify(exhaustive)}`);
}
