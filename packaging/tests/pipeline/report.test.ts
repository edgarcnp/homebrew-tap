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
  REPORT_SCHEMA,
  REPORT_STAGES,
  writeFailureFragment,
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
        eventId: "42:1:vscode",
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
      eventId: "42:1:vscode",
    });
    assert.equal(report.code, undefined);
    assert.equal(report.class, undefined);
    assert.equal(report.retryable, undefined);
    assert.equal(report.retry_after_seconds, null);
    assert.equal(report.resolved_version, "1.0.0");
    assert.equal(report.feed_version, null);
  });

  it("carries the caller's event id and leaves request_id null when none was supplied", () => {
    const report = buildReport({
      app: "vscode",
      runId: 42,
      status: "skipped",
      stage: "detect",
      message: "already up to date",
      eventId: "42:1:vscode",
    });
    assert.equal(report.request_id, null);
    assert.equal(report.event_id, "42:1:vscode");
  });

  it("copies the dispatch correlation id and event id through verbatim", () => {
    const report = buildReport({
      app: "vscode",
      runId: 42,
      status: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      message: "boom",
      requestId: "req-01J0Z6B8Y4",
      eventId: "42:2:vscode",
    });
    assert.equal(report.request_id, "req-01J0Z6B8Y4");
    assert.equal(report.event_id, "42:2:vscode");
  });

  it("rejects correlation ids that are not one safe token", () => {
    const base = {
      app: "vscode",
      runId: 42,
      status: "success",
      stage: "publish",
      message: "done",
      eventId: "42:1:vscode",
    } as const;
    assert.throws(() => buildReport({ ...base, requestId: "two\nlines" }), /newlines or NUL/);
    assert.throws(
      () => buildReport({ ...base, requestId: `x${"y".repeat(128)}` }),
      /longer than 128/,
    );
    assert.throws(() => buildReport({ ...base, requestId: "req id" }), /Invalid report request id/);
    assert.throws(() => buildReport({ ...base, eventId: "42:vscode!" }), /Invalid report event id/);
    assert.throws(() => buildReport({ ...base, eventId: "" }), /Invalid report event id/);
    // null is the explicit "no dispatch" value, not an invalid id.
    assert.equal(buildReport({ ...base, requestId: null }).request_id, null);
  });

  it("pins the record's documented top-level keys", () => {
    // The record is the API's contract: a new field must land in the
    // documented set (and the API's parser) with it, not drift in silently.
    const documented = [
      "schema",
      "event_id",
      "request_id",
      "app",
      "run_id",
      "status",
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
      status: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      message: "boom",
      requestId: "req-01J0Z6B8Y4",
      eventId: "42:2:vscode",
      evidence: { http_status: "503" },
    });
    assert.deepEqual(Object.keys(failed).sort(), [...documented].sort());

    const skipped = buildReport({
      app: "vscode",
      runId: 42,
      status: "skipped",
      stage: "detect",
      message: "already up to date",
      eventId: "42:1:vscode",
    });
    const optionalKeys = new Set(["code", "class", "retryable", "evidence"]);
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
        status: "failed",
        stage: "build",
        message: "boom",
        eventId: "1:1:vscode",
      }),
    );
    assert.throws(() =>
      buildReport({
        app: "vscode",
        runId: 1,
        status: "success",
        stage: "build",
        code: "BUILD_FAILED",
        message: "done",
        eventId: "1:1:vscode",
      }),
    );
  });

  it("rejects an insane app, run id, stage and multi-line message", () => {
    const base = {
      runId: 1,
      status: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      eventId: "1:1:vscode",
    } as const;
    assert.throws(() => buildReport({ ...base, app: "../etc", message: "x" }));
    assert.throws(() => buildReport({ ...base, app: "vscode", runId: 0, message: "x" }));
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
      status: "failed",
      stage: "build",
      code: "BUILD_FAILED",
      message: "x",
      eventId: "1:1:vscode",
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
      status: "failed",
      stage: "detect",
      code: "UPSTREAM_UNAVAILABLE",
      message: "boom",
      eventId: "1:1:vscode",
    });
    assert.equal(bare.evidence, undefined);

    const withEvidence = buildReport({
      app: "vscode",
      runId: 1,
      status: "failed",
      stage: "detect",
      code: "UPSTREAM_UNAVAILABLE",
      message: "boom",
      eventId: "1:1:vscode",
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
      status: "failed",
      stage: "detect",
      code: "UPSTREAM_UNAVAILABLE",
      message: "boom",
      eventId: "1:1:vscode",
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

    // A single value over 1 KiB fails at the site.
    assert.throws(
      () => buildReport({ ...base, evidence: { reason: "x".repeat(5 * 1024) } }),
      /caps an evidence value at 1024/,
    );
    // The bound is bytes, not characters: 513 two-byte characters are over it.
    assert.throws(
      () => buildReport({ ...base, evidence: { reason: "é".repeat(513) } }),
      /caps an evidence value at 1024/,
    );
    // Each value under 1 KiB, but the serialized map over 4096 bytes.
    const wide: Record<string, string> = {};
    for (let index = 0; index < 5; index++) wide[`detail_${index}`] = "x".repeat(1000);
    assert.ok(JSON.stringify(wide).length > 4096, "fixture must exceed the record bound");
    assert.throws(() => buildReport({ ...base, evidence: wide }), /caps it at 4096/);
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
      "--event-id",
      "123456:2:vscode",
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
    assert.equal(record["schema"], 1);
    assert.equal(record["app"], "vscode");
    assert.equal(record["run_id"], 123456);
    assert.equal(record["event_id"], "123456:2:vscode");
    assert.equal(record["stage"], "toolchain");
    assert.equal(record["status"], "failed");
    assert.equal(record["code"], "TOOLCHAIN_DOWNLOAD");
    assert.equal(record["class"], "transient");
    assert.equal(record["retryable"], true);
    assert.equal(record["retry_after_seconds"], null);
    assert.equal(record["resolved_version"], "1.139.0");
    // The cask pin is what lets the API tell a raced publish from a cask that
    // is already ahead; it must survive the round trip.
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
      "--stage",
      "detect",
      "--status",
      "skipped",
      "--message",
      "already at upstream",
      "--run-id",
      "1",
      "--event-id",
      "1:1:vscode",
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["status"], "skipped");
    assert.equal(record["code"], undefined);
    assert.equal(record["class"], undefined);
    // No detect output means "unknown", never a stale or empty string.
    assert.equal(record["cask_version"], null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("copies --request-id and --event-id into the record", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const result = fbr([
      "report",
      "--app",
      "vscode",
      "--stage",
      "publish",
      "--status",
      "success",
      "--message",
      "run completed",
      "--run-id",
      "123456",
      "--request-id",
      "req-01J0Z6B8Y4",
      "--event-id",
      "123456:2:vscode",
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["request_id"], "req-01J0Z6B8Y4");
    assert.equal(record["event_id"], "123456:2:vscode");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats an empty --request-id as absent and keeps the event id explicit", () => {
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
      "--request-id",
      "",
      "--event-id",
      "1:1:vscode",
      "--output",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.equal(record["request_id"], null);
    assert.equal(record["event_id"], "1:1:vscode");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("requires --event-id", () => {
    const dir = tempDir();
    const output = path.join(dir, "report.json");
    const base = [
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
    ];
    for (const args of [base, [...base, "--event-id", ""]]) {
      const result = fbr(args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Missing required flag --event-id/);
    }
    assert.equal(fs.existsSync(output), false);
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
      "--event-id",
      "1:1:vscode",
      "--output",
      output,
    ];

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

    const badRequestId = fbr([
      ...base,
      "--stage",
      "detect",
      "--status",
      "skipped",
      "--run-id",
      "1",
      "--request-id",
      "req id",
    ]);
    assert.equal(badRequestId.status, 1);
    assert.match(badRequestId.stderr, /Invalid report request id/);

    const oversizedEvidence = fbr([
      ...base,
      "--stage",
      "detect",
      "--status",
      "failed",
      "--code",
      "UPSTREAM_UNAVAILABLE",
      "--run-id",
      "1",
      "--evidence",
      `reason=${"x".repeat(5 * 1024)}`,
    ]);
    assert.equal(oversizedEvidence.status, 1);
    assert.match(oversizedEvidence.stderr, /caps an evidence value at 1024/);

    const unsafeApp = fbr([
      "report",
      "--app",
      "VSCode",
      "--stage",
      "detect",
      "--status",
      "skipped",
      "--message",
      "x",
      "--run-id",
      "1",
      "--event-id",
      "1:1:vscode",
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
      /caps an evidence value at 1024/,
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
  // The delivery step is duplicated between the plan job (no record yet) and
  // the per-app report job. Pin it here as one contract — 429 is the rate
  // limiter and retries after Retry-After, every other 4xx stays permanent,
  // three attempts total — and keep the two copies from drifting.
  function deliveryStep(file: string): string {
    const lines = fs.readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
    const start = lines.findIndex((line) => line.includes("- name: Deliver the run record to the API"));
    assert.ok(start >= 0, `${file} has no delivery step`);
    const step: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (index < start) continue;
      // A list item at the step indentation or a less-indented job key ends it.
      if (index > start && /^ {0,6}\S/.test(line)) break;
      step.push(line);
    }
    return step.join("\n");
  }

  const files = [
    path.join(".github", "workflows", "build.yml"),
    path.join(".github", "workflows", "build-appimage.yml"),
  ] as const;
  const [buildStep, appimageStep] = files.map(deliveryStep);

  it("keeps both copies identical apart from their job guard", () => {
    assert.ok(buildStep !== undefined && appimageStep !== undefined);
    // The plan job guards on its report step's `wrote` output, the per-app job
    // on its write step's outcome; everything else must match byte for byte.
    const normalize = (step: string): string => step.replace(/^.*if: always\(\).*$/m, "");
    assert.equal(normalize(buildStep), normalize(appimageStep));
  });

  it("retries a 429 after Retry-After and keeps other 4xx permanent", () => {
    assert.ok(buildStep !== undefined, "no delivery step to inspect");
    const step = buildStep;
    assert.match(step, /continue-on-error: true/);
    assert.match(step, /for attempt in 1 2 3/);
    assert.match(step, /--dump-header/);
    assert.match(step, /retry-after/i);
    // A hostile or broken Retry-After must not stall the job.
    assert.match(step, /retry_after > 120/);
    const throttled = step.indexOf("429)");
    const permanent = step.indexOf("4??)");
    assert.ok(throttled >= 0, "429 needs its own case arm");
    assert.ok(permanent > throttled, "the 429 arm must precede the 4xx arm");
    assert.match(step, /4\?\?\) echo "::warning::API rejected the run record/);
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
