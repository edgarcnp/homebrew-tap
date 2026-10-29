// Network layer: single-attempt fetch with a timeout guard, capped streaming
// reads, hashing helpers and atomic writes.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { GuardViolationError, UpstreamUnavailableError } from "./errors.ts";

export const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

// A body read fails when bytes stop arriving for this long. It is a stall
// budget, not a transfer budget: the 243 MB opencode-desktop .deb legitimately
// takes minutes on a slow link, and a wall-clock cap on the whole transfer
// aborted its build at exactly 60 seconds.
export const DEFAULT_BODY_IDLE_TIMEOUT_MS = 60000;

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
//
// timeoutMs bounds the wait for the response headers only: a body is guarded
// by readPayload's idle timeout, because a transfer that keeps making progress
// is healthy however long it takes.
export async function fetchOnce(
  url: string | URL,
  options: FetchOptions = {},
): Promise<Response> {
  const { timeoutMs } = options;
  const controller =
    options.signal === undefined && timeoutMs !== undefined ? new AbortController() : undefined;
  const timer =
    controller === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort();
        }, timeoutMs);
  const signal = options.signal ?? controller?.signal;
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
  } finally {
    clearTimeout(timer);
  }
}

// Classifies a non-2xx response for the caller's `response.ok` check: 429, a
// rate-limited 403 and 5xx are transient upstream failures the API may come
// back for, carrying whatever retry hint the transport sent; every other
// status stays a plain error, which the run record reports as UNCLASSIFIED.
export function httpFailure(response: Response, message: string): Error {
  const { status } = response;
  const retryAfter = retryAfterSeconds(response.headers);
  // A secondary-rate-limit 403 carries Retry-After without zeroing the
  // remaining count, so either signal marks it transient.
  const rateLimited =
    status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" || retryAfter !== null);
  if (status !== 429 && !rateLimited && status < 500) return new Error(message);
  const evidence: Record<string, string> = { http_status: String(status) };
  if (rateLimited) evidence["rate_limited"] = "true";
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

export interface ReadPayloadOptions {
  // How long the reader waits for the next chunk before calling the transport
  // dead. Defaults to DEFAULT_BODY_IDLE_TIMEOUT_MS.
  idleTimeoutMs?: number;
}

type ReadChunk = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

// Resolves with the next chunk, or rejects once nothing arrives for idleMs.
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  url: string,
): Promise<ReadChunk> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new UpstreamUnavailableError(`No bytes from ${url} for ${idleMs}ms`, {
          reason: "timeout",
        }),
      );
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

// Reads the whole body under an idle-progress guard: every chunk resets the
// window, so a large payload on a slow link completes while a hung socket still
// fails. A stall is the transport giving up, so it is classified as a transient
// upstream failure — the same verdict fetchOnce gives the headers.
//
// maxBytes is a parameter so the cap is testable without allocating 512 MiB.
export async function readPayload(
  response: Response,
  maxBytes: number = MAX_PAYLOAD_BYTES,
  options: ReadPayloadOptions = {},
): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new GuardViolationError(`Payload too large (${bytes.length} bytes) for ${response.url}`);
    }
    return bytes;
  }
  const idleMs = options.idleTimeoutMs ?? DEFAULT_BODY_IDLE_TIMEOUT_MS;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadChunk;
    try {
      chunk = await readChunk(reader, idleMs, response.url);
    } catch (error) {
      await reader.cancel().catch(() => {
        // best effort: the transport is already gone
      });
      if (error instanceof UpstreamUnavailableError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new UpstreamUnavailableError(`Reading ${response.url} failed: ${detail}`, {
        reason: "network",
      });
    }
    const { done, value } = chunk;
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
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
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

export function sha512Digest(data: Buffer): Buffer {
  return crypto.createHash("sha512").update(data).digest();
}

// Constant-time comparison against a lowercase hex digest.
export function digestMatchesHex(expectedHex: string, actual: Buffer): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Constant-time comparison against a base64 digest.
export function digestMatchesBase64(expectedBase64: string, actual: Buffer): boolean {
  const expected = Buffer.from(expectedBase64, "base64");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
