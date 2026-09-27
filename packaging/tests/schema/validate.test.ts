// Unit tests for the JSON Schema subset validator (lib/schema/validate.ts).
// The validator fails closed on a schema keyword it does not know, so these
// tests also pin exactly what it supports.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateAgainstSchema } from "../../lib/schema/validate.ts";

function issues(schema: unknown, value: unknown): string[] {
  return validateAgainstSchema(schema, value).map((issue) => `${issue.path}: ${issue.message}`);
}

describe("validateAgainstSchema", () => {
  it("accepts a matching value", () => {
    assert.deepEqual(
      validateAgainstSchema(
        {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        { name: "x" },
      ),
      [],
    );
  });

  it("reports a type mismatch at its path", () => {
    assert.deepEqual(issues({ type: "object", properties: { a: { type: "string" } } }, { a: 1 }), [
      "$.a: must be string",
    ]);
  });

  it("reports a missing required property at the property path", () => {
    assert.deepEqual(issues({ type: "object", required: ["a"] }, {}), ["$.a: is required"]);
  });

  it("reports an unknown property when additionalProperties is false", () => {
    assert.deepEqual(
      issues({ type: "object", properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2 }),
      ["$.b: is not a known property"],
    );
  });

  it("applies additionalProperties as a schema", () => {
    assert.deepEqual(issues({ type: "object", additionalProperties: { type: "integer" } }, { a: 1.5 }), [
      "$.a: must be integer",
    ]);
  });

  it("checks const, enum and pattern", () => {
    assert.deepEqual(issues({ const: 2 }, 1), ["$: must equal 2"]);
    assert.deepEqual(issues({ enum: ["a", "b"] }, "c"), ['$: must be one of ["a","b"]']);
    assert.deepEqual(issues({ type: "string", pattern: "^x" }, "y"), ["$: must match ^x"]);
  });

  it("checks array bounds, uniqueness and item schemas", () => {
    assert.deepEqual(issues({ type: "array", minItems: 2 }, ["a"]), ["$: must have at least 2 items"]);
    assert.deepEqual(issues({ type: "array", uniqueItems: true }, ["a", "a"]), [
      '$: must not contain duplicate items ("a")',
    ]);
    assert.deepEqual(issues({ type: "array", items: { type: "string" } }, ["a", 1]), [
      "$[1]: must be string",
    ]);
  });

  it("checks numeric bounds", () => {
    assert.deepEqual(issues({ type: "integer", minimum: 0 }, -1), ["$: must be at least 0"]);
    assert.deepEqual(issues({ type: "integer", maximum: 10 }, 11), ["$: must be at most 10"]);
  });

  it("checks propertyNames", () => {
    assert.deepEqual(issues({ type: "object", propertyNames: { pattern: "^[A-Z]+$" } }, { lower: 1 }), [
      "$.lower: must match ^[A-Z]+$",
    ]);
  });

  it("resolves local $refs and applies sibling keywords", () => {
    const schema = {
      $defs: { name: { type: "string", minLength: 2 } },
      type: "object",
      required: ["name"],
      properties: { name: { $ref: "#/$defs/name", description: "metadata is ignored" } },
    };
    assert.deepEqual(issues(schema, { name: "ab" }), []);
    assert.deepEqual(issues(schema, { name: "a" }), ["$.name: must be at least 2 characters"]);
  });

  it("requires exactly one oneOf alternative", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          required: ["kind"],
          properties: { kind: { const: "a" } },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["kind"],
          properties: { kind: { const: "b" } },
          additionalProperties: false,
        },
      ],
    };
    assert.deepEqual(issues(schema, { kind: "a" }), []);
    assert.deepEqual(issues(schema, { kind: "c" }), [
      "$: must match exactly one of 2 alternatives (matched 0)",
    ]);
  });

  it("fails closed on an unsupported keyword or type", () => {
    assert.throws(() => validateAgainstSchema({ allOf: [] }, {}), /Unsupported schema keyword "allOf"/);
    assert.throws(() => validateAgainstSchema({ type: "uuid" }, "x"), /Unsupported schema type "uuid"/);
    assert.throws(() => validateAgainstSchema({ $ref: "https://example.com/x" }, {}), /Unsupported \$ref/);
  });
});
