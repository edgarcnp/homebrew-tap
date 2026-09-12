// Parsing for apt's signed index chain: an OpenPGP clear-signed InRelease, its
// SHA-256 file list, and deb822 Packages stanzas.

import { MAX_PAYLOAD_BYTES } from "./http.ts";

const MAX_RELEASE_AGE_DAYS = 14;
const WARN_RELEASE_AGE_DAYS = 7;
const MAX_INRELEASE_LINES = 100000;
const MAX_INRELEASE_HEADER_LINES = 50;

// Field names that would collide with Object.prototype if used as plain keys.
const UNSAFE_FIELD_NAMES = ["__proto__", "constructor", "prototype"];

export interface IndexedFile {
  sha256: string;
  size: number;
}

export function extractClearSignedPayload(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > MAX_INRELEASE_LINES) throw new Error("InRelease too large");
  if (lines.shift() !== "-----BEGIN PGP SIGNED MESSAGE-----") {
    throw new Error("InRelease is not an OpenPGP clear-signed message");
  }
  let headerCount = 0;
  let foundBlank = false;
  while (lines.length > 0) {
    if ((headerCount += 1) > MAX_INRELEASE_HEADER_LINES) {
      throw new Error("InRelease header too large");
    }
    if (lines.shift() === "") {
      foundBlank = true;
      break;
    }
  }
  if (!foundBlank) throw new Error("InRelease missing header terminator");
  const payload: string[] = [];
  let foundSignature = false;
  for (const line of lines) {
    if (line === "-----BEGIN PGP SIGNATURE-----") {
      foundSignature = true;
      break;
    }
    payload.push(line.startsWith("- ") ? line.slice(2) : line);
  }
  if (!foundSignature) throw new Error("InRelease missing PGP signature");
  if (payload.length === 0) throw new Error("InRelease signed payload is empty");
  return payload.join("\n");
}

// SHA256: entries of the signed InRelease: sha256, size, path.
export function parseReleaseSha256(payload: string): Map<string, IndexedFile> {
  const entries = new Map<string, IndexedFile>();
  let inSha256 = false;
  for (const line of payload.split(/\r?\n/)) {
    if (/^[A-Za-z0-9]+:/.test(line)) {
      inSha256 = line === "SHA256:";
      continue;
    }
    if (!inSha256) continue;
    const match = /^\s*([0-9a-f]{64})\s+(\d+)\s+(\S+)\s*$/i.exec(line);
    if (!match) continue;
    const [, digest, rawSize, entry] = match;
    if (entry === undefined || digest === undefined || rawSize === undefined) continue;
    if (entry.includes("..") || entry.startsWith("/")) continue;
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size > MAX_PAYLOAD_BYTES || size <= 0) continue;
    entries.set(entry, { sha256: digest.toLowerCase(), size });
  }
  return entries;
}

export type Deb822Paragraph = Record<string, string>;

export function parseDeb822(source: string): Deb822Paragraph[] {
  return source
    .trim()
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => {
      const fields: Deb822Paragraph = Object.create(null) as Deb822Paragraph;
      let current: string | null = null;
      for (const line of paragraph.split(/\r?\n/)) {
        if (/^[ \t]/.test(line) && current !== null) {
          fields[current] = `${fields[current] ?? ""}\n${line.slice(1)}`;
          continue;
        }
        const separator = line.indexOf(":");
        if (separator < 1) throw new Error(`Malformed Packages line: ${line}`);
        current = line.slice(0, separator);
        if (UNSAFE_FIELD_NAMES.includes(current)) throw new Error("invalid field name");
        fields[current] = line.slice(separator + 1).trim();
      }
      return fields;
    });
}

export interface FreshnessOptions {
  now?: number;
  warn?: (message: string) => void;
}

// Enforces apt-style freshness on the verified payload: a replayed old signed
// index must not silently downgrade the resolved package.
export function assertReleaseFreshness(
  payload: string,
  options: FreshnessOptions = {},
): void {
  const now = options.now ?? Date.now();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const fields = parseDeb822(payload)[0] ?? {};

  const toTimestamp = (value: string | undefined, field: string): number | null => {
    if (value === undefined || value === "") return null;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`Invalid ${field} in InRelease: ${value}`);
    return ms;
  };

  const validUntil = toTimestamp(fields["Valid-Until"], "Valid-Until");
  if (validUntil !== null) {
    if (now > validUntil) {
      throw new Error(`InRelease expired: Valid-Until ${fields["Valid-Until"]} is in the past`);
    }
    return;
  }
  const dateMs = toTimestamp(fields["Date"], "Date");
  if (dateMs === null) throw new Error("InRelease missing Date field; cannot verify freshness");
  const ageDays = (now - dateMs) / (24 * 60 * 60 * 1000);
  if (ageDays > MAX_RELEASE_AGE_DAYS) {
    throw new Error(
      `InRelease too old: Date ${fields["Date"]} is more than ${MAX_RELEASE_AGE_DAYS} days old`,
    );
  }
  if (ageDays > WARN_RELEASE_AGE_DAYS) {
    warn(`InRelease is ${Math.floor(ageDays)} days old (Date ${fields["Date"]})`);
  }
}
