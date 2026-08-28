#!/usr/bin/env node
"use strict";

// Shared network utilities for the in-tap resolvers: bounded HTTP downloads
// with retry/backoff, streaming payload reads under a hard size cap, and
// atomic file writes. Used by the apt, GitHub-release, and GitButler CDN
// resolvers so download-safety and retry behavior live in one place.

const crypto = require("node:crypto");
const fs = require("node:fs");

const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 30000;

// Fetches with retry/backoff. options: { headers, redirect, signal,
// timeoutMs }. retries is the total number of attempts.
//
// Semantics shared by all resolvers:
//   - 429/5xx responses retry (backoff, honoring Retry-After, capped at 30s)
//     and are returned on the final attempt so callers' `response.ok` checks
//     stay the single source of failure reporting;
//   - network errors retry with exponential backoff and throw on the final
//     attempt;
//   - a timeout/abort throws immediately (retrying an aborted request is
//     pointless). When timeoutMs is set a fresh AbortSignal is created per
//     attempt; an explicit signal is reused as-is.
async function fetchWithRetry(url, options = {}, retries = 3) {
  const { timeoutMs, ...rest } = options;
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const signal = rest.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
    const fetchOptions = signal ? { ...rest, signal } : rest;
    try {
      const response = await fetch(url, fetchOptions);
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (attempt === retries - 1) return response;
        let delayMs = Math.pow(2, attempt) * 1000;
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const secs = Number(retryAfter);
          if (Number.isFinite(secs)) delayMs = Math.max(delayMs, secs * 1000);
          else {
            const dateMs = Date.parse(retryAfter);
            if (!Number.isNaN(dateMs)) delayMs = Math.max(delayMs, dateMs - Date.now());
          }
        }
        await new Promise((r) => setTimeout(r, Math.min(delayMs, MAX_RETRY_DELAY_MS)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (error.name === "TimeoutError" || error.name === "AbortError") throw error;
      if (attempt === retries - 1) throw lastError;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
  }
  throw lastError;
}

function writeFileAtomic(filePath, data) {
  const tmp = filePath + ".tmp." + crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

async function readPayload(response) {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error(`Payload too large (${bytes.length} bytes) for ${response.url}`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`Payload exceeds size cap (${MAX_PAYLOAD_BYTES} bytes) for ${response.url}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

module.exports = {
  MAX_PAYLOAD_BYTES,
  fetchWithRetry,
  readPayload,
  writeFileAtomic,
};
