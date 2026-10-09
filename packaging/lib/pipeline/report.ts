// The run record: the tap's machine-readable signal to the API that dispatches
// builds, and the input the CI's own retry decision reads. One JSON document
// per app per phase, delivered twice: the workflow POSTs the full record,
// OIDC-authenticated, to the API's `/v1/homebrew/tap/events` endpoint and
// uploads a world-readable copy as the `run-report-<app>` artifact with the
// dispatch correlation id redacted (see redactReport). The API owns readiness,
// so retries of a failed run belong to the CI: this module classifies, and
// retry.ts turns the verdict into a re-run or an issue, so a failure site
// cannot emit prose without a code the retry plan can act on.
//
// The API's phases are accepted, succeeded, failed and skipped. The record
// carries the API's phase plus the CI's own verdict fields (`stage`, `class`,
// `retryable`, `retry_after_seconds`), which the API ignores: retry.ts needs
// them, and one document serves both readers. `run_attempt` orders a re-run
// above the attempt it repeats; `event_id` is a fresh UUID per report, stable
// across delivery retries because the written file is re-sent unchanged.
//
// A failure site writes a *fragment* first (writeFailureFragment), which the
// workflow uploads and the report job merges into the record: code, message,
// and — where the site knows better than the job — the stage it failed in and
// transport-level evidence.

import * as crypto from "node:crypto";
import { APP_ID } from "../core/patterns.ts";
import { assertMatches, assertSingleLine, fail } from "../core/guards.ts";
import { writeFileAtomic } from "../core/http.ts";

// The API's phases: accepted binds the attempt to a GitHub run, the other
// three conclude it. `repair-cask` is subsumed by succeeded (the API treats
// the observed cask pin as the truth).
export const REPORT_PHASES = ["accepted", "succeeded", "failed", "skipped"] as const;
export type ReportPhase = (typeof REPORT_PHASES)[number];

// The typed reason a skipped report can carry. `not-ready` is the one the API
// acts on: the upstream artifact the API asked for is not published yet, so the
// attempt waits and the API asks again later. Every other skip is terminal.
export const REPORT_SKIP_REASONS = ["not-ready"] as const;
export type ReportSkipReason = (typeof REPORT_SKIP_REASONS)[number];

export const REPORT_STAGES = ["plan", "detect", "toolchain", "build", "publish", "pin-cask"] as const;
export type ReportStage = (typeof REPORT_STAGES)[number];

export type FailureClass = "transient" | "permanent" | "config" | "infra";

export interface FailureCodeSpec {
  readonly class: FailureClass;
  readonly retryable: boolean;
  // Present only when the CI retry should wait before re-running.
  readonly retryAfterSeconds?: number;
}

// The classification contract. The retry plan reads these verdicts straight off
// the record, so a new failure site must land here (with its verdict) rather
// than inventing a code the workflow alone knows. `UNCLASSIFIED` is the
// deliberate fallback: unknown failures are re-run within the CI's attempt cap
// instead of being silently dropped.
//
// Evidence conventions: a transient upstream failure reports what the transport
// said (http_status, retry_after_seconds, reason, rate_limited), so the retry
// plan can wait out a rate limit instead of guessing.
export const FAILURE_CODES = {
  UPSTREAM_UNAVAILABLE: { class: "transient", retryable: true },
  UPSTREAM_CONFLICT: { class: "transient", retryable: true, retryAfterSeconds: 60 },
  TOOLCHAIN_DOWNLOAD: { class: "transient", retryable: true },
  PUBLISH_FAILED: { class: "transient", retryable: true },
  PIN_CASK_FAILED: { class: "transient", retryable: true },
  UNCLASSIFIED: { class: "infra", retryable: true, retryAfterSeconds: 300 },
  BUILD_FAILED: { class: "permanent", retryable: false },
  SMOKE_FAILED: { class: "permanent", retryable: false },
  UPDATER_RESIDUAL: { class: "permanent", retryable: false },
  ARTIFACT_MISSING: { class: "permanent", retryable: false },
  GUARD_VIOLATION: { class: "permanent", retryable: false },
  CHECKSUM_MISMATCH: { class: "permanent", retryable: false },
  USAGE: { class: "config", retryable: false },
  DESCRIPTOR_INVALID: { class: "config", retryable: false },
  UNKNOWN_APP: { class: "config", retryable: false },
} as const satisfies Record<string, FailureCodeSpec>;

