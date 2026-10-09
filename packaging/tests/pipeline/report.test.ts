import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";
import { APP_ID } from "../../lib/core/patterns.ts";
import { listApps } from "../../lib/pipeline/descriptor.ts";
import {
  buildReport,
  FAILURE_CODES,
  redactReport,
  REPORT_STAGES,
  writeFailureFragment,
  type FailureCode,
  type FailureCodeSpec,
} from "../../lib/pipeline/report.ts";

const FBR = path.join(REPO_ROOT, "packaging", "bin", "fbr.ts");
// A fixed UUID so the records a test builds are deterministic.
const EVENT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fbr(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [FBR, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fbr-report-"));
}

describe("run records", () => {
  it("copies every failure code's verdict onto the record", () => {
    for (const code of Object.keys(FAILURE_CODES) as FailureCode[]) {
      const report = buildReport({
        app: "vscode",
        runId: 42,
        runAttempt: 2,
        phase: "failed",
        stage: "detect",
        code,
        message: `boom: ${code}`,
        eventId: EVENT_ID,
      });
      const spec: FailureCodeSpec = FAILURE_CODES[code];
      assert.equal(report.phase, "failed");
      assert.equal(report.run_attempt, 2);
      assert.equal(report.code, code);
      assert.equal(report.class, spec.class);
      assert.equal(report.retryable, spec.retryable);
      assert.equal(report.retry_after_seconds, spec.retryAfterSeconds ?? null);
    }
  });

  it("carries no code or verdict for a non-failure", () => {
    const report = buildReport({
      app: "vscode",
      runId: 42,
      runAttempt: 1,
      phase: "skipped",
      stage: "detect",
      message: "not-ready: upstream publishes 1.0.0; requested 1.1.0",
      resolvedVersion: "1.0.0",
      feedVersion: null,
      eventId: EVENT_ID,
    });
    assert.equal(report.code, undefined);
    assert.equal(report.class, undefined);
    assert.equal(report.retryable, undefined);
    assert.equal(report.retry_after_seconds, undefined);
    assert.equal(report.resolved_version, "1.0.0");
    assert.equal(report.feed_version, null);
  });

  it("carries the typed not-ready reason on a skipped record", () => {
    const report = buildReport({
      app: "vscode",
      runId: 42,
      runAttempt: 1,
      phase: "skipped",
      stage: "detect",
      reason: "not-ready",
      message: "not-ready: upstream publishes 1.0.0; requested 1.1.0",
      resolvedVersion: "1.0.0",
      eventId: EVENT_ID,
    });
    assert.equal(report.reason, "not-ready");
    assert.equal(report.phase, "skipped");
  });

  it("rejects a reason on a non-skip phase and an unknown reason", () => {
    const base = {
      app: "vscode",
      runId: 1,
      runAttempt: 1,
      message: "x",
      eventId: EVENT_ID,
    } as const;
    assert.throws(
      () =>
        buildReport({
          ...base,
          phase: "failed",
          stage: "build",
          code: "BUILD_FAILED",
          reason: "not-ready",
        }),
      /carries no reason/,
    );
    assert.throws(
      () => buildReport({ ...base, phase: "skipped", stage: "detect", reason: "unknown" as never }),
      /Unknown report reason/,
    );
  });

  it("mints a UUID event id when the caller supplies none", () => {
    const report = buildReport({
      app: "vscode",
      runId: 42,
      runAttempt: 1,
      phase: "succeeded",
      stage: "publish",
      message: "run completed",
    });
    assert.match(report.event_id, UUID_PATTERN);
    // The minted id is lowercase, so the API's UUID check cannot be handed a
    // differently-cased value.
    assert.equal(report.event_id, report.event_id.toLowerCase());
  });

  it("carries the caller's event id and leaves request_id null when none was supplied", () => {
    const report = buildReport({
      app: "vscode",
      runId: 42,
      runAttempt: 1,
      phase: "skipped",
      stage: "detect",
      message: "already up to date",
      eventId: EVENT_ID,
    });
    assert.equal(report.request_id, null);
    assert.equal(report.event_id, EVENT_ID);
  });

  it("copies the dispatch correlation id and event id through verbatim", () => {
    const report = buildReport({
      app: "vscode",
      runId: 42,
      runAttempt: 2,
      phase: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      message: "boom",
      requestId: "req-01J0Z6B8Y4",
      eventId: EVENT_ID,
    });
    assert.equal(report.request_id, "req-01J0Z6B8Y4");
    assert.equal(report.event_id, EVENT_ID);
  });

  it("redacts the dispatch correlation id from the public copy", () => {
    const report = buildReport({
      app: "vscode",
      runId: 42,
      runAttempt: 1,
      phase: "succeeded",
      stage: "publish",
      message: "done",
      requestId: "req-01J0Z6B8Y4",
      eventId: EVENT_ID,
    });
    const publicReport = redactReport(report);
    assert.equal(publicReport.request_id, null);
    assert.equal(publicReport.event_id, EVENT_ID);
    // The public copy keeps the record's shape; only the id changes.
    assert.deepEqual(Object.keys(publicReport).sort(), Object.keys(report).sort());
    // The POSTed record keeps the id for the API's attempt match.
    assert.equal(report.request_id, "req-01J0Z6B8Y4");
  });

  it("does not echo a malformed request id into the error", () => {
    assert.throws(
      () =>
        buildReport({
          app: "vscode",
          runId: 42,
          runAttempt: 1,
          phase: "succeeded",
          stage: "publish",
          message: "done",
          requestId: "req secret",
          eventId: EVENT_ID,
        }),
      (error: unknown) =>
        error instanceof Error &&
        /Invalid report request id/.test(error.message) &&
        !error.message.includes("req secret"),
    );
  });

  it("rejects correlation ids that are not one safe token", () => {
    const base = {
      app: "vscode",
      runId: 42,
      runAttempt: 1,
      phase: "succeeded",
      stage: "publish",
      message: "done",
      eventId: EVENT_ID,
    } as const;
    assert.throws(() => buildReport({ ...base, requestId: "two\nlines" }), /newlines or NUL/);
    assert.throws(
      () => buildReport({ ...base, requestId: `x${"y".repeat(128)}` }),
      /longer than 128/,
    );
    assert.throws(() => buildReport({ ...base, requestId: "req id" }), /Invalid report request id/);
    // null is the explicit "no dispatch" value, not an invalid id.
    assert.equal(buildReport({ ...base, requestId: null }).request_id, null);
  });

  it("rejects an event id that is not a UUID", () => {
    const base = {
      app: "vscode",
      runId: 42,
      runAttempt: 1,
      phase: "succeeded",
      stage: "publish",
      message: "done",
    } as const;
    for (const eventId of ["42:1:vscode", "", "3f2504e0-4f89-41d3-9a0c-0305e82c330", "NOT-A-UUID"]) {
      assert.throws(() => buildReport({ ...base, eventId }), /Invalid report event id/);
    }
  });

  it("pins the record's documented top-level keys", () => {
    // The record is the API's contract: a new field must land in the
    // documented set (and the API's parser) with it, not drift in silently.
    const documented = [
      "event_id",
      "request_id",
      "app",
      "phase",
      "reason",
      "run_id",
      "run_attempt",
      "stage",
      "code",
      "class",
      "retryable",
      "retry_after_seconds",
      "message",
      "resolved_version",
      "cask_version",
      "feed_version",
      "evidence",
      "finished_at",
    ];
    const failed = buildReport({
      app: "vscode",
      runId: 42,
      runAttempt: 2,
      phase: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      message: "boom",
      requestId: "req-01J0Z6B8Y4",
      eventId: EVENT_ID,
      evidence: { http_status: "503" },
    });
    // `reason` is skip-only, so a failed record does not carry it.
    assert.deepEqual(
      Object.keys(failed).sort(),
      documented.filter((key) => key !== "reason").sort(),
    );

    const skipped = buildReport({
      app: "vscode",
      runId: 42,
      runAttempt: 1,
      phase: "skipped",
      stage: "detect",
      reason: "not-ready",
      message: "not-ready: upstream publishes 1.0.0; requested 1.1.0",
      eventId: EVENT_ID,
    });
    const optionalKeys = new Set([
      "code",
      "class",
      "retryable",
      "retry_after_seconds",
      "evidence",
    ]);
    assert.deepEqual(
      Object.keys(skipped).sort(),
      documented.filter((key) => !optionalKeys.has(key)).sort(),
    );
  });

  it("rejects a failure with no code and a success with one", () => {
    assert.throws(() =>
      buildReport({
        app: "vscode",
        runId: 1,
        runAttempt: 1,
        phase: "failed",
        stage: "build",
        message: "boom",
        eventId: EVENT_ID,
      }),
    );
    assert.throws(() =>
      buildReport({
        app: "vscode",
        runId: 1,
        runAttempt: 1,
        phase: "succeeded",
        stage: "build",
        code: "BUILD_FAILED",
        message: "done",
        eventId: EVENT_ID,
      }),
    );
  });

  it("rejects an insane app, run id, attempt, stage and multi-line message", () => {
    const base = {
      runId: 1,
      runAttempt: 1,
      phase: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      eventId: EVENT_ID,
    } as const;
    assert.throws(() => buildReport({ ...base, app: "../etc", message: "x" }));
    assert.throws(() => buildReport({ ...base, app: "vscode", runId: 0, message: "x" }));
    assert.throws(() => buildReport({ ...base, app: "vscode", runAttempt: 0, message: "x" }));
    assert.throws(() =>
      buildReport({ ...base, app: "vscode", stage: "nope" as never, message: "x" }),
    );
    assert.throws(() => buildReport({ ...base, app: "vscode", message: "two\nlines" }));
  });

  it("accepts the API's app ids and rejects everything else", () => {
    // The record's `app` is exactly what the API validates on POST, so the
    // descriptor's shape must hold here too — a manual run can pass any string.
    const base = {
      runId: 1,
      runAttempt: 1,
      phase: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      message: "x",
      eventId: EVENT_ID,
    } as const;
    for (const app of listApps()) {
      assert.equal(buildReport({ ...base, app }).app, app);
    }
    for (const app of ["VSCode", "opencode_desktop", "a.b", "a".repeat(65)]) {
      assert.throws(() => buildReport({ ...base, app }), /Invalid report app/);
    }
  });

  it("emits evidence only when the caller supplied some", () => {
    const bare = buildReport({
      app: "vscode",
      runId: 1,
      runAttempt: 1,
      phase: "failed",
      stage: "detect",
      code: "UPSTREAM_UNAVAILABLE",
      message: "boom",
      eventId: EVENT_ID,
    });
    assert.equal(bare.evidence, undefined);

    const withEvidence = buildReport({
      app: "vscode",
      runId: 1,
      runAttempt: 1,
      phase: "failed",
      stage: "detect",
      code: "UPSTREAM_UNAVAILABLE",
      message: "boom",
      eventId: EVENT_ID,
      evidence: { http_status: "503" },
      finishedAt: new Date("2026-09-25T00:00:00Z"),
    });
    assert.deepEqual(withEvidence.evidence, { http_status: "503" });
    assert.equal(withEvidence.finished_at, "2026-09-25T00:00:00.000Z");
  });

  it("caps evidence at the API's value and record bounds", () => {
    const base = {
      app: "vscode",
      runId: 1,
      runAttempt: 1,
      phase: "failed",
      stage: "detect",
      code: "UPSTREAM_UNAVAILABLE",
      message: "boom",
      eventId: EVENT_ID,
    } as const;

    // Today's emitters fit both bounds.
    const transport = buildReport({
      ...base,
      evidence: { http_status: "429", rate_limited: "true", retry_after_seconds: "60" },
    });
    assert.deepEqual(transport.evidence, {
      http_status: "429",
      rate_limited: "true",
      retry_after_seconds: "60",
    });
    const reason = buildReport({ ...base, evidence: { reason: "upstream said no" } });
    assert.deepEqual(reason.evidence, { reason: "upstream said no" });

    // A single value over the API's 256-byte string cap fails at the site.
    assert.throws(
      () => buildReport({ ...base, evidence: { reason: "x".repeat(5 * 1024) } }),
      /caps an evidence value at 256/,
    );
    // The bound is bytes, not characters: 129 two-byte characters are over it.
    assert.throws(
      () => buildReport({ ...base, evidence: { reason: "é".repeat(129) } }),
      /caps an evidence value at 256/,
    );
    // Each value under the cap, but the serialized map over 4096 bytes.
    const wide: Record<string, string> = {};
    for (let index = 0; index < 20; index++) wide[`detail_${index}`] = "x".repeat(250);
    assert.ok(JSON.stringify(wide).length > 4096, "fixture must exceed the record bound");
    assert.throws(() => buildReport({ ...base, evidence: wide }), /caps it at 4096/);
  });

  it("clamps an over-long message and caps the version strings at 256 bytes", () => {
    const base = {
      app: "vscode",
      runId: 1,
      runAttempt: 1,
      phase: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      eventId: EVENT_ID,
    } as const;
    // A message at the bound stays whole; over it, the clamp cuts on a code
    // point boundary and marks the cut instead of failing the record.
    assert.equal(
      buildReport({ ...base, message: "x".repeat(2048) }).message,
      "x".repeat(2048),
    );
    const ascii = buildReport({ ...base, message: "x".repeat(2049) }).message;
    assert.ok(Buffer.byteLength(ascii, "utf8") <= 2048);
    assert.match(ascii, /^x+\.\.\. \[truncated\]$/);
    // The cut may land inside a multi-byte character; it must stay valid text.
    const wide = buildReport({ ...base, message: "é".repeat(1025) }).message;
    assert.ok(Buffer.byteLength(wide, "utf8") <= 2048);
    assert.match(wide, /^é+\.\.\. \[truncated\]$/);
    assert.doesNotMatch(wide, /\uFFFD/);
    assert.throws(
      () => buildReport({ ...base, message: "boom", resolvedVersion: "v".repeat(257) }),
      /caps it at 256/,
    );
  });
});

describe("fbr report command", () => {
  it("writes a classified record and prints the path it wrote", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const result = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "failed",
      "--stage",
      "toolchain",
      "--code",
      "TOOLCHAIN_DOWNLOAD",
      "--message",
      "appimagetool download failed",
      "--run-id",
      "123456",
      "--run-attempt",
      "2",
      "--event-id",
      EVENT_ID,
      "--resolved-version",
      "1.139.0",
      "--cask-version",
      "1.138.0",
      "--feed-version",
      "",
      "--evidence",
      "http_status=503",
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), output);

    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    // The old contract's version field is gone; the phase is the contract.
    assert.equal(record["schema"], undefined);
    assert.equal(record["app"], "vscode");
    assert.equal(record["run_id"], 123456);
    assert.equal(record["run_attempt"], 2);
    assert.equal(record["event_id"], EVENT_ID);
    assert.equal(record["stage"], "toolchain");
    assert.equal(record["phase"], "failed");
    assert.equal(record["code"], "TOOLCHAIN_DOWNLOAD");
    assert.equal(record["class"], "transient");
    assert.equal(record["retryable"], true);
    assert.equal(record["retry_after_seconds"], null);
    assert.equal(record["resolved_version"], "1.139.0");
    // The cask pin is the API's truth and must survive the round trip.
    assert.equal(record["cask_version"], "1.138.0");
    // An empty flag value means "unknown", not the empty string.
    assert.equal(record["feed_version"], null);
    assert.deepEqual(record["evidence"], { http_status: "503" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a skip record with no code", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const result = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--message",
      "not-ready: upstream publishes 1.0.0; requested 1.1.0",
      "--run-id",
      "1",
      "--run-attempt",
      "1",
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["phase"], "skipped");
    assert.equal(record["code"], undefined);
    assert.equal(record["class"], undefined);
    // No detect output means "unknown", never a stale or empty string.
    assert.equal(record["cask_version"], null);
    // A report with no explicit id gets a fresh UUID.
    assert.match(String(record["event_id"]), UUID_PATTERN);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the typed not-ready reason for a skip", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const result = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--reason",
      "not-ready",
      "--message",
      "not-ready: upstream publishes 1.0.0; requested 1.1.0",
      "--run-id",
      "1",
      "--run-attempt",
      "1",
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["phase"], "skipped");
    assert.equal(record["reason"], "not-ready");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("copies --request-id and --event-id into the record", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const result = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "succeeded",
      "--stage",
      "publish",
      "--message",
      "run completed",
      "--run-id",
      "123456",
      "--run-attempt",
      "2",
      "--request-id",
      "req-01J0Z6B8Y4",
      "--event-id",
      EVENT_ID,
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["request_id"], "req-01J0Z6B8Y4");
    assert.equal(record["event_id"], EVENT_ID);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a public copy with request_id redacted", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const publicOutput = path.join(dir, "report-public.json");
    const result = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "succeeded",
      "--stage",
      "publish",
      "--message",
      "run completed",
      "--run-id",
      "123456",
      "--run-attempt",
      "1",
      "--request-id",
      "req-01J0Z6B8Y4",
      "--event-id",
      EVENT_ID,
      "--public-output",
      publicOutput,
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["request_id"], "req-01J0Z6B8Y4");
    const publicRecord = JSON.parse(fs.readFileSync(publicOutput, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(publicRecord["request_id"], null);
    assert.equal(publicRecord["event_id"], EVENT_ID);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a public output that would overwrite the delivered record", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const result = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--message",
      "already at upstream",
      "--run-id",
      "1",
      "--run-attempt",
      "1",
      "--output",
      output,
      "--public-output",
      output,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--public-output must differ from --output/);
    assert.equal(fs.existsSync(output), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats an empty --request-id as absent and mints an event id when omitted", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const result = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--message",
      "already at upstream",
      "--run-id",
      "1",
      "--run-attempt",
      "1",
      "--request-id",
      "",
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["request_id"], null);
    assert.match(String(record["event_id"]), UUID_PATTERN);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses records the API could not act on", () => {
    const output = path.join(tempDir(), "report.json");
    const base = [
      "report",
      "--app",
      "vscode",
      "--message",
      "boom",
      "--run-id",
      "1",
      "--run-attempt",
      "1",
      "--output",
      output,
    ];

    const noCode = fbr([...base, "--phase", "failed", "--stage", "detect"]);
    assert.equal(noCode.status, 2);
    assert.match(noCode.stderr, /needs --code/);

    const unknownCode = fbr([
      ...base,
      "--phase",
      "failed",
      "--stage",
      "detect",
      "--code",
      "FLAKE",
    ]);
    assert.equal(unknownCode.status, 2);
    assert.match(unknownCode.stderr, /--code must be one of/);

    const codeOnSuccess = fbr([
      ...base,
      "--phase",
      "succeeded",
      "--stage",
      "detect",
      "--code",
      "BUILD_FAILED",
    ]);
    assert.equal(codeOnSuccess.status, 2);
    assert.match(codeOnSuccess.stderr, /carries no --code/);

    const reasonOnFailure = fbr([
      ...base,
      "--phase",
      "failed",
      "--stage",
      "detect",
      "--code",
      "BUILD_FAILED",
      "--reason",
      "not-ready",
    ]);
    assert.equal(reasonOnFailure.status, 2);
    assert.match(reasonOnFailure.stderr, /carries no --reason/);

    const unknownReason = fbr([
      ...base,
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--reason",
      "maybe",
    ]);
    assert.equal(unknownReason.status, 2);
    assert.match(unknownReason.stderr, /--reason must be one of/);

    const badPhase = fbr([...base, "--phase", "success", "--stage", "detect"]);
    assert.equal(badPhase.status, 2);
    assert.match(badPhase.stderr, /--phase must be one of/);

    const badStage = fbr([...base, "--phase", "skipped", "--stage", "teleport"]);
    assert.equal(badStage.status, 2);
    assert.match(badStage.stderr, /--stage must be one of/);

    const badRunId = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--message",
      "boom",
      "--run-id",
      "latest",
      "--run-attempt",
      "1",
      "--output",
      output,
    ]);
    assert.equal(badRunId.status, 2);
    assert.match(badRunId.stderr, /--run-id must be a positive run number/);

    const badAttempt = fbr([
      "report",
      "--app",
      "vscode",
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--message",
      "boom",
      "--run-id",
      "1",
      "--run-attempt",
      "0",
      "--output",
      output,
    ]);
    assert.equal(badAttempt.status, 2);
    assert.match(badAttempt.stderr, /--run-attempt must be a positive attempt number/);

    const duplicateEvidence = fbr([
      ...base,
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--evidence",
      "attempts=1",
      "--evidence",
      "attempts=2",
    ]);
    assert.equal(duplicateEvidence.status, 2);
    assert.match(duplicateEvidence.stderr, /Duplicate --evidence key/);

    const badRequestId = fbr([
      ...base,
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--request-id",
      "req id",
    ]);
    assert.equal(badRequestId.status, 1);
    assert.match(badRequestId.stderr, /Invalid report request id/);

    const badEventId = fbr([
      ...base,
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--event-id",
      "not-a-uuid",
    ]);
    assert.equal(badEventId.status, 1);
    assert.match(badEventId.stderr, /Invalid report event id/);

    const oversizedEvidence = fbr([
      ...base,
      "--phase",
      "failed",
      "--stage",
      "detect",
      "--code",
      "UPSTREAM_UNAVAILABLE",
      "--evidence",
      `reason=${"x".repeat(5 * 1024)}`,
    ]);
    assert.equal(oversizedEvidence.status, 1);
    assert.match(oversizedEvidence.stderr, /caps an evidence value at 256/);

    const unsafeApp = fbr([
      "report",
      "--app",
      "VSCode",
      "--phase",
      "skipped",
      "--stage",
      "detect",
      "--message",
      "x",
      "--run-id",
      "1",
      "--run-attempt",
      "1",
      "--output",
      output,
    ]);
    assert.equal(unsafeApp.status, 1);
    assert.match(unsafeApp.stderr, /Invalid report app/);

    fs.rmSync(path.dirname(output), { recursive: true, force: true });
  });
});

