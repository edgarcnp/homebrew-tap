import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";
import {
  MAX_ATTEMPTS,
  readRetryPlan,
  RETRY_DELAY_CAP_SECONDS,
  STALE_SKIP_CODE,
  type RetryConclusion,
  type RetryPlan,
} from "../../lib/pipeline/retry.ts";

const FBR = path.join(REPO_ROOT, "packaging", "bin", "fbr.ts");

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fbr-retry-"));
}

interface RecordOverrides {
  app?: string;
  status?: "failed" | "skipped" | "success" | "repair-cask";
  attempt?: number;
  code?: string;
  class?: string;
  retryable?: boolean;
  stage?: string;
  message?: string;
  resolved?: string | null;
  cask?: string | null;
  feed?: string | null;
  retryAfter?: number | null;
  evidence?: Record<string, string>;
}

function writeRecord(dir: string, subdir: string, overrides: RecordOverrides = {}): string {
  const app = overrides.app ?? "vscode";
  const status = overrides.status ?? "failed";
  const record: Record<string, unknown> = {
    schema: 1,
    event_id: `42:${overrides.attempt ?? 1}:${app}`,
    request_id: null,
    app,
    run_id: 42,
    status,
    stage: overrides.stage ?? "detect",
    message: overrides.message ?? "boom",
    resolved_version: overrides.resolved === undefined ? "1.0.0" : overrides.resolved,
    cask_version: overrides.cask === undefined ? "1.0.0" : overrides.cask,
    feed_version: overrides.feed === undefined ? "1.0.0" : overrides.feed,
    retry_after_seconds: overrides.retryAfter ?? null,
    finished_at: "2026-10-07T00:00:00.000Z",
  };
  if (status === "failed") {
    record.code = overrides.code ?? "UNCLASSIFIED";
    record.class = overrides.class ?? "infra";
    record.retryable = overrides.retryable ?? true;
  }
  if (overrides.evidence !== undefined) record.evidence = overrides.evidence;
  const file = path.join(dir, subdir, "run-report-public.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

function readPlan(
  dir: string,
  attempt = 1,
  conclusion: RetryConclusion = "failure",
): RetryPlan {
  return readRetryPlan(dir, attempt, conclusion);
}

function fbr(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [FBR, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("retry plans", () => {
  it("re-runs a failed run whose reports are all retryable, after the record's delay", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", {
      code: "UPSTREAM_UNAVAILABLE",
      class: "transient",
      retryable: true,
      retryAfter: 60,
    });
    const plan = readPlan(dir);
    assert.equal(plan.retry, true);
    assert.equal(plan.action, "rerun-failed-jobs");
    assert.equal(plan.reason, "retryable");
    assert.equal(plan.delay_seconds, 60);
    assert.equal(plan.attempt, 1);
    assert.equal(plan.max_attempts, MAX_ATTEMPTS);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0]?.kind, "failure");
    assert.equal(plan.items[0]?.code, "UPSTREAM_UNAVAILABLE");
  });

  it("leaves a failed run with a terminal failure for a human", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", {
      code: "BUILD_FAILED",
      class: "permanent",
      retryable: false,
    });
    const plan = readPlan(dir);
    assert.equal(plan.retry, false);
    assert.equal(plan.action, null);
    assert.equal(plan.reason, "terminal");
    assert.equal(plan.items[0]?.retryable, false);
  });

  it("holds the whole run when one failure is terminal", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", { retryable: true });
    writeRecord(dir, "run-report-firefox", {
      app: "firefox",
      code: "BUILD_FAILED",
      class: "permanent",
      retryable: false,
    });
    const plan = readPlan(dir);
    assert.equal(plan.retry, false);
    assert.equal(plan.reason, "terminal");
    assert.equal(plan.items.length, 2);
  });

  it("restarts a whole timed-out run, which has no failed job to re-run", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", { retryable: true });
    const plan = readPlan(dir, 1, "timed_out");
    assert.equal(plan.retry, true);
    assert.equal(plan.action, "rerun");
    assert.equal(plan.reason, "retryable");
  });

  it("restarts a timed-out run that left no record", () => {
    const dir = tempDir();
    const plan = readPlan(dir, 1, "timed_out");
    assert.equal(plan.retry, true);
    assert.equal(plan.action, "rerun");
    assert.equal(plan.reason, "infra");
  });

  it("stops at the attempt cap even when every failure is retryable", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", { retryable: true });
    const plan = readPlan(dir, 2);
    assert.equal(plan.retry, false);
    assert.equal(plan.action, null);
    assert.equal(plan.reason, "budget");
  });

  it("prefers the terminal reason on the last attempt", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", {
      code: "SMOKE_FAILED",
      class: "permanent",
      retryable: false,
    });
    const plan = readPlan(dir, 2);
    assert.equal(plan.retry, false);
    assert.equal(plan.reason, "terminal");
  });

  it("treats a failed run that left no record as infrastructure", () => {
    const dir = tempDir();
    const plan = readPlan(dir);
    assert.equal(plan.retry, true);
    assert.equal(plan.action, "rerun-failed-jobs");
    assert.equal(plan.reason, "infra");
    assert.equal(plan.delay_seconds, 0);
    assert.deepEqual(plan.items, []);
  });

  it("stops a recordless failure when the attempt cap is spent", () => {
    const dir = tempDir();
    const plan = readPlan(dir, 2);
    assert.equal(plan.retry, false);
    assert.equal(plan.reason, "budget");
  });

  it("re-runs a whole run when a skip raced the feed", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", {
      status: "skipped",
      resolved: "1.0.0",
      cask: "1.0.0",
      feed: "1.1.0",
      message: "Cask 1.0.0 already at upstream 1.0.0; skipping",
    });
    const plan = readPlan(dir, 1, "success");
    assert.equal(plan.retry, true);
    assert.equal(plan.action, "rerun");
    assert.equal(plan.reason, "skip-race");
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0]?.kind, "skip");
    assert.equal(plan.items[0]?.code, STALE_SKIP_CODE);
    assert.equal(plan.items[0]?.class, null);
  });

  it("does not re-run a skip that did not race the feed", () => {
    const cases: RecordOverrides[] = [
      // Already caught up: the feed has not moved past the pin.
      { resolved: "1.1.0", cask: "1.1.0", feed: "1.1.0" },
      // Cask ahead: a feed regression is not a race.
      { resolved: "1.0.0", cask: "1.1.0", feed: "1.0.0" },
      // An unorderable feed is not proof of anything.
      { resolved: "1.0.0", cask: "1.0.0", feed: "banana" },
      // A missing side cannot prove a race.
      { resolved: null, cask: "1.0.0", feed: "1.1.0" },
    ];
    for (const overrides of cases) {
      const dir = tempDir();
      writeRecord(dir, "run-report-vscode", { status: "skipped", ...overrides });
      const plan = readPlan(dir, 1, "success");
      assert.equal(plan.retry, false, JSON.stringify(overrides));
      assert.equal(plan.reason, "nothing", JSON.stringify(overrides));
      assert.deepEqual(plan.items, [], JSON.stringify(overrides));
    }
  });

  it("stops a raced skip when the attempt cap is spent", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", {
      status: "skipped",
      resolved: "1.0.0",
      cask: "1.0.0",
      feed: "1.1.0",
    });
    const plan = readPlan(dir, 2, "success");
    assert.equal(plan.retry, false);
    assert.equal(plan.reason, "budget");
  });

  it("does nothing when a successful run's records are not actionable", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", { status: "success" });
    writeRecord(dir, "run-report-firefox", { app: "firefox", status: "repair-cask" });
    const plan = readPlan(dir, 1, "success");
    assert.equal(plan.retry, false);
    assert.equal(plan.action, null);
    assert.equal(plan.reason, "nothing");
    assert.deepEqual(plan.items, []);
  });

  it("honors the largest Retry-After and caps it", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", {
      retryable: true,
      retryAfter: 60,
      evidence: { retry_after_seconds: "120" },
    });
    writeRecord(dir, "run-report-firefox", {
      app: "firefox",
      retryable: true,
      evidence: { retry_after_seconds: "900" },
    });
    const plan = readPlan(dir);
    assert.equal(plan.delay_seconds, RETRY_DELAY_CAP_SECONDS);
  });

  it("ignores an unparsable Retry-After evidence value", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", {
      retryable: true,
      evidence: { retry_after_seconds: "soon" },
    });
    const plan = readPlan(dir);
    assert.equal(plan.delay_seconds, 0);
  });

  it("keeps the latest attempt's record for an app", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode/attempt-1", { attempt: 1, retryable: true });
    writeRecord(dir, "run-report-vscode/attempt-2", {
      attempt: 2,
      code: "BUILD_FAILED",
      class: "permanent",
      retryable: false,
    });
    const plan = readPlan(dir, 1);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0]?.code, "BUILD_FAILED");
    assert.equal(plan.reason, "terminal");
  });

  it("fails on a malformed record instead of guessing", () => {
    const broken = tempDir();
    fs.mkdirSync(path.join(broken, "run-report-vscode"), { recursive: true });
    fs.writeFileSync(path.join(broken, "run-report-vscode", "run-report-public.json"), "{not json");
    assert.throws(() => readPlan(broken), /not valid JSON/);

    const missing = tempDir();
    const file = writeRecord(missing, "run-report-vscode", { retryable: true });
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete record["retryable"];
    fs.writeFileSync(file, JSON.stringify(record));
    assert.throws(() => readPlan(missing), /boolean retryable/);
  });

  it("prints the plan as JSON for the workflow", () => {
    const dir = tempDir();
    writeRecord(dir, "run-report-vscode", { retryable: true, retryAfter: 60 });
    const result = fbr([
      "retry-plan",
      "--reports-dir",
      dir,
      "--attempt",
      "1",
      "--conclusion",
      "failure",
    ]);
    assert.equal(result.status, 0);
    const plan = JSON.parse(result.stdout) as RetryPlan;
    assert.equal(plan.retry, true);
    assert.equal(plan.action, "rerun-failed-jobs");
    assert.equal(plan.delay_seconds, 60);
  });

  it("rejects an unknown conclusion and a bad attempt as usage errors", () => {
    const dir = tempDir();
    assert.equal(
      fbr(["retry-plan", "--reports-dir", dir, "--attempt", "1", "--conclusion", "cancelled"]).status,
      2,
    );
    assert.equal(
      fbr(["retry-plan", "--reports-dir", dir, "--attempt", "0", "--conclusion", "failure"]).status,
      2,
    );
  });
});