export type FailureCode = keyof typeof FAILURE_CODES;

export interface ReportInput {
  app: string;
  runId: number;
  runAttempt: number;
  phase: ReportPhase;
  stage: ReportStage;
  // Required for "failed"; forbidden for every other phase. Explicitly
  // `| undefined` so callers may pass an absent flag straight through.
  code?: FailureCode | undefined;
  // The typed reason on a skipped report; forbidden on every other phase.
  reason?: ReportSkipReason | undefined;
  message: string;
  // The API's correlation id for the dispatch that caused this run. Absent or
  // null for a manual run, which the record stores as null.
  requestId?: string | null;
  // A fresh UUID for this report. Minted when absent; the CLI keeps the flag
  // for tests, which need a deterministic id.
  eventId?: string | undefined;
  resolvedVersion?: string | null;
  // The cask pin the gate compared against, and the feed version the tap read.
  caskVersion?: string | null;
  feedVersion?: string | null;
  evidence?: Record<string, string>;
  finishedAt?: Date;
}

// Serialized shape the API consumes: snake_case keys, null for an absent
// version, and the code's verdict copied next to the code so a reader never
// needs this repository's table. The API ignores `run_attempt`, `stage`,
// `class`, `retryable` and `retry_after_seconds`; retry.ts reads them.
export interface RunReport {
  // A UUID, unique per report and stable across delivery retries.
  event_id: string;
  // The API's correlation id for the dispatch that caused the run; null for
  // manual runs and any run the API did not start. The POSTed record carries
  // it; the public artifact copy redacts it to null.
  request_id: string | null;
  app: string;
  phase: ReportPhase;
  // Present only on a skipped report; the API reads it to decide waiting.
  reason?: ReportSkipReason;
  run_id: number;
  run_attempt: number;
  stage: ReportStage;
  code?: FailureCode;
  class?: FailureClass;
  retryable?: boolean;
  retry_after_seconds?: number | null;
  message: string;
  resolved_version: string | null;
  cask_version: string | null;
  feed_version: string | null;
  evidence?: Record<string, string>;
  finished_at: string;
}

// Correlation ids (request_id, event_id) travel into the API's logs and
// storage, so they are deliberately narrower than free text: one line, at most
// 128 characters, and a conservative charset. A bad id is a caller bug, not a
// record to ship.
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CORRELATION_ID_MAX_LENGTH = 128;

// The API's general string bound is 256 bytes; the message — the one free-form
// field — gets 2 KiB. An over-long message is clamped rather than refused: a
// long diagnostic must not cost the run its record (and the retry verdict the
// record carries). The body itself stays under the API's 64 KiB.
export const MESSAGE_MAX_BYTES = 2048;
export const STRING_MAX_BYTES = 256;
export const BODY_MAX_BYTES = 64 * 1024;

// Appended to a message the clamp cut short, so a reader can tell prose was
// lost and find the rest in the run log.
const MESSAGE_TRUNCATION_MARKER = "... [truncated]";

// `echoValue` is false for the dispatch correlation id: a malformed value is a
// caller bug, and the value itself must not reach a public log.
function assertCorrelationId(value: string, label: string, echoValue = true): string {
  assertSingleLine(value, label);
  if (value.length > CORRELATION_ID_MAX_LENGTH) {
    fail(`${label} is longer than ${CORRELATION_ID_MAX_LENGTH} characters`);
  }
  if (!CORRELATION_ID_PATTERN.test(value)) {
    fail(echoValue ? `Invalid ${label}: ${value}` : `Invalid ${label}`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertUuid(value: string, label: string): string {
  assertSingleLine(value, label);
  if (!UUID_PATTERN.test(value)) fail(`Invalid ${label}: ${value}`);
  return value;
}

function assertByteLength(value: string, max: number, label: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > max) fail(`${label} is ${bytes} bytes; the API caps it at ${max}`);
  return value;
}

// Truncates to at most `max` bytes without splitting a code point: walking code
// points keeps a multi-byte character whole or drops it whole.
function truncateToBytes(value: string, max: number): string {
  let used = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > max) break;
    used += size;
    end += char.length;
  }
  return value.slice(0, end);
}

