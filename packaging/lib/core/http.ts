// Network layer: single-attempt fetch with a timeout guard, capped streaming
// reads, hashing helpers and atomic writes.

import * as crypto from "node:crypto";
import * as fs from "node:fs";

export const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

export interface FetchOptions {
  headers?: Record<string, string>;
  redirect?: "follow" | "error" | "manual";
  signal?: AbortSignal;
  timeoutMs?: number;
}

function buildInit(options: FetchOptions, signal: AbortSignal | undefined): RequestInit {
  const init: RequestInit = {};
  if (options.headers !== undefined) init.headers = options.headers;
  if (options.redirect !== undefined) init.redirect = options.redirect;
  if (signal !== undefined) init.signal = signal;
  return init;
}

// One attempt, deliberately: retry and backoff policy belongs to the API that
// dispatches builds — it holds the budget, the run record and the log. A
// timeout throws; every other outcome (429/5xx included) is returned or
// propagated for the caller's single `response.ok` check.
export async function fetchOnce(
  url: string | URL,
  options: FetchOptions = {},
): Promise<Response> {
  const { timeoutMs } = options;
  const signal =
    options.signal ?? (timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined);
  return fetch(url, buildInit(options, signal));
}

// maxBytes is a parameter so the cap is testable without allocating 512 MiB.
export async function readPayload(
  response: Response,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(`Payload too large (${bytes.length} bytes) for ${response.url}`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Payload exceeds size cap (${maxBytes} bytes) for ${response.url}`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const tmp = `${filePath}.tmp.${crypto.randomBytes(8).toString("hex")}`;
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort: the temp file is already gone or unreachable
    }
    throw error;
  }
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function sha256Digest(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

export function sha512Base64(data: Buffer): string {
  return crypto.createHash("sha512").update(data).digest("base64");
}

// Constant-time comparison against a lowercase hex digest.
export function digestMatchesHex(expectedHex: string, actual: Buffer): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
