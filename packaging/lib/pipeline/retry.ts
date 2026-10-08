// The retry plan: what the tap's CI does with a completed run's failed jobs.
// The API owns readiness and re-asks after a not-ready skip, so the plan acts
// on failures only; a successful run — including one that deliberately skipped
// — needs no action. The plan reads the run records the run uploaded and
// applies the verdicts they already carry, so the failure table in report.ts
// stays the only policy:
//
//  - a failed run whose failed reports are all retryable is re-run; one
//    terminal failure holds the whole run for a human;
//  - a failed run that left no record is infrastructure;
//  - the attempt cap bounds every loop, and a record's advisory
//    `retry_after_seconds` paces the next attempt.

import * as fs from "node:fs";
import * as path from "node:path";
import { assertMatches, assertSingleLine, fail, isRecord } from "../core/guards.ts";
import { APP_ID } from "../core/patterns.ts";
import { REPORT_PHASES } from "./report.ts";

// Initial run plus one automatic re-run: the budget the API used to spend,
// spent by the CI itself.
export const MAX_ATTEMPTS = 2;

// The CI has no firing cadence to pace a retry, so a record's advisory delay
// is honored directly; the cap keeps the one waiting job bounded.
export const RETRY_DELAY_CAP_SECONDS = 300;

// The public artifact `fbr report` writes; the full record stays the API's.
export const REPORT_FILE_NAME = "run-report-public.json";

// The GitHub conclusions the workflow forwards: a successful run — including
// one that deliberately skipped — is the API's to re-ask, never the CI's.
export const RETRY_CONCLUSIONS = ["failure", "timed_out"] as const;
export type RetryConclusion = (typeof RETRY_CONCLUSIONS)[number];

export type RetryReason = "retryable" | "terminal" | "infra" | "budget";

// What the workflow POSTs when a re-run is due: the failed jobs for a failure,
// the whole run for a timeout (which leaves no failed job to re-run).
export type RetryAction = "rerun-failed-jobs" | "rerun";

// One actionable record: a failed report and the verdict it carries.
export interface RetryItem {
  readonly app: string;
  readonly code: string;
  readonly class: string | null;
  readonly stage: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly resolved_version: string | null;
  readonly cask_version: string | null;
  readonly feed_version: string | null;
  readonly retry_after_seconds: number | null;
}

// Serialized snake_case, like the record itself: the workflow reads this JSON
// directly.
export interface RetryPlan {
  readonly retry: boolean;
  readonly action: RetryAction | null;
  readonly reason: RetryReason;
  readonly delay_seconds: number;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly items: readonly RetryItem[];
}

export interface RetryInput {
  readonly items: readonly RetryItem[];
  readonly attempt: number;
  readonly conclusion: RetryConclusion;
  readonly maxAttempts?: number;
}

function result(
  input: RetryInput,
  maxAttempts: number,
  retry: boolean,
  reason: RetryReason,
  action: RetryAction | null,
  delaySeconds: number,
): RetryPlan {
  return {
    retry,
    action,
    reason,
    delay_seconds: delaySeconds,
    attempt: input.attempt,
    max_attempts: maxAttempts,
    items: input.items,
  };
}

export function planRetry(input: RetryInput): RetryPlan {
  const { attempt, conclusion, items } = input;
  const maxAttempts = input.maxAttempts ?? MAX_ATTEMPTS;
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    fail(`Attempt must be a positive integer, got ${attempt}`);
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    fail(`Max attempts must be a positive integer, got ${maxAttempts}`);
  }
  if (!(RETRY_CONCLUSIONS as readonly string[]).includes(conclusion)) {
    fail(`Unknown run conclusion: ${conclusion}`);
  }
  if (items.length === 0) {
    // A failed run with no record died before the report job could write one
    // (runner loss, cancellation): infrastructure, the one failure worth a
    // re-run without a verdict.
    if (attempt < maxAttempts) {
      const action: RetryAction = conclusion === "timed_out" ? "rerun" : "rerun-failed-jobs";
      return result(input, maxAttempts, true, "infra", action, 0);
    }
    return result(input, maxAttempts, false, "budget", null, 0);
  }
  // A terminal failure holds the whole run: re-running failed jobs would
  // re-run it too, and the plan leaves it for a human instead.
  if (items.some((item) => !item.retryable)) {
    return result(input, maxAttempts, false, "terminal", null, 0);
  }
  if (attempt >= maxAttempts) return result(input, maxAttempts, false, "budget", null, 0);

  // A timed-out job is not a failed job to GitHub's failed-jobs endpoint, so a
  // timeout always restarts the whole run.
  const action: RetryAction = conclusion === "timed_out" ? "rerun" : "rerun-failed-jobs";
  // A timeout has no transport delay; a failure's is honored and capped.
  const delay =
    conclusion === "timed_out"
      ? 0
      : Math.min(
          RETRY_DELAY_CAP_SECONDS,
          Math.max(0, ...items.map((item) => item.retry_after_seconds ?? 0)),
        );
  return result(input, maxAttempts, true, "retryable", action, delay);
}

