// Updater neutralization: one implementation, descriptor-selected behavior.

import { z } from "zod";
import { nonEmptyString, relativePath } from "./scalars.ts";

const endpointPatchSchema = z.strictObject({
  from: nonEmptyString,
  // Replacement for non-ELF files; may differ in length from `from`.
  textReplacement: nonEmptyString,
  // Replacement for ELF files; MUST be byte-identical in length to `from`.
  binaryReplacement: nonEmptyString,
  // Paths relative to the AppDir, or "all" to walk the whole AppDir.
  targets: z.union([z.literal("all"), z.array(relativePath).min(1)]),
});

const jsonKeyRemovalSchema = z.strictObject({
  file: relativePath,
  keys: z.array(nonEmptyString).min(1),
});

const feedRemovalSchema = z.strictObject({
  paths: z.array(relativePath).min(1),
  // When true, a missing feed file is an error (the upstream build changed).
  required: z.boolean(),
});

const residualScanSchema = z.strictObject({
  patterns: z.array(nonEmptyString).min(1),
  severity: z.enum(["error", "warning"]),
});

export const updaterSchema = z.strictObject({
  removeJsonKeys: jsonKeyRemovalSchema.exactOptional(),
  patchEndpoint: endpointPatchSchema.exactOptional(),
  removeFeed: feedRemovalSchema.exactOptional(),
  // Written to AppDir/.env after packaging; keys are checked semantically.
  env: z.record(z.string(), z.string()).exactOptional(),
  // Runtime hook sourced by the generated AppRun.sh; path relative to the app dir.
  hook: relativePath.exactOptional(),
  // Fails (or warns) when any of these strings survive anywhere in the AppDir.
  residualScan: residualScanSchema.exactOptional(),
});

export type EndpointPatch = z.infer<typeof endpointPatchSchema>;
export type JsonKeyRemoval = z.infer<typeof jsonKeyRemovalSchema>;
export type FeedRemoval = z.infer<typeof feedRemovalSchema>;
export type ScanSeverity = z.infer<typeof residualScanSchema>["severity"];
export type ResidualScan = z.infer<typeof residualScanSchema>;
export type UpdaterConfig = z.infer<typeof updaterSchema>;
