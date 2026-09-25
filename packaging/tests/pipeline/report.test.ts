import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";
import {
  buildReport,
  FAILURE_CODES,
  REPORT_SCHEMA,
  type FailureCode,
  type FailureCodeSpec,
} from "../../lib/pipeline/report.ts";

const FBR = path.join(REPO_ROOT, "packaging", "bin", "fbr.ts");

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
        status: "failed",
        stage: "detect",
        code,
        message: `boom: ${code}`,
      });
      const spec: FailureCodeSpec = FAILURE_CODES[code];
      assert.equal(report.schema, REPORT_SCHEMA);
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
      status: "skipped",
      stage: "detect",
      message: "already up to date",
      resolvedVersion: "1.0.0",
      feedVersion: null,
    });
    assert.equal(report.code, undefined);
    assert.equal(report.class, undefined);
    assert.equal(report.retryable, undefined);
    assert.equal(report.retry_after_seconds, null);
    assert.equal(report.resolved_version, "1.0.0");
    assert.equal(report.feed_version, null);
  });

  it("rejects a failure with no code and a success with one", () => {
    assert.throws(() =>
      buildReport({ app: "vscode", runId: 1, status: "failed", stage: "build", message: "boom" }),
    );
    assert.throws(() =>
      buildReport({
        app: "vscode",
        runId: 1,
        status: "success",
        stage: "build",
        code: "BUILD_FAILED",
        message: "done",
      }),
    );
  });

  it("rejects an insane app, run id, stage and multi-line message", () => {
    const base = { runId: 1, status: "failed", stage: "build", code: "BUILD_FAILED" } as const;
    assert.throws(() => buildReport({ ...base, app: "../etc", message: "x" }));
    assert.throws(() => buildReport({ ...base, app: "vscode", runId: 0, message: "x" }));
    assert.throws(() =>
      buildReport({ ...base, app: "vscode", stage: "nope" as never, message: "x" }),
    );
    assert.throws(() => buildReport({ ...base, app: "vscode", message: "two\nlines" }));
  });

  it("emits evidence only when the caller supplied some", () => {
    const bare = buildReport({
      app: "vscode",
      runId: 1,
      status: "failed",
      stage: "detect",
      code: "UPSTREAM_UNAVAILABLE",
      message: "boom",
    });
    assert.equal(bare.evidence, undefined);

    const withEvidence = buildReport({
      app: "vscode",
      runId: 1,
      status: "failed",
      stage: "detect",
      code: "UPSTREAM_UNAVAILABLE",
      message: "boom",
      evidence: { http_status: "503" },
      finishedAt: new Date("2026-09-25T00:00:00Z"),
    });
    assert.deepEqual(withEvidence.evidence, { http_status: "503" });
    assert.equal(withEvidence.finished_at, "2026-09-25T00:00:00.000Z");
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
      "--stage",
      "toolchain",
      "--status",
      "failed",
      "--code",
      "TOOLCHAIN_DOWNLOAD",
      "--message",
      "appimagetool download failed",
      "--run-id",
      "123456",
      "--resolved-version",
      "1.139.0",
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
    assert.equal(record["schema"], 1);
    assert.equal(record["app"], "vscode");
    assert.equal(record["run_id"], 123456);
    assert.equal(record["stage"], "toolchain");
    assert.equal(record["status"], "failed");
    assert.equal(record["code"], "TOOLCHAIN_DOWNLOAD");
    assert.equal(record["class"], "transient");
    assert.equal(record["retryable"], true);
    assert.equal(record["retry_after_seconds"], null);
    assert.equal(record["resolved_version"], "1.139.0");
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
      "--stage",
      "detect",
      "--status",
      "skipped",
      "--message",
      "already at upstream",
      "--run-id",
      "1",
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["status"], "skipped");
    assert.equal(record["code"], undefined);
    assert.equal(record["class"], undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses records the API could not act on", () => {
    const output = path.join(tempDir(), "report.json");
    const base = ["report", "--app", "vscode", "--message", "boom", "--output", output];

    const noCode = fbr([...base, "--stage", "detect", "--status", "failed"]);
    assert.equal(noCode.status, 2);
    assert.match(noCode.stderr, /needs --code/);

    const unknownCode = fbr([...base, "--stage", "detect", "--status", "failed", "--code", "FLAKE"]);
    assert.equal(unknownCode.status, 2);
    assert.match(unknownCode.stderr, /--code must be one of/);

    const codeOnSuccess = fbr([
      ...base,
      "--stage",
      "detect",
      "--status",
      "success",
      "--code",
      "BUILD_FAILED",
    ]);
    assert.equal(codeOnSuccess.status, 2);
    assert.match(codeOnSuccess.stderr, /carries no --code/);

    const badStage = fbr([...base, "--stage", "teleport", "--status", "skipped", "--run-id", "1"]);
    assert.equal(badStage.status, 2);
    assert.match(badStage.stderr, /--stage must be one of/);

    const badRunId = fbr([...base, "--stage", "detect", "--status", "skipped", "--run-id", "latest"]);
    assert.equal(badRunId.status, 2);
    assert.match(badRunId.stderr, /--run-id must be a positive run number/);

    const duplicateEvidence = fbr([
      ...base,
      "--stage",
      "detect",
      "--status",
      "skipped",
      "--run-id",
      "1",
      "--evidence",
      "attempts=1",
      "--evidence",
      "attempts=2",
    ]);
    assert.equal(duplicateEvidence.status, 2);
    assert.match(duplicateEvidence.stderr, /Duplicate --evidence key/);

    fs.rmSync(path.dirname(output), { recursive: true, force: true });
  });
});
