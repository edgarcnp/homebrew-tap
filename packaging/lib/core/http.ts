// Shared network layer: bounded downloads with retry/backoff, streaming reads
// under a hard size cap, hashing helpers and atomic writes. Every oracle goes
// through this module so download safety lives in exactly one place.

import * as crypto from "node:crypto";
import * as fs from "node:fs";

export const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_RETRY_DELAY_MS = 30000;

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

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

// 429/5xx retry with backoff, honoring Retry-After, capped at 30s; the final
// attempt's response is returned so callers' `response.ok` checks stay the one
// place that reports failure. Network errors retry and throw on the last
// attempt; a timeout throws immediately (retrying an abort is pointless).
export async function fetchWithRetry(
  url: string | URL,
  options: FetchOptions = {},
  retries = 3,
): Promise<Response> {
  const { timeoutMs } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const signal =
      options.signal ?? (timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined);
    try {
      const response = await fetch(url, buildInit(options, signal));
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (attempt === retries - 1) return response;
        let delayMs = 2 ** attempt * 1000;
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter !== null) {
          const secs = Number(retryAfter);
          if (Number.isFinite(secs)) {
            delayMs = Math.max(delayMs, secs * 1000);
          } else {
            const dateMs = Date.parse(retryAfter);
            if (!Number.isNaN(dateMs)) delayMs = Math.max(delayMs, dateMs - Date.now());
          }
        }
        await sleep(Math.min(delayMs, MAX_RETRY_DELAY_MS));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (isTimeout(error)) throw error;
      if (attempt === retries - 1) throw lastError;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// maxBytes is a parameter so the cap is testable without allocating the full
// 512 MiB; callers use the default.
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