function stringField(record: Record<string, unknown>, key: string, file: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") fail(`${file}: ${key} must be a non-empty string`);
  return assertSingleLine(value, `${file}: ${key}`);
}

function integerField(record: Record<string, unknown>, key: string, file: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${file}: ${key} must be a positive integer`);
  }
  return value as number;
}

function optionalVersion(record: Record<string, unknown>, key: string, file: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${file}: ${key} must be a string or null`);
  return assertSingleLine(value, `${file}: ${key}`);
}

// The retry delay a record asks for: its own policy field, or the transport's
// Retry-After evidence when the failing site could read one. The largest wins.
function retryDelay(record: Record<string, unknown>, file: string): number | null {
  let delay: number | null = null;
  const policy = record["retry_after_seconds"];
  if (policy !== undefined && policy !== null) {
    if (!Number.isSafeInteger(policy) || (policy as number) < 0) {
      fail(`${file}: retry_after_seconds must be a non-negative integer or null`);
    }
    delay = policy as number;
  }
  const evidence = record["evidence"];
  if (isRecord(evidence) && typeof evidence["retry_after_seconds"] === "string") {
    const raw = evidence["retry_after_seconds"];
    if (/^\d+$/.test(raw)) {
      const seconds = Number(raw);
      if (Number.isSafeInteger(seconds)) delay = Math.max(delay ?? 0, seconds);
    }
  }
  return delay;
}

interface ParsedRecord {
  readonly attempt: number;
  readonly item: RetryItem;
}

function readRecord(file: string): ParsedRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fail(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) fail(`${file} is not a JSON object`);
  const phase = stringField(parsed, "phase", file);
  if (!(REPORT_PHASES as readonly string[]).includes(phase)) {
    fail(`${file}: unknown report phase ${phase}`);
  }
  const app = assertMatches(stringField(parsed, "app", file), APP_ID, `${file}: app`);
  const attempt = integerField(parsed, "run_attempt", file);
  const stage = stringField(parsed, "stage", file);
  const message = stringField(parsed, "message", file);
  const resolvedVersion = optionalVersion(parsed, "resolved_version", file);
  const caskVersion = optionalVersion(parsed, "cask_version", file);
  const feedVersion = optionalVersion(parsed, "feed_version", file);

  // A succeeded record needs no action, and the API owns re-asking after a
  // skipped one; only a failed record carries a retry verdict.
  if (phase !== "failed") return null;

  const retryable = parsed["retryable"];
  if (typeof retryable !== "boolean") {
    fail(`${file}: a failed record needs a boolean retryable`);
  }
  return {
    attempt,
    item: {
      app,
      code: stringField(parsed, "code", file),
      class: stringField(parsed, "class", file),
      stage,
      message,
      retryable,
      resolved_version: resolvedVersion,
      cask_version: caskVersion,
      feed_version: feedVersion,
      retry_after_seconds: retryDelay(parsed, file),
    },
  };
}

function reportFiles(reportsDir: string): string[] {
  if (!fs.existsSync(reportsDir)) fail(`Reports directory does not exist: ${reportsDir}`);
  return fs
    .readdirSync(reportsDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => path.basename(entry) === REPORT_FILE_NAME)
    .map((entry) => path.join(reportsDir, entry))
    .sort();
}

// One record per app: re-running failed jobs keeps the previous attempt's
// artifacts around, so a download can carry several records for one app. The
// recorded attempt orders them; the latest wins.
function readItems(reportsDir: string): RetryItem[] {
  const byApp = new Map<string, ParsedRecord>();
  for (const file of reportFiles(reportsDir)) {
    const record = readRecord(file);
    if (record === null) continue;
    const previous = byApp.get(record.item.app);
    if (previous === undefined || record.attempt >= previous.attempt) {
      byApp.set(record.item.app, record);
    }
  }
  return [...byApp.values()]
    .map((record) => record.item)
    .sort((left, right) => left.app.localeCompare(right.app));
}

export function readRetryPlan(
  reportsDir: string,
  attempt: number,
  conclusion: RetryConclusion,
  maxAttempts = MAX_ATTEMPTS,
): RetryPlan {
  return planRetry({ items: readItems(reportsDir), attempt, conclusion, maxAttempts });
}