// The message is human prose, and an over-long one must not cost the run its
// record: the report job would fail, upload nothing, and retry.yml would read
// the missing artifact as infrastructure and re-run. Clamp it instead, and
// mark the cut so the bug that produced the long message stays visible.
function clampMessage(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MESSAGE_MAX_BYTES) return value;
  const budget = MESSAGE_MAX_BYTES - Buffer.byteLength(MESSAGE_TRUNCATION_MARKER, "utf8");
  return `${truncateToBytes(value, budget)}${MESSAGE_TRUNCATION_MARKER}`;
}

// A version the caller could not read stores as null; a value the API would
// reject is a caller bug and fails here instead of on POST.
function optionalString(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  assertSingleLine(value, label);
  return assertByteLength(value, STRING_MAX_BYTES, label);
}

export function buildReport(input: ReportInput): RunReport {
  // The API validates this field against the same pattern as its discovery, so
  // refuse a record it would 422 rather than writing one it cannot attribute.
  const app = assertMatches(input.app, APP_ID, "report app");
  const message = clampMessage(assertSingleLine(input.message, "report message"));
  if (message === "") fail("Report message must not be empty");
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) {
    fail(`Report run id is not a sane run number: ${input.runId}`);
  }
  if (!Number.isSafeInteger(input.runAttempt) || input.runAttempt <= 0) {
    fail(`Report run attempt is not a sane attempt number: ${input.runAttempt}`);
  }
  if (!REPORT_STAGES.includes(input.stage)) fail(`Unknown report stage: ${input.stage}`);
  if (!REPORT_PHASES.includes(input.phase)) fail(`Unknown report phase: ${input.phase}`);
  if (input.phase === "failed" && input.code === undefined) {
    fail("A failed report needs a failure code");
  }
  if (input.phase !== "failed" && input.code !== undefined) {
    fail(`A ${input.phase} report carries no failure code`);
  }
  if (input.reason !== undefined) {
    if (input.phase !== "skipped") fail(`A ${input.phase} report carries no reason`);
    if (!(REPORT_SKIP_REASONS as readonly string[]).includes(input.reason)) {
      fail(`Unknown report reason: ${input.reason}`);
    }
  }
  const requestId =
    input.requestId === undefined || input.requestId === null
      ? null
      : assertCorrelationId(input.requestId, "report request id", false);
  const eventId =
    input.eventId === undefined
      ? crypto.randomUUID()
      : assertUuid(input.eventId, "report event id");

  const report: RunReport = {
    event_id: eventId,
    request_id: requestId,
    app,
    phase: input.phase,
    run_id: input.runId,
    run_attempt: input.runAttempt,
    stage: input.stage,
    message,
    resolved_version: optionalString(input.resolvedVersion, "report resolved version"),
    cask_version: optionalString(input.caskVersion, "report cask version"),
    feed_version: optionalString(input.feedVersion, "report feed version"),
    finished_at: (input.finishedAt ?? new Date()).toISOString(),
  };
  if (input.reason !== undefined) report.reason = input.reason;
  if (input.code !== undefined) {
    const spec: FailureCodeSpec | undefined = FAILURE_CODES[input.code];
    if (spec === undefined) fail(`Unknown failure code: ${input.code}`);
    report.code = input.code;
    report.class = spec.class;
    report.retryable = spec.retryable;
    report.retry_after_seconds = spec.retryAfterSeconds ?? null;
  }
  if (input.evidence !== undefined && Object.keys(input.evidence).length > 0) {
    for (const [key, value] of Object.entries(input.evidence)) {
      assertEvidenceValue(value, `report evidence value for ${key}`);
    }
    const bytes = Buffer.byteLength(JSON.stringify(input.evidence), "utf8");
    if (bytes > EVIDENCE_MAX_BYTES) {
      fail(`Report evidence is ${bytes} bytes serialized; the API caps it at ${EVIDENCE_MAX_BYTES}`);
    }
    report.evidence = { ...input.evidence };
  }
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > BODY_MAX_BYTES) {
    fail(`Report body is ${bodyBytes} bytes; the API caps it at ${BODY_MAX_BYTES}`);
  }
  return report;
}

