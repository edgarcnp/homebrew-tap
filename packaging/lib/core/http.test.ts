import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  MAX_PAYLOAD_BYTES,
  digestMatchesHex,
  fetchWithRetry,
  readPayload,
  sha256Digest,
  sha256Hex,
  writeFileAtomic,
} from "./http.ts";

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

describe("fetchWithRetry", () => {
  it("retries a 5xx and returns the eventual success", async () => {
    requests.length = 0;
    const response = await fetchWithRetry(`${baseUrl}/flaky`, {}, 3);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(requests.length, 2);
  });

  it("returns the final 429 response instead of throwing", async () => {
    requests.length = 0;
    const response = await fetchWithRetry(`${baseUrl}/throttled`, {}, 2);
    assert.equal(response.status, 429);
    assert.equal(requests.length, 2);
  });

  it("does not retry a 404", async () => {
    requests.length = 0;
    const response = await fetchWithRetry(`${baseUrl}/missing`, {}, 3);
    assert.equal(response.status, 404);
    assert.equal(requests.length, 1);
  });

  it("aborts on timeout without retrying", async () => {
    requests.length = 0;
    delayMs = 300;
    try {
      await assert.rejects(fetchWithRetry(`${baseUrl}/empty`, { timeoutMs: 30 }, 3), /abort|timeout/i);
      assert.equal(requests.length, 1);
    } finally {
      delayMs = 0;
    }
  });
});

describe("readPayload", () => {
  it("reads a small body", async () => {
    const response = await fetchWithRetry(`${baseUrl}/small`);
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
    await assert.rejects(readPayload(oversized, 4), /size cap/);
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
});