describe("failure fragments", () => {
  it("writes the code, the flattened message, the stage and the evidence", () => {
    const dir = tempDir();
    const output = path.join(dir, "report-code.json");
    writeFailureFragment(output, {
      code: "UPSTREAM_UNAVAILABLE",
      message: "line one\nline two",
      stage: "toolchain",
      evidence: { http_status: "503", retry_after_seconds: "30" },
    });
    const fragment = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(fragment["code"], "UPSTREAM_UNAVAILABLE");
    assert.equal(fragment["stage"], "toolchain");
    assert.equal(fragment["message"], "line one line two");
    assert.deepEqual(fragment["evidence"], { http_status: "503", retry_after_seconds: "30" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("omits stage and evidence unless the site supplied them", () => {
    const dir = tempDir();
    const output = path.join(dir, "report-code.json");
    writeFailureFragment(output, { code: "BUILD_FAILED", message: "boom" });
    const fragment = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(fragment["stage"], undefined);
    assert.equal(fragment["evidence"], undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a fragment the report job could not merge", () => {
    const output = path.join(tempDir(), "report-code.json");
    // The report job copies evidence through `fbr report --evidence`, so a key
    // that fails there must fail at the site, not silently cost the record.
    assert.throws(
      () =>
        writeFailureFragment(output, {
          code: "BUILD_FAILED",
          message: "boom",
          evidence: { "HTTP-Status": "503" },
        }),
      /not snake_case/,
    );
    assert.throws(
      () =>
        writeFailureFragment(output, {
          code: "BUILD_FAILED",
          message: "boom",
          evidence: { retry_after: "30\n60" },
        }),
      /single line/,
    );
    // The per-value cap is mirrored here so a fragment fails at its site, not
    // when the report job merges it.
    assert.throws(
      () =>
        writeFailureFragment(output, {
          code: "UPSTREAM_UNAVAILABLE",
          message: "boom",
          evidence: { reason: "x".repeat(5 * 1024) },
        }),
      /caps an evidence value at 256/,
    );
    assert.throws(
      () =>
        writeFailureFragment(output, {
          code: "BUILD_FAILED",
          message: "boom",
          stage: "teleport" as never,
        }),
      /Unknown fragment stage/,
    );
    assert.equal(fs.existsSync(output), false);
  });

  it("clamps an over-long message rather than failing the site", () => {
    const dir = tempDir();
    const output = path.join(dir, "report-code.json");
    // A long error must not fail the writer: that would mask the classified
    // exit and cost the report job the fragment.
    writeFailureFragment(output, { code: "BUILD_FAILED", message: "x".repeat(2049) });
    const fragment = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    const message = fragment["message"] as string;
    assert.ok(Buffer.byteLength(message, "utf8") <= 2048);
    assert.match(message, /^x+\.\.\. \[truncated\]$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("workflow failure sites", () => {
  // Every file that can emit a verdict: the workflows (fragment literals,
  // --code flags, the report job's fallback arms), the CLI's classification of
  // typed failures, and the shell pipeline's classify_failure calls. The
  // contract module itself and the tests are excluded: they name codes without
  // emitting anything.
  function emittingSources(): Array<{ file: string; text: string }> {
    const roots = [
      path.join(REPO_ROOT, ".github"),
      path.join(REPO_ROOT, "packaging", "lib"),
      path.join(REPO_ROOT, "packaging", "bin"),
    ];
    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        if (!/\.(yml|ts|sh)$/.test(entry.name)) continue;
        if (full.endsWith(path.join("pipeline", "report.ts"))) continue;
        files.push(full);
      }
    };
    for (const root of roots) visit(root);
    return files.map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
  }

  const sources = emittingSources();
  const combined = sources.map((source) => source.text).join("\n");

  function captured(pattern: RegExp, files = sources): string[] {
    const found: string[] = [];
    for (const source of files) {
      for (const match of source.text.matchAll(pattern)) {
        const token = match[1];
        assert.ok(token !== undefined, `pattern ${String(pattern)} produced no capture`);
        found.push(token);
      }
    }
    return found;
  }

  it("writes only failure codes and stages the record contract knows", () => {
    // Three shapes write a code: a fragment literal, the `--code` flag, and the
    // report job's shell case arms. A stage comes from a fragment when the
    // failing site knows it better than the job.
    const codes = [
      ...captured(/"code":"([A-Z_]+)"/g),
      ...captured(/--code\s+([A-Z_]+)(?![A-Za-z0-9_])/g),
      ...captured(/\bcode="([A-Z_]+)"/g),
    ];
    assert.ok(codes.length > 0, "expected classified failure sites");
    for (const code of codes) {
      assert.ok(code in FAILURE_CODES, `writes unknown failure code ${code}`);
    }

    // A site names its stage in a fragment when it knows it better than the job
    // (a toolchain download inside a build), or in a workflow's `--stage` flag
    // when the site is the whole job (the plan job). The flag is only read out of
    // the workflows: the CLI's own usage strings mention it too.
    const workflows = sources.filter((source) =>
      source.file.startsWith(path.join(REPO_ROOT, ".github")),
    );
    const stages = [
      ...captured(/"stage":"([a-z-]+)"/g),
      ...captured(/--stage\s+([a-z][a-z-]*)(?![A-Za-z0-9_-])/g, workflows),
    ];
    assert.ok(stages.length > 0, "expected fragment stages");
    for (const stage of stages) {
      assert.ok(
        (REPORT_STAGES as readonly string[]).includes(stage),
        `writes unknown stage ${stage}`,
      );
    }
    for (const expected of ["plan", "toolchain"] as const) {
      assert.ok(stages.includes(expected), `no failure site reports the ${expected} stage`);
    }
  });

  it("emits every code the contract declares, so none is a promise without a site", () => {
    // Membership in the table is only useful to the API if something can
    // actually produce it; a declared-but-unreachable code would silently make
    // the API's verdict handling dead code.
    const tokens = new Set(combined.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []);
    const missing = Object.keys(FAILURE_CODES).filter((code) => !tokens.has(code));
    assert.deepEqual(missing, [], `failure codes nothing can emit: ${missing.join(", ")}`);
  });

  it("keeps app names from absorbing each other's fragment artifacts", () => {
    // Fragments are named report-code-<app>-<stage>, fetched with the glob
    // report-code-<app>-*: an app named "<other>-<suffix>" would match the
    // other app's artifacts and merge the wrong verdict into its record.
    const apps = listApps();
    for (const app of apps) {
      for (const other of apps) {
        if (other === app) continue;
        assert.ok(
          !other.startsWith(`${app}-`),
          `${other} would match the fragment pattern of ${app}; rename one of them`,
        );
      }
    }
  });
});

describe("record delivery", () => {
  // Delivery lives in one shared composite action now: the API takes a fresh
  // OIDC token per attempt (one body per token), and the response matrix is the
  // new contract. The callers only point it at the written record.
  const ACTION = path.join(REPO_ROOT, ".github", "actions", "deliver-report", "action.yml");
  const action = fs.readFileSync(ACTION, "utf8");

  // A workflow step's body: from `- name:` to the next less-indented line.
  function step(file: string, name: string): string {
    const lines = fs.readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
    const start = lines.findIndex((line) => line.includes(`- name: ${name}`));
    assert.ok(start >= 0, `${file} has no "${name}" step`);
    const body: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (index < start) continue;
      // A list item at the step indentation or a less-indented job key ends it.
      if (index > start && /^ {0,6}\S/.test(line)) break;
      body.push(line);
    }
    return body.join("\n");
  }

  it("fetches a fresh OIDC token inside the retry loop", () => {
    const loop = action.indexOf("for attempt in 1 2 3");
    const token = action.indexOf("audience=api.edgarcnp.dev");
    assert.ok(loop >= 0, "no retry loop");
    assert.ok(token > loop, "the token must be fetched after the loop starts, per attempt");
    assert.match(action, /ACTIONS_ID_TOKEN_REQUEST_URL/);
    assert.match(action, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
    // The default workflow shell traces commands; xtrace must be off before the
    // first read of the token.
    const traceOff = action.indexOf("set +x");
    assert.ok(traceOff >= 0 && traceOff < token, "the action traces the OIDC token");
  });

  it("re-sends the same body — and so the same event_id — on every attempt", () => {
    assert.match(action, /--data-binary "@\$\{REPORT_BODY\}"/);
    assert.match(action, /REPORT_BODY: \$\{\{ inputs\.body \}\}/);
    assert.match(action, /https:\/\/api\.edgarcnp\.dev\/v1\/homebrew\/tap\/events/);
    assert.match(action, /Content-Type: application\/json/);
    assert.match(action, /Authorization: Bearer \$\{id_token\}/);
  });

  it("retries 429 and 5xx but treats 401 and 413/415/422 as permanent", () => {
    assert.match(action, /for attempt in 1 2 3/);
    assert.match(action, /--dump-header/);
    assert.match(action, /retry-after/i);
    // A hostile or broken Retry-After must not stall the job.
    assert.match(action, /retry_after > 120/);
    const throttled = action.indexOf("429)");
    const auth = action.indexOf("401)");
    const permanent = action.indexOf("4??)");
    assert.ok(auth >= 0, "401 needs its own case arm");
    assert.ok(throttled >= 0, "429 needs its own case arm");
    assert.ok(permanent > throttled, "the 429 arm must precede the 4xx arm");
    assert.match(action, /401\)[\s\S]*?not retrying/);
    assert.match(action, /413\|415\|422/);
    assert.match(action, /4\?\?\)\n\s+echo "::warning::API rejected the run report/);
  });

  it("keeps every delivery call best-effort and pointed at a written record", () => {
    for (const [file, name, body] of [
      [".github/workflows/build.yml", "Deliver the accepted report to the API", "accepted-report.json"],
      [".github/workflows/build.yml", "Deliver the run record to the API", "run-report.json"],
      [".github/workflows/build-appimage.yml", "Deliver the run record to the API", "run-report.json"],
    ] as const) {
      const text = step(file, name);
      assert.match(text, /continue-on-error: true/);
      assert.match(text, /uses: \.\/\.github\/actions\/deliver-report/);
      assert.match(text, new RegExp(`body: \\$\\{\\{ runner\\.temp \\}\\}/${body.replace(".", "\\.")}`));
    }
  });

  it("keeps request_id out of the public artifact and the logs", () => {
    // The write steps handle the dispatch correlation id, so xtrace must be
    // off before it is first touched.
    for (const [file, name] of [
      [".github/workflows/build.yml", "Report accepted"],
      [".github/workflows/build.yml", "Write the run record"],
      [".github/workflows/build-appimage.yml", "Write the run record"],
    ] as const) {
      const write = step(file, name);
      const traceOff = write.indexOf("set +x");
      const correlation = write.indexOf("--request-id");
      assert.ok(traceOff >= 0, `${file} ${name} never disables xtrace`);
      assert.ok(traceOff < correlation, `${file} ${name} traces request_id before disabling xtrace`);
      // The API must keep receiving the actual correlation id.
      assert.match(write, /--request-id "\$\{REQUEST_ID\}"/);
    }
    const build = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/build.yml"), "utf8");
    const appimage = fs.readFileSync(
      path.join(REPO_ROOT, ".github/workflows/build-appimage.yml"),
      "utf8",
    );
    // The uploaded copy is the redacted one; delivery still reads the full
    // record from run-report.json.
    assert.match(build, /--public-output "\$\{RUNNER_TEMP\}\/run-report-public\.json"/);
    assert.match(build, /--output "\$\{RUNNER_TEMP\}\/run-report\.json"/);
    assert.match(appimage, /--public-output "\$\{RUNNER_TEMP\}\/run-report-public\.json"/);
    assert.match(appimage, /--output "\$\{RUNNER_TEMP\}\/run-report\.json"/);
    // No artifact may point at the full record.
    assert.doesNotMatch(build, /path:.*run-report\.json/);
    assert.doesNotMatch(appimage, /path:.*run-report\.json/);
    assert.match(build, /path: \$\{\{ runner\.temp \}\}\/run-report-public\.json/);
    assert.match(appimage, /path: \$\{\{ runner\.temp \}\}\/run-report-public\.json/);
  });

  it("classifies only requests the API could record as app ids", () => {
    // The plan job's fragment gate decides whether a bogus app name gets
    // UNKNOWN_APP; it must agree with the record guard, or it writes a code
    // that can never become a record.
    const plan = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "build.yml"), "utf8");
    assert.ok(
      plan.includes(APP_ID.source),
      `the plan job's fragment gate must use the API's app-id shape (${APP_ID.source})`,
    );
  });
});
