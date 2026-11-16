// Plumbing every artifact resolver shares: output-directory preparation,
// metadata path containment, and the ready / not-ready outcome.

import * as fs from "node:fs";
import * as path from "node:path";
import { HttpStatusError } from "../core/errors.ts";
import { assertInside } from "../core/guards.ts";
import type { Architecture, Metadata } from "../core/types.ts";

export interface ResolveRequest {
  architecture: Architecture;
  // The only version resolve may return: the API's dispatched version, or the
  // cask pin for a manual run.
  requestedVersion: string;
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

// A resolver either finds the requested artifact or says it is not published
// yet. "not-ready" is a verdict, never a failure: the workflow reports it as a
// skipped record and the API asks again later.
export type ResolveOutcome =
  | { status: "ready"; metadata: Metadata }
  | { status: "not-ready"; detail: string };

export function ready(metadata: Metadata): ResolveOutcome {
  return { status: "ready", metadata };
}

export function notReady(detail: string): ResolveOutcome {
  return { status: "not-ready", detail };
}

// A 404 on an artifact URL means the release is not complete yet, not that the
// transport failed. Every other client error stays a failure.
export function isNotFound(error: unknown): boolean {
  return error instanceof HttpStatusError && error.status === 404;
}

export function prepareOutput(request: ResolveRequest): ResolvedOutput {
  const outputDir = path.resolve(request.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  return {
    outputDir,
    metadataPath: assertInside(request.metadataPath, outputDir, "metadataPath"),
  };
}
