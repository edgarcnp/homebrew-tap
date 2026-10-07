// The retry plan: what the tap's CI does with a completed run now that the API
// dispatches at most once per version. The plan reads the run records the run
// uploaded and applies the verdicts they already carry, so the failure table in
// report.ts stays the only policy:
//
//  - a failed run whose failed reports are all retryable is re-run; one
//    terminal failure holds the whole run for a human;
//  - a successful run whose report is a skip that raced its own publish (the
//    recorded feed is newer than both the resolved version and the cask pin)
//    is re-run, the case the API's old re-dispatch used to cover;
//  - a failed run that left no record is infrastructure;
//  - the attempt cap bounds every loop, and a record's advisory
//    `retry_after_seconds` paces the next attempt.

import * as fs from "node:fs";
import * as path from "node:path";
import { assertMatches, assertSingleLine, fail, isRecord } from "../core/guards.ts";
import { APP_ID } from "../core/patterns.ts";
import { compareDebVersions } from "../core/version.ts";
import { REPORT_STATUSES } from "./report.ts";

// Initial run plus one automatic re-run: the budget the API used to spend,
// spent by the CI itself.
export const MAX_ATTEMPTS = 2;

// The CI has no firing cadence to pace a retry, so a record's advisory delay
// is honored directly; the cap keeps the one waiting job bounded.
export const RETRY_DELAY_CAP_SECONDS = 300;

// The public artifact `fbr report` writes; the full record stays the API's.
export const REPORT_FILE_NAME = "run-report-public.json";

// The GitHub conclusions the workflow forwards. A successful run is only
// asked about the skip race; a failure or timeout is asked about its reports.
export const RETRY_CONCLUSIONS = ["failure", "timed_out", "success"] as const;
export type RetryConclusion = (typeof RETRY_CONCLUSIONS)[number];

export type RetryReason = "retryable" | "skip-race" | "terminal" | "infra" | "budget" | "nothing";

// What the workflow POSTs when a re-run is due: the failed jobs for a failure,
// the whole run for a raced skip or a timeout (neither leaves a failed job to
// re-run).
export type RetryAction = "rerun-failed-jobs" | "rerun";

// One actionable record. `code` is the record's failure code, or `STALE_SKIP`
// for a raced skip — a plan-level label, not a run-record code.
export interface RetryItem {
  readonly kind: "failure" | "skip";
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

export const STALE_SKIP_CODE = "STALE_SKIP";

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
  const failedRun = conclusion !== "success";

  if (items.length === 0) {
    if (!failedRun) return result(input, maxAttempts, false, "nothing", null, 0);
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
  // timeout always restarts the whole run; a skip has no failed job either.
  const rerunAll = conclusion === "timed_out" || items.some((item) => item.kind === "skip");
  const action: RetryAction = rerunAll ? "rerun" : "rerun-failed-jobs";
  const reason: RetryReason = items.some((item) => item.kind === "skip") ? "skip-race" : "retryable";
  // A skip has no transport delay; a failure's is honored and capped.
  const delay = rerunAll
    ? 0
    : Math.min(RETRY_DELAY_CAP_SECONDS, Math.max(0, ...items.map((item) => item.retry_after_seconds ?? 0)));
  return result(input, maxAttempts, true, reason, action, delay);
}

function stringField(record: Record<string, unknown>, key: string, file: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") fail(`${file}: ${key} must be a non-empty string`);
  return assertSingleLine(value, `${file}: ${key}`);
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

// Feed newer than both what resolve served and what the cask pins is the
// signature of a skip that raced the feed's own publish. An unorderable pair
// is not proof of a race, so it does not re-run.
function racedSkip(resolved: string | null, cask: string | null, feed: string | null): boolean {
  if (resolved === null || cask === null || feed === null) return false;
  return provablyNewer(feed, resolved) && provablyNewer(feed, cask);
}

function provablyNewer(left: string, right: string): boolean {
  try {
    return compareDebVersions(left, right) > 0;
  } catch {
    return false;
  }
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
  const status = stringField(parsed, "status", file);
  if (!(REPORT_STATUSES as readonly string[]).includes(status)) {
    fail(`${file}: unknown report status ${status}`);
  }
  const app = assertMatches(stringField(parsed, "app", file), APP_ID, `${file}: app`);
  const eventId = stringField(parsed, "event_id", file);
  const eventMatch = /^(\d+):(\d+):(.+)$/.exec(eventId);
  if (eventMatch === null) fail(`${file}: event_id must be <run id>:<attempt>:<app>`);
  if (eventMatch[3] !== app) fail(`${file}: event_id does not name ${app}`);
  const attempt = Number(eventMatch[2]);
  const stage = stringField(parsed, "stage", file);
  const message = stringField(parsed, "message", file);
  const resolvedVersion = optionalVersion(parsed, "resolved_version", file);
  const caskVersion = optionalVersion(parsed, "cask_version", file);
  const feedVersion = optionalVersion(parsed, "feed_version", file);

  if (status === "failed") {
    const retryable = parsed["retryable"];
    if (typeof retryable !== "boolean") {
      fail(`${file}: a failed record needs a boolean retryable`);
    }
    return {
      attempt,
      item: {
        kind: "failure",
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
  if (status === "skipped") {
    if (!racedSkip(resolvedVersion, caskVersion, feedVersion)) return null;
    return {
      attempt,
      item: {
        kind: "skip",
        app,
        code: STALE_SKIP_CODE,
        class: null,
        stage,
        message,
        retryable: true,
        resolved_version: resolvedVersion,
        cask_version: caskVersion,
        feed_version: feedVersion,
        retry_after_seconds: null,
      },
    };
  }
  // success and repair-cask need no action.
  return null;
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
// attempt encoded in event_id orders them; the latest wins.
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