// Writes the record atomically and returns the path it wrote.
export function writeReport(outputPath: string, report: RunReport): string {
  writeFileAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

// The record as the public artifact carries it. The artifact is world-readable
// on a public tap, so the dispatch correlation id is redacted to null; the
// API's match against the live attempt only needs the POSTed body.
export function redactReport(report: RunReport): RunReport {
  return { ...report, request_id: null };
}

// Writes the world-readable copy atomically and returns the path it wrote.
export function writePublicReport(outputPath: string, report: RunReport): string {
  writeFileAtomic(outputPath, `${JSON.stringify(redactReport(report), null, 2)}\n`);
  return outputPath;
}

// Evidence keys and values are part of the record's contract: the report job
// copies them through `fbr report --evidence`, which rejects a key that is not
// snake_case or a value that is not one line. Validated here too, so a hint
// fails at the site that produced it instead of costing the run its record.
export const EVIDENCE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

// The API's evidence bounds: a string above 256 bytes, or a serialized map over
// 4096 bytes, is answered 422. Enforced at the source so a site fails before
// the record is built rather than after the API rejects it.
export const EVIDENCE_VALUE_MAX_BYTES = STRING_MAX_BYTES;
export const EVIDENCE_MAX_BYTES = 4096;

export function assertEvidenceValue(value: string, label: string): string {
  if (/[\r\n\u0000]/.test(value)) fail(`${label} must be a single line`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > EVIDENCE_VALUE_MAX_BYTES) {
    fail(`${label} is ${bytes} bytes; the API caps an evidence value at ${EVIDENCE_VALUE_MAX_BYTES}`);
  }
  return value;
}

export interface FailureFragment {
  code: FailureCode;
  message: string;
  // Only when the site's stage differs from the job the workflow watched, e.g.
  // a toolchain download failing before the build command runs.
  stage?: ReportStage | undefined;
  evidence?: Record<string, string> | undefined;
}

// What a failure site writes for itself: the workflow uploads this file as a
// report-code artifact and the report job prefers it over its own stage
// heuristic. The message is flattened to one line here so a multi-line error
// cannot produce a fragment the report job would have to reject, and clamped
// so a long error cannot fail the site before it writes its verdict.
export function writeFailureFragment(outputPath: string, failure: FailureFragment): string {
  if (failure.stage !== undefined && !REPORT_STAGES.includes(failure.stage)) {
    fail(`Unknown fragment stage: ${failure.stage}`);
  }
  if (failure.evidence !== undefined) {
    for (const [key, value] of Object.entries(failure.evidence)) {
      if (!EVIDENCE_KEY_PATTERN.test(key)) fail(`Fragment evidence key is not snake_case: ${key}`);
      assertEvidenceValue(value, `Fragment evidence value for ${key}`);
    }
  }
  const fragment: Record<string, unknown> = {
    code: failure.code,
    message: clampMessage(failure.message.replace(/[\r\n\u0000]+/g, " ")),
  };
  if (failure.stage !== undefined) fragment["stage"] = failure.stage;
  if (failure.evidence !== undefined && Object.keys(failure.evidence).length > 0) {
    fragment["evidence"] = { ...failure.evidence };
  }
  writeFileAtomic(outputPath, `${JSON.stringify(fragment)}\n`);
  return outputPath;
}
