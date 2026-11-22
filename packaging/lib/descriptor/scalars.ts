// Scalar schemas shared by the descriptor modules. Zod is the single source:
// the runtime validator and the TypeScript type both come from these values.

import { z } from "zod";
import { APP_ID, GITHUB_API_REPOSITORY, SAFE_REFERENCE } from "../core/patterns.ts";

const SINGLE_LINE = /^[^\r\n\u0000]+$/;

// Every descriptor string that reaches the shell, a header or a file name is
// single-line: a newline or NUL would split a CLI value or an exports file.
export const nonEmptyString = z
  .string()
  .min(1)
  .regex(SINGLE_LINE, "must be a single line");
export const relativePath = z
  .string()
  .min(1)
  .regex(SINGLE_LINE, "must be a single line");

export const appId = z.string().regex(APP_ID, "must be a lowercase app id");

export const safeReference = z.string().regex(SAFE_REFERENCE, "must be a safe reference");
export const owner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "must be a GitHub owner");
export const ownerRepo = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/repo");

// The semantic pass parses the URL and rejects query strings and fragments;
// the schema keeps the common case cheap and single-line.
export const httpsUrl = z
  .string()
  .min(1)
  .regex(SINGLE_LINE, "must be a single line");

export const githubApiRepository = z
  .string()
  .regex(GITHUB_API_REPOSITORY, "must be a GitHub API repository URL");

// A hostname without a port: the download allow-list compares URL.host.
export const host = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, "must be a hostname without a port");

export const fingerprint = z
  .string()
  .regex(/^[0-9A-Fa-f]{40}$/, "must be a 40-character GPG fingerprint");

export const dottedField = z
  .string()
  .regex(/^[A-Za-z0-9_-]+(?:[.][A-Za-z0-9_-]+)*$/, "must be a dotted field path");

export const payloadEntryName = z
  .string()
  .regex(/^[A-Za-z0-9._+-]+$/, "must be a top-level payload entry name");

export const archPackageName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9@._+-]*$/, "must be an Arch package name");

export const iconSize = z
  .string()
  .regex(/^(?:[0-9]+x[0-9]+|scalable)$/, "must be a WxH size or scalable");

export type NonEmptyString = z.infer<typeof nonEmptyString>;
export type RelativePath = z.infer<typeof relativePath>;
export type AppId = z.infer<typeof appId>;
export type SafeReference = z.infer<typeof safeReference>;
export type Owner = z.infer<typeof owner>;
export type OwnerRepo = z.infer<typeof ownerRepo>;
export type HttpsUrl = z.infer<typeof httpsUrl>;
export type Fingerprint = z.infer<typeof fingerprint>;
export type DottedField = z.infer<typeof dottedField>;
export type Host = z.infer<typeof host>;
export type PayloadEntryName = z.infer<typeof payloadEntryName>;
export type ArchPackageName = z.infer<typeof archPackageName>;
export type IconSize = z.infer<typeof iconSize>;
