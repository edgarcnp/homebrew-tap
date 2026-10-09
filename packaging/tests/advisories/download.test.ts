// The shared download path's failure classification: a busy upstream is
// transient, a guard trip or a digest mismatch is permanent. The CLI turns the
// classes into the run record's verdict, so getting them backwards would tell
// the API to retry work that cannot succeed (or to give up on work that can).

import assert from "node:assert/strict";
import * as http from "node:http";
import { after, before, describe, it } from "node:test";
import { ChecksumMismatchError, GuardViolationError, UpstreamUnavailableError } from "../../lib/core/errors.ts";
import { sha256Hex, sha512Base64 } from "../../lib/core/http.ts";
import { fetchVerified, verifyPayload } from "../../lib/advisories/download.ts";

let server: http.Server;
let baseUrl: string;

function handler(request: http.IncomingMessage, response: http.ServerResponse): void {
  switch (request.url ?? "/") {
    case "/busy":
      response.writeHead(503).end("nope");
      return;
    default:
      response.writeHead(200, { "content-type": "application/octet-stream" }).end("payload");
  }
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

describe("verifyPayload", () => {
  it("classifies a size or digest mismatch as permanent", () => {
    const bytes = Buffer.from("payload");
    assert.throws(
      () => verifyPayload(bytes, { size: 1 }, "asset"),
      (error: unknown) => {
        assert.ok(error instanceof ChecksumMismatchError);
        assert.match(error.message, /size mismatch/);
        return true;
      },
    );
    assert.throws(
      () => verifyPayload(bytes, { sha256: "0".repeat(64) }, "asset"),
      (error: unknown) => {
        assert.ok(error instanceof ChecksumMismatchError);
        assert.match(error.message, /SHA256 mismatch/);
        return true;
      },
    );
    const digest = sha256Hex(bytes);
    assert.doesNotThrow(() => verifyPayload(bytes, { sha256: digest, size: bytes.length }, "asset"));
  });

  it("checks the SHA-512 cross-check", () => {
    const bytes = Buffer.from("payload");
    assert.doesNotThrow(() => verifyPayload(bytes, { sha512: sha512Base64(bytes) }, "asset"));
    assert.throws(
      () => verifyPayload(bytes, { sha512: sha512Base64(Buffer.from("other")) }, "asset"),
      ChecksumMismatchError,
    );
  });
});

describe("fetchVerified", () => {
  it("classifies a 5xx as a transient upstream failure with its status", async () => {
    await assert.rejects(
      fetchVerified(`${baseUrl}/busy`, {
        allowedHosts: ["127.0.0.1"],
        label: "Asset",
      }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamUnavailableError);
        assert.equal(error.evidence["http_status"], "503");
        return true;
      },
    );
  });

  it("refuses a body that came back over plain HTTP", async () => {
    // The local server speaks http, so a successful response is exactly the
    // non-HTTPS redirect the guard exists to catch. The host allow-list guard
    // is exercised in tests/core/guards.test.ts: it can only fire after the
    // scheme check, which a local server can never pass.
    await assert.rejects(
      fetchVerified(`${baseUrl}/asset`, { allowedHosts: ["127.0.0.1"], label: "Asset" }),
      (error: unknown) => {
        assert.ok(error instanceof GuardViolationError);
        assert.match(error.message, /non-HTTPS/);
        return true;
      },
    );
  });
});
