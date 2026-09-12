// The metadata document every oracle emits and the shell pipeline consumes.
// One validator here means the build scripts can trust the JSON they read.

import * as fs from "node:fs";
import {
  assertHttpsUrl,
  assertPositiveSize,
  assertSafeName,
  assertSha256Hex,
  assertSingleLine,
  fail,
} from "./guards.ts";
import { MAX_PAYLOAD_BYTES, writeFileAtomic } from "./http.ts";
import type { Metadata } from "./types.ts";
import { isArchitecture } from "./types.ts";

export const METADATA_KEYS: readonly (keyof Metadata)[] = [
  "package",
  "version",
  "packageVersion",
  "architecture",
  "repositoryPath",
  "sha256",
  "size",
  "depends",
  "repository",
  "path",
];

export function assertMetadata(value: unknown, label = "metadata"): Metadata {
  if (typeof value !== "object" || value === null) fail(`${label} is not an object`);
  const record = value as Record<string, unknown>;
  const string = (key: keyof Metadata): string => {
    const field = record[key];
    if (typeof field !== "string") fail(`${label}.${key} must be a string`);
    return assertSingleLine(field, `${label}.${key}`);
  };
  const packageName = assertSafeName(string("package"), `${label}.package`);
  const version = assertSingleLine(string("version"), `${label}.version`);
  if (!/^[0-9][0-9A-Za-z.+~_-]*$/.test(version)) fail(`Invalid ${label}.version: ${version}`);
  const packageVersion = assertSingleLine(string("packageVersion"), `${label}.packageVersion`);
  const architecture = record["architecture"];
  if (!isArchitecture(architecture)) fail(`Invalid ${label}.architecture: ${String(architecture)}`);
  const repositoryPath = string("repositoryPath");
  if (repositoryPath.startsWith("/") || repositoryPath.includes("..")) {
    fail(`Unsafe ${label}.repositoryPath: ${repositoryPath}`);
  }
  const sha256 = assertSha256Hex(string("sha256"), `${label}.sha256`);
  const size = assertPositiveSize(record["size"] as number, MAX_PAYLOAD_BYTES, `${label}.size`);
  const depends = string("depends");
  assertHttpsUrl(string("repository"), `${label}.repository`);
  const rawPath = record["path"];
  if (rawPath !== null && typeof rawPath !== "string") fail(`${label}.path must be a string or null`);

  return {
    package: packageName,
    version,
    packageVersion,
    architecture,
    repositoryPath,
    sha256,
    size,
    depends,
    repository: string("repository"),
    path: rawPath as string | null,
  };
}

export function writeMetadata(metadataPath: string, metadata: Metadata): void {
  writeFileAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

export function readMetadata(metadataPath: string): Metadata {
  return assertMetadata(JSON.parse(fs.readFileSync(metadataPath, "utf8")), metadataPath);
}

export function readMetadataField(metadataPath: string, field: string): string {
  const metadata = readMetadata(metadataPath);
  // `url` and `path` are the two derived values the pipeline reads.
  if (field === "url") return metadataUrl(metadata);
  if (field === "path") return metadata.path ?? metadataPath;
  if (!(METADATA_KEYS as readonly string[]).includes(field)) {
    fail(`Unknown metadata field: ${field}`);
  }
  return String(metadata[field as keyof Metadata]);
}

export function metadataUrl(metadata: Metadata): string {
  return `${metadata.repository}/${metadata.repositoryPath}`;
}
