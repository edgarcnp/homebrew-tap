// The run record: the tap's machine-readable signal to the API that dispatches
// builds. One JSON document per app per run, uploaded as a failure-report
// artifact. Retry policy lives in the API; this module only classifies, so a
// failure site cannot emit prose without a code the API can act on.
//
// A failure site writes a *fragment* first (writeFailureFragment), which the
// workflow uploads and the report job merges into the record: code, message,
// and — where the site knows better than the job — the stage it failed in and
// transport-level evidence.

import { assertSafeName, assertSingleLine, fail } from "../core/guards.ts";
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
  // Present only when the API should wait before re-dispatching.
  readonly retryAfterSeconds?: number;
}

// The classification contract. The API reads these verdicts straight off the
// record, so a new failure site must land here (with its verdict) rather than
// inventing a code the workflow alone knows. `UNCLASSIFIED` is the deliberate
// fallback: unknown failures retry under the API's global budget instead of
// being silently dropped.
//
// Evidence conventions: a transient upstream failure reports what the transport
// said (http_status, retry_after_seconds, reason, rate_limited), so the API can
// wait out a rate limit instead of guessing.
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
  resolvedVersion?: string | null;
  // The cask pin the gate compared against. Without it the API cannot tell a
  // skip that raced a publish (worth re-dispatching) from one whose cask is
  // already ahead of the oracle (re-dispatching changes nothing).
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

export function buildReport(input: ReportInput): RunReport {
  const app = assertSafeName(input.app, "report app");
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

  const report: RunReport = {
    schema: REPORT_SCHEMA,
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
    report.evidence = { ...input.evidence };
  }
  return report;
}

// Writes the record atomically and returns the path it wrote.
export function writeReport(outputPath: string, report: RunReport): string {
  writeFileAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

// Evidence keys and values are part of the record's contract: the report job
// copies them through `fbr report --evidence`, which rejects a key that is not
// snake_case or a value that is not one line. Validated here too, so a hint
// fails at the site that produced it instead of costing the run its record.
export const EVIDENCE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export function assertEvidenceValue(value: string, label: string): string {
  if (/[\r\n\u0000]/.test(value)) fail(`${label} must be a single line`);
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
