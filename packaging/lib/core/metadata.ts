// The metadata document oracles emit and the shell pipeline reads; one
// validator here means the scripts can trust the JSON.

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
import { DEB_VERSION } from "./patterns.ts";
import type { Architecture, Metadata } from "./types.ts";
import { isArchitecture } from "./types.ts";

// The fields an oracle fills in. Everything else follows one convention:
// packageVersion mirrors version (the deb build epoch only matters for apt),
// depends is empty, and an unresolved payload carries a null path.
export interface MetadataFields {
  package: string;
  version: string;
  architecture: Architecture;
  repositoryPath: string;
  sha256: string;
  size: number;
  repository: string;
  packageVersion?: string;
  depends?: string;
  path?: string | null;
}

export function makeMetadata(fields: MetadataFields): Metadata {
  return {
    package: fields.package,
    version: fields.version,
    packageVersion: fields.packageVersion ?? fields.version,
    architecture: fields.architecture,
    repositoryPath: fields.repositoryPath,
    sha256: fields.sha256,
    size: fields.size,
    depends: fields.depends ?? "",
    repository: fields.repository,
    path: fields.path ?? null,
  };
}

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
  if (!DEB_VERSION.test(version)) fail(`Invalid ${label}.version: ${version}`);
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
