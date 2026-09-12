// Oracle dispatch. The switch is exhaustive, so adding a resolver kind without
// handling it here is a type error rather than a runtime surprise.

import { fail } from "../guards.ts";
import type { Metadata, Oracle, OracleKind } from "../types.ts";
import { resolveWithApt } from "./apt.ts";
import { resolveWithCdnRedirect } from "./cdn-redirect.ts";
import { resolveWithElectronFeed } from "./electron-feed.ts";
import { resolveWithGithubRelease } from "./github-release.ts";
import type { ResolveRequest } from "./shared.ts";

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
};

export const ORACLE_KINDS = Object.keys(ORACLE_RESOLVERS) as OracleKind[];

export function isOracleKind(value: unknown): value is OracleKind {
  return typeof value === "string" && (ORACLE_KINDS as string[]).includes(value);
}

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
  }
  const exhaustive: never = oracle;
  return fail(`Unsupported resolver kind: ${JSON.stringify(exhaustive)}`);
}
