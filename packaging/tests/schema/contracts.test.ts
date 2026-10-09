// The descriptor v2 and manifest schemas: the examples validate, the field
// sets are pinned (a change here is deliberate), and realistic mistakes fail.
// See packaging/REDESIGN.md, phase 0. Nothing here is wired into the loader
// yet, so these tests are the only consumer of the schemas.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";
import { validateAgainstSchema } from "../../lib/schema/validate.ts";

const SCHEMA_DIR = path.join(REPO_ROOT, "packaging", "schema");

function readJson(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relative), "utf8"));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

function problems(schema: unknown, value: unknown): string[] {
  return validateAgainstSchema(schema, value).map((issue) => `${issue.path}: ${issue.message}`);
}

const appSchema = readJson("app.schema.json");
const manifestSchema = readJson("manifest.schema.json");
const appExample = readJson("examples/app.v2.example.json");
const manifestExample = readJson("examples/manifest.example.json");

// The v2 contract; a change here is a schema change, not an accident.
const APP_V2_FIELDS = [
  "$schema",
  "schemaVersion",
  "id",
  "appName",
  "displayName",
  "comment",
  "cask",
  "watch",
  "assetPrefix",
  "tagPrefix",
  "releaseRepo",
  "debloatArgs",
  "buildPackages",
  "architectures",
  "binaryTargets",
  "advisory",
  "payload",
  "icon",
  "desktopTemplate",
  "updater",
  "quickSharun",
  "hostHelpers",
  "homebrew",
];

describe("descriptor v2 schema", () => {
  it("accepts the example descriptor", () => {
    assert.deepEqual(problems(appSchema, appExample), []);
  });

  it("pins the top-level field set and drops the source block", () => {
    const properties = asRecord(asRecord(appSchema)["properties"]);
    assert.deepEqual(Object.keys(properties).sort(), [...APP_V2_FIELDS].sort());
    for (const removed of ["sourceRepo", "sourceOwner", "sourceDir", "buildCommand"]) {
      assert.equal(properties[removed], undefined, `${removed} must not be a v2 field`);
    }
  });

  it("rejects an unknown top-level field", () => {
    const mutated = { ...asRecord(appExample), buildCommand: "./build.sh" };
    assert.deepEqual(problems(appSchema, mutated), ["$.buildCommand: is not a known property"]);
  });

  it("rejects a descriptor with no homebrew block", () => {
    const mutated = structuredClone(asRecord(appExample));
    delete mutated["homebrew"];
    assert.ok(problems(appSchema, mutated).includes("$.homebrew: is required"));
  });

  it("rejects schemaVersion 1", () => {
    const mutated = { ...asRecord(appExample), schemaVersion: 1 };
    assert.ok(problems(appSchema, mutated).includes("$.schemaVersion: must equal 2"));
  });

  it("rejects an unknown advisory kind", () => {
    const mutated = structuredClone(asRecord(appExample));
    asRecord(mutated["advisory"])["kind"] = "git";
    assert.ok(
      problems(appSchema, mutated).some((problem) =>
        problem.startsWith("$.advisory: must match exactly one"),
      ),
    );
  });

  it("rejects a github-release advisory mixing both asset layouts", () => {
    const mutated = structuredClone(asRecord(appExample));
    mutated["advisory"] = {
      kind: "github-release",
      repository: "https://api.github.com/repos/acme/app",
      assetPrefix: "app",
      assetNameTemplate: "App-{version}.deb",
      tagPrefix: "v",
      packageName: "app",
    };
    assert.ok(
      problems(appSchema, mutated).some((problem) =>
        problem.startsWith("$.advisory: must match exactly one"),
      ),
    );
  });

  it("requires the cask fields the renderer needs and no second template", () => {
    const mutated = structuredClone(asRecord(appExample));
    delete asRecord(mutated["homebrew"])["homepage"];
    assert.ok(problems(appSchema, mutated).includes("$.homebrew.homepage: is required"));

    const properties = asRecord(
      asRecord(asRecord(asRecord(appSchema)["$defs"])["homebrew"])["properties"],
    );
    assert.equal(properties["desktopTemplate"], undefined);
  });

  it("requires the shipped architectures", () => {
    const mutated = structuredClone(asRecord(appExample));
    delete mutated["architectures"];
    assert.ok(problems(appSchema, mutated).includes("$.architectures: is required"));
  });
});

describe("manifest schema", () => {
  it("accepts the example manifest", () => {
    assert.deepEqual(problems(manifestSchema, manifestExample), []);
  });

  it("rejects a malformed checksum", () => {
    const mutated = structuredClone(asRecord(manifestExample));
    asRecord(mutated["artifact"])["sha256"] = "not-a-checksum";
    assert.deepEqual(problems(manifestSchema, mutated), [
      "$.artifact.sha256: must match ^[0-9a-f]{64}$",
    ]);
  });

  it("rejects an unknown field", () => {
    const mutated = { ...asRecord(manifestExample), extra: true };
    assert.deepEqual(problems(manifestSchema, mutated), ["$.extra: is not a known property"]);
  });
});
