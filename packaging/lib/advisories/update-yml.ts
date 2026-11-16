// The electron-builder update yml published beside an AppImage release asset:
// its SHA-512 and size are the second integrity source for that payload.

import { MAX_PAYLOAD_BYTES } from "../core/http.ts";

export const MAX_YAML_BYTES = 64 * 1024;

// Minimal strict parser: reads the top-level version/path/sha512 keys and the
// files: entries (which carry size), then cross-checks them against each other
// and the expected asset name. releaseNotes and any other content are ignored.
export function parseUpdateYml(
  body: string,
  expectedVersion: string,
  expectedAsset: string,
): { sha512: string; size: number } {
  if (body.length > MAX_YAML_BYTES) throw new Error("update yml too large");
  const top: Record<string, string> = {};
  const files: Array<Record<string, string>> = [];
  let inFiles = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("files:")) {
      inFiles = true;
      continue;
    }
    const topLevel = /^(version|path|sha512):\s*(.*)\s*$/.exec(line);
    if (topLevel === null) {
      if (!inFiles) continue;
      const entry = /^ {2}- url:\s*(\S+)\s*$/.exec(line);
      if (entry !== null && entry[1] !== undefined) {
        files.push({ url: entry[1] });
        continue;
      }
      const field = /^ {4}(sha512|size|blockMapSize):\s*(\S+)\s*$/.exec(line);
      const current = files[files.length - 1];
      if (field !== null && current !== undefined) {
        const key = field[1];
        const value = field[2];
        if (key !== undefined && value !== undefined) current[key] = value;
      }
      continue;
    }
    inFiles = false;
    const key = topLevel[1];
    const value = topLevel[2];
    if (key !== undefined && value !== undefined && top[key] === undefined) top[key] = value;
  }
  for (const key of ["version", "path", "sha512"]) {
    if (top[key] === undefined) throw new Error(`update yml missing ${key}`);
  }
  if (files.length === 0) throw new Error("update yml has no files entries");
  const first = files[0];
  if (first === undefined) throw new Error("update yml has no files entries");
  for (const key of ["sha512", "size"]) {
    if (first[key] === undefined) throw new Error(`update yml files entry missing ${key}`);
  }
  if (top["version"] !== expectedVersion) {
    throw new Error(
      `update yml version ${String(top["version"])} does not match tag version ${expectedVersion}`,
    );
  }
  if (top["path"] !== expectedAsset || first["url"] !== expectedAsset) {
    throw new Error(
      `update yml asset ${String(top["path"])}/${String(first["url"])} does not match expected ${expectedAsset}`,
    );
  }
  if (top["sha512"] !== first["sha512"]) {
    throw new Error("update yml top-level sha512 disagrees with the files entry");
  }
  const sha512 = first["sha512"] ?? "";
  if (!/^[A-Za-z0-9+/]{86}==?$/.test(sha512)) {
    throw new Error(`update yml sha512 is not a base64 SHA-512: ${sha512.slice(0, 16)}...`);
  }
  const size = Number(first["size"]);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PAYLOAD_BYTES) {
    throw new Error(`update yml size is not a sane byte count: ${String(first["size"])}`);
  }
  return { sha512, size };
}
