import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { GuardViolationError, UpstreamUnavailableError } from "../../lib/core/errors.ts";
import {
  MAX_PAYLOAD_BYTES,
  digestMatchesHex,
  fetchOnce,
  httpFailure,
  readPayload,
  sha256Digest,
  sha256Hex,
  writeFileAtomic,
} from "../../lib/core/http.ts";

let server: http.Server;
let baseUrl: string;
const requests: string[] = [];
let delayMs = 0;

function handler(request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = request.url ?? "/";
  requests.push(url);
  const respond = (): void => {
    switch (url) {
      case "/flaky": {
        const count = requests.filter((entry) => entry === "/flaky").length;
        if (count < 2) {
          response.writeHead(500).end("boom");
          return;
        }
        response.writeHead(200).end("ok");
        return;
      }
      case "/throttled":
        response.writeHead(429, { "retry-after": "0" }).end("slow down");
        return;
      case "/missing":
        response.writeHead(404).end("nope");
        return;
      case "/empty":
        response.writeHead(204).end();
        return;
      default:
        response.writeHead(200, { "content-type": "text/plain" }).end("payload");
    }
  };
  if (delayMs > 0) {
    setTimeout(respond, delayMs);
    return;
  }
  respond();
}

before(async () => {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchOnce", () => {
  it("makes a single attempt against a 5xx", async () => {
    requests.length = 0;
    const response = await fetchOnce(`${baseUrl}/flaky`);
    assert.equal(response.status, 500);
    assert.equal(requests.length, 1);
  });

  it("makes a single attempt against a 429", async () => {
    requests.length = 0;
    const response = await fetchOnce(`${baseUrl}/throttled`);
    assert.equal(response.status, 429);
    assert.equal(requests.length, 1);
  });

  it("does not retry a 404", async () => {
    requests.length = 0;
    const response = await fetchOnce(`${baseUrl}/missing`);
    assert.equal(response.status, 404);
    assert.equal(requests.length, 1);
  });

  it("aborts on timeout", async () => {
    requests.length = 0;
    delayMs = 300;
    try {
      await assert.rejects(fetchOnce(`${baseUrl}/empty`, { timeoutMs: 30 }), (error: unknown) => {
        // Classified, not just thrown: the API's budget needs to know this was
        // the transport giving up rather than a bad response.
        assert.ok(error instanceof UpstreamUnavailableError);
        assert.equal(error.evidence["reason"], "timeout");
        return true;
      });
      assert.equal(requests.length, 1);
    } finally {
      delayMs = 0;
    }
  });
});

describe("httpFailure", () => {
  it("classifies 429 and 5xx as transient, keeping the retry hint", () => {
    const throttled = httpFailure(
      new Response("", { status: 429, headers: { "retry-after": "30" } }),
      "boom (429)",
    );
    assert.ok(throttled instanceof UpstreamUnavailableError);
    assert.deepEqual(throttled.evidence, { http_status: "429", retry_after_seconds: "30" });

    const unavailable = httpFailure(new Response("", { status: 503 }), "boom (503)");
    assert.ok(unavailable instanceof UpstreamUnavailableError);
    assert.deepEqual(unavailable.evidence, { http_status: "503" });
  });

  it("classifies a 403 retry hint as transient even without a zeroed count", () => {
    const secondary = httpFailure(
      new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "12", "retry-after": "20" },
      }),
      "boom (403)",
    );
    assert.ok(secondary instanceof UpstreamUnavailableError);
    assert.equal(secondary.evidence["rate_limited"], "true");
    assert.equal(secondary.evidence["retry_after_seconds"], "20");
  });

  it("classifies a rate-limited GitHub 403 as transient", () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    const limited = httpFailure(
      new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
      "boom (403)",
    );
    assert.ok(limited instanceof UpstreamUnavailableError);
    assert.equal(limited.evidence["http_status"], "403");
    assert.equal(limited.evidence["rate_limited"], "true");
    const seconds = Number(limited.evidence["retry_after_seconds"]);
    assert.ok(seconds > 0 && seconds <= 60, `unexpected retry hint ${seconds}`);
  });

  it("leaves a plain 4xx unclassified", () => {
    // A 404 is a descriptor problem, not a busy upstream: dressing it up as
    // transient would invite a re-dispatch that cannot succeed.
    const missing = httpFailure(new Response("", { status: 404 }), "boom (404)");
    assert.equal(missing instanceof UpstreamUnavailableError, false);
    assert.equal(missing.message, "boom (404)");
  });
});

describe("readPayload", () => {
  it("reads a small body", async () => {
    const response = await fetchOnce(`${baseUrl}/small`);
    assert.equal((await readPayload(response)).toString(), "payload");
  });

  it("caps oversized bodies", async () => {
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from("0123456789"));
          controller.close();
        },
      }),
    );
    await assert.rejects(readPayload(oversized, 4), (error: unknown) => {
      // A payload over the cap is a guard violation: permanent, so the record
      // does not offer the API a retry.
      assert.ok(error instanceof GuardViolationError);
      assert.match(error.message, /size cap/);
      return true;
    });
    assert.equal(MAX_PAYLOAD_BYTES, 512 * 1024 * 1024);
  });
});

describe("hashing", () => {
  it("computes stable digests and compares in constant time", () => {
    const bytes = Buffer.from("hello");
    const hex = sha256Hex(bytes);
    assert.equal(hex, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert.equal(digestMatchesHex(hex, sha256Digest(bytes)), true);
    assert.equal(digestMatchesHex("0".repeat(64), sha256Digest(bytes)), false);
    assert.equal(digestMatchesHex("abc", sha256Digest(bytes)), false);
  });
});

describe("writeFileAtomic", () => {
  it("writes the file and leaves no temporary behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-atomic-"));
    try {
      const target = path.join(dir, "out.json");
      writeFileAtomic(target, "{}");
      writeFileAtomic(target, '{"a":1}');
      assert.equal(fs.readFileSync(target, "utf8"), '{"a":1}');
      assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the temporary when the rename fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-atomic-"));
    try {
      // The target is a directory, so renameSync fails after the temp write.
      const target = path.join(dir, "out.json");
      fs.mkdirSync(target);
      assert.throws(() => writeFileAtomic(target, "{}"));
      assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
