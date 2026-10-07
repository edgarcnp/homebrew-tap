// The run record: the tap's machine-readable signal to the API that dispatches
// builds, and the input the CI's own retry decision reads. One JSON document
// per app per run, delivered twice: the workflow POSTs the full record to the
// API's `/v1/homebrew/tap/events` endpoint and uploads a world-readable copy
// as the `run-report-<app>` artifact with the dispatch correlation id redacted
// (see redactReport). The API dispatches at most once per version, so retries
// belong to the CI: this module classifies, and retry.ts turns the verdict
// into a re-run or an issue, so a failure site cannot emit prose without a
// code the retry plan can act on.
//
// A failure site writes a *fragment* first (writeFailureFragment), which the
// workflow uploads and the report job merges into the record: code, message,
// and — where the site knows better than the job — the stage it failed in and
// transport-level evidence.

import { APP_ID } from "../core/patterns.ts";
import { assertMatches, assertSingleLine, fail } from "../core/guards.ts";
import { writeFileAtomic } from "../core/http.ts";

export const REPORT_SCHEMA = 1;

export const REPORT_STAGES = ["plan", "detect", "toolchain", "build", "publish", "pin-cask"] as const;
export type ReportStage = (typeof REPORT_STAGES)[number];

export const REPORT_STATUSES = ["success", "failed", "skipped", "repair-cask"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

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
  status: ReportStatus;
  stage: ReportStage;
  // Required for "failed"; forbidden for every other status. Explicitly
  // `| undefined` so callers may pass an absent flag straight through.
  code?: FailureCode | undefined;
  message: string;
  // The API's correlation id for the dispatch that caused this run. Absent or
  // null for a manual run, which the record stores as null.
  requestId?: string | null;
  // The dispatch's event id: the workflow passes the deterministic
  // `${run_id}:${run_attempt}:${app}`, so a re-sent record carries the same id
  // and the API dedupes it instead of creating a second event.
  eventId: string;
  resolvedVersion?: string | null;
  // The cask pin the gate compared against. Together with the resolved and
  // feed versions it lets the retry plan tell a skip that raced a publish
  // (worth re-running) from one whose cask is already ahead of the oracle
  // (re-running changes nothing).
  caskVersion?: string | null;
  feedVersion?: string | null;
  evidence?: Record<string, string>;
  finishedAt?: Date;
}

// Serialized shape the API consumes: snake_case keys, null for an absent
// version, and the code's verdict copied next to the code so a reader never
// needs this repository's table.
export interface RunReport {
  schema: number;
  // The dispatch's event id, `${run_id}:${run_attempt}:${app}`: required and
  // stable across delivery retries, so the API dedupes a re-sent record.
  event_id: string;
  // The API's correlation id for the dispatch that caused the run; null for
  // manual runs and any run the API did not start. The POSTed record carries
  // it; the public artifact copy redacts it to null.
  request_id: string | null;
  app: string;
  run_id: number;
  status: ReportStatus;
  stage: ReportStage;
  code?: FailureCode;
  class?: FailureClass;
  retryable?: boolean;
  retry_after_seconds: number | null;
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

export function buildReport(input: ReportInput): RunReport {
  // The API validates this field against the same pattern as its discovery, so
  // refuse a record it would 422 rather than writing one it cannot attribute.
  const app = assertMatches(input.app, APP_ID, "report app");
  const message = assertSingleLine(input.message, "report message");
  if (message === "") fail("Report message must not be empty");
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) {
    fail(`Report run id is not a sane run number: ${input.runId}`);
  }
  if (!REPORT_STAGES.includes(input.stage)) fail(`Unknown report stage: ${input.stage}`);
  if (!REPORT_STATUSES.includes(input.status)) fail(`Unknown report status: ${input.status}`);
  if (input.status === "failed" && input.code === undefined) {
    fail("A failed report needs a failure code");
  }
  if (input.status !== "failed" && input.code !== undefined) {
    fail(`A ${input.status} report carries no failure code`);
  }
  const requestId =
    input.requestId === undefined || input.requestId === null
      ? null
      : assertCorrelationId(input.requestId, "report request id", false);
  const eventId = assertCorrelationId(input.eventId, "report event id");

  const report: RunReport = {
    schema: REPORT_SCHEMA,
    event_id: eventId,
    request_id: requestId,
    app,
    run_id: input.runId,
    status: input.status,
    stage: input.stage,
    retry_after_seconds: null,
    message,
    resolved_version: input.resolvedVersion ?? null,
    cask_version: input.caskVersion ?? null,
    feed_version: input.feedVersion ?? null,
    finished_at: (input.finishedAt ?? new Date()).toISOString(),
  };
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

// The API's evidence bounds: one value over 1 KiB, or a serialized map over
// 4096 bytes, is answered 422. Enforced at the source so a site fails before
// the record is built rather than after the API rejects it.
export const EVIDENCE_VALUE_MAX_BYTES = 1024;
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
// cannot produce a fragment the report job would have to reject.
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
    message: failure.message.replace(/[\r\n\u0000]+/g, " "),
  };
  if (failure.stage !== undefined) fragment["stage"] = failure.stage;
  if (failure.evidence !== undefined && Object.keys(failure.evidence).length > 0) {
    fragment["evidence"] = { ...failure.evidence };
  }
  writeFileAtomic(outputPath, `${JSON.stringify(fragment)}\n`);
  return outputPath;
}
