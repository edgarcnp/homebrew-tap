// How the upstream package is staged into the AppDir. The union is
// discriminated by `kind`, so a field that only makes sense for one layout is
// not accepted on another.

import { z } from "zod";
import { nonEmptyString, relativePath } from "./scalars.ts";

export const debTreePayloadSchema = z.strictObject({
  kind: z.literal("deb-tree"),
  // Directory inside the extracted .deb to stage into AppDir/bin.
  tree: relativePath,
});

export const debFilesPayloadSchema = z.strictObject({
  kind: z.literal("deb-files"),
  // Paths inside the extracted .deb to stage into AppDir/bin.
  files: z.array(relativePath).min(1),
});

export const appimageTreePayloadSchema = z.strictObject({
  kind: z.literal("appimage-tree"),
  // Entry name -> staged name. Defaults to an empty map.
  rename: z.record(z.string(), relativePath).exactOptional(),
  // Top-level entry names (or *.ext globs) skipped while staging.
  exclude: z.array(nonEmptyString).exactOptional(),
  // Move the payload's vendored usr/ to the AppDir root.
  moveUsrToRoot: z.boolean().exactOptional(),
});

export const tarballTreePayloadSchema = z.strictObject({
  kind: z.literal("tarball-tree"),
  // Directory inside the tarball holding the payload. Absent when the tarball
  // has exactly one top-level directory, which is then used.
  root: relativePath.exactOptional(),
  // "root" (the default) stages the tree at the AppDir root so a bundle's
  // bin/, libexec/, lib/ and share/ keep the relative paths its own binaries
  // resolve against. "bin" stages the tree's contents into AppDir/bin.
  target: z.enum(["root", "bin"]).exactOptional(),
  // Top-level names (or *.ext globs) skipped while staging.
  exclude: z.array(nonEmptyString).exactOptional(),
});

export const payloadSchema = z.discriminatedUnion("kind", [
  debTreePayloadSchema,
  debFilesPayloadSchema,
  appimageTreePayloadSchema,
  tarballTreePayloadSchema,
]);

export type PayloadKind = z.infer<typeof payloadSchema>["kind"];
export type PayloadTarget = "root" | "bin";
export type DebTreePayload = z.infer<typeof debTreePayloadSchema>;
export type DebFilesPayload = z.infer<typeof debFilesPayloadSchema>;
export type AppImageTreePayload = z.infer<typeof appimageTreePayloadSchema>;
export type TarballTreePayload = z.infer<typeof tarballTreePayloadSchema>;
export type Payload = z.infer<typeof payloadSchema>;

export const PAYLOAD_KINDS: readonly PayloadKind[] = [
  "deb-tree",
  "deb-files",
  "appimage-tree",
  "tarball-tree",
];
