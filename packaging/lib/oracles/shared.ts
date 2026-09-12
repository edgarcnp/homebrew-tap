// Plumbing every oracle shares: output-directory preparation and metadata path
// containment.

import * as fs from "node:fs";
import * as path from "node:path";
import { assertInside } from "../guards.ts";
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
