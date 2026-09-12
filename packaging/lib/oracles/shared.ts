// Plumbing every oracle shares: output-directory preparation, metadata path
// containment, and the GitHub token handling rules.

import * as fs from "node:fs";
import * as path from "node:path";
import { assertInside, assertSingleLine } from "../guards.ts";
import type { Architecture } from "../types.ts";

export interface ResolveRequest {
  architecture: Architecture;
  outputDir: string;
  metadataPath: string;
  metadataOnly: boolean;
  // GitHub API token, "" when unset.
  token: string;
}

export interface ResolvedOutput {
  outputDir: string;
  metadataPath: string;
}

export function prepareOutput(request: ResolveRequest): ResolvedOutput {
  const outputDir = path.resolve(request.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  return {
    outputDir,
    metadataPath: assertInside(request.metadataPath, outputDir, "metadataPath"),
  };
}

export function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"] ?? "";
  if (token === "") return "";
  // A token with a newline would be a header-injection attempt.
  return assertSingleLine(token, "GitHub token");
}
