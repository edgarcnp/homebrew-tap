// Network layer: single-attempt fetch with a timeout guard, capped streaming
// reads, hashing helpers and atomic writes.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { GuardViolationError, UpstreamUnavailableError } from "./errors.ts";

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
  try {
    return await fetch(url, buildInit(options, signal));
  } catch (error) {
    // Classified, not swallowed: a transport failure is exactly what the API's
    // budget exists for, and the record can tell a timeout from a refused
    // connection.
    const detail = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    throw new UpstreamUnavailableError(`Request to ${url} failed: ${detail}`, { reason });
  }
}

// Classifies a non-2xx response for the caller's `response.ok` check: 429, a
// rate-limited 403 and 5xx are transient upstream failures the API may come
// back for, carrying whatever retry hint the transport sent; every other
// status stays a plain error, which the run record reports as UNCLASSIFIED.
export function httpFailure(response: Response, message: string): Error {
  const { status } = response;
  const rateLimited =
    status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
  if (status !== 429 && !rateLimited && status < 500) return new Error(message);
  const evidence: Record<string, string> = { http_status: String(status) };
  if (rateLimited) evidence["rate_limited"] = "true";
  const retryAfter = retryAfterSeconds(response.headers);
  if (retryAfter !== null) evidence["retry_after_seconds"] = String(retryAfter);
  return new UpstreamUnavailableError(message, evidence);
}

// The retry hints upstreams actually send: Retry-After (seconds or an HTTP
// date) and GitHub's x-ratelimit-reset (epoch seconds). Both normalize to whole
// seconds from now, so the API never parses a date.
function retryAfterSeconds(headers: Headers): number | null {
  const header = headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      return Math.max(0, Math.ceil(epochSeconds - Date.now() / 1000));
    }
  }
  return null;
}

// maxBytes is a parameter so the cap is testable without allocating 512 MiB.
export async function readPayload(
  response: Response,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new GuardViolationError(`Payload too large (${bytes.length} bytes) for ${response.url}`);
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
        throw new GuardViolationError(
          `Payload exceeds size cap (${maxBytes} bytes) for ${response.url}`,
        );
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
