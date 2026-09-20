import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertReleaseFreshness,
  extractClearSignedPayload,
  parseDeb822,
  parseReleaseSha256,
} from "./deb822.ts";

const IN_RELEASE = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Origin: example
Date: Thu, 10 Sep 2026 00:00:00 UTC
SHA256:
 0000000000000000000000000000000000000000000000000000000000000001 1234 main/binary-amd64/Packages
 0000000000000000000000000000000000000000000000000000000000000002 2345 main/binary-arm64/Packages
-----BEGIN PGP SIGNATURE-----

iQIzBAEBCgAdFiEE...
-----END PGP SIGNATURE-----
`;

describe("extractClearSignedPayload", () => {
  it("unwraps the clear-signed payload and dash-escapes", () => {
    const payload = extractClearSignedPayload(IN_RELEASE);
    // The cleartext headers are dropped; the signed payload starts at Origin.
    assert.match(payload, /^Origin: example/);
    assert.match(payload, /main\/binary-amd64\/Packages/);
    assert.doesNotMatch(payload, /BEGIN PGP SIGNATURE/);
  });

  it("rejects unsigned or truncated input", () => {
    assert.throws(() => extractClearSignedPayload("Origin: example\n"), /not an OpenPGP/);
    assert.throws(
      () => extractClearSignedPayload("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512"),
      /missing header terminator/,
    );
    assert.throws(
      () => extractClearSignedPayload("-----BEGIN PGP SIGNED MESSAGE-----\n\nOrigin: x\n"),
      /missing PGP signature/,
    );
  });
});

describe("parseReleaseSha256", () => {
  it("indexes files from the SHA256 section only", () => {
    const entries = parseReleaseSha256(extractClearSignedPayload(IN_RELEASE));
    assert.equal(entries.size, 2);
    assert.deepEqual(entries.get("main/binary-amd64/Packages"), {
      sha256: "0".repeat(63) + "1",
      size: 1234,
    });
    assert.equal(entries.has("Origin: example"), false);
  });

  it("skips traversal paths and oversized or malformed entries", () => {
    const payload = [
      "SHA256:",
      ` ${"a".repeat(64)} 10 ../../etc/passwd`,
      ` ${"b".repeat(64)} 10 /etc/passwd`,
      ` ${"c".repeat(64)} 0 main/binary-amd64/Packages`,
      ` ${"d".repeat(64)} ${Number.MAX_SAFE_INTEGER} main/binary-amd64/Packages`,
      ` ${"e".repeat(64)} 10 main/binary-arm64/Packages`,
    ].join("\n");
    const entries = parseReleaseSha256(payload);
    assert.deepEqual([...entries.keys()], ["main/binary-arm64/Packages"]);
  });
});

describe("parseDeb822", () => {
  it("parses stanzas with folded continuation lines", () => {
    const source = [
      "Package: code",
      "Architecture: amd64",
      "Depends: libc6 (>= 2.17),",
      " libgtk-3-0",
      "",
      "Package: code-insiders",
      "Architecture: amd64",
      "",
    ].join("\n");
    const paragraphs = parseDeb822(source);
    assert.equal(paragraphs.length, 2);
    assert.equal(paragraphs[0]?.["Depends"], "libc6 (>= 2.17),\nlibgtk-3-0");
    assert.equal(paragraphs[1]?.["Package"], "code-insiders");
  });

  it("refuses prototype-polluting field names", () => {
    assert.throws(() => parseDeb822("__proto__: polluted\n"), /invalid field name/);
    assert.throws(() => parseDeb822("constructor: polluted\n"), /invalid field name/);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("rejects lines without a field separator", () => {
    assert.throws(() => parseDeb822("not a stanza\n"), /Malformed Packages line/);
  });
});

describe("assertReleaseFreshness", () => {
  const now = Date.parse("2026-09-12T00:00:00Z");
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };

  it("accepts a recent Date", () => {
    warnings.length = 0;
    assertReleaseFreshness("Date: Fri, 11 Sep 2026 00:00:00 UTC\n", { now, warn });
    assert.deepEqual(warnings, []);
  });

  it("warns between 7 and 14 days and rejects older indexes", () => {
    warnings.length = 0;
    assertReleaseFreshness("Date: Fri, 04 Sep 2026 00:00:00 UTC\n", { now, warn });
    assert.equal(warnings.length, 1);
    assert.throws(
      () => assertReleaseFreshness("Date: Sat, 22 Aug 2026 00:00:00 UTC\n", { now, warn }),
      /too old/,
    );
  });

  it("honors Valid-Until and rejects expired indexes", () => {
    assertReleaseFreshness("Date: Fri, 11 Sep 2026 00:00:00 UTC\nValid-Until: Sat, 12 Sep 2026 12:00:00 UTC\n", {
      now,
      warn,
    });
    assert.throws(
      () => assertReleaseFreshness("Valid-Until: Thu, 10 Sep 2026 00:00:00 UTC\n", { now, warn }),
      /expired/,
    );
  });

  it("requires a Date when there is no Valid-Until", () => {
    assert.throws(() => assertReleaseFreshness("Origin: example\n", { now, warn }), /missing Date/);
    assert.throws(
      () => assertReleaseFreshness("Date: not a date\n", { now, warn }),
      /Invalid Date/,
    );
  });
});
