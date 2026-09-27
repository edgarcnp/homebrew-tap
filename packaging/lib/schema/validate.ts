// A deliberately small JSON Schema validator: only the keywords the
// descriptor and manifest schemas use, and an error for any keyword it does
// not know. Schemas are trusted input (they live in this repository); values
// are not. `validateAgainstSchema` returns every issue it finds instead of
// throwing, so a caller can report a document with all of its problems.
//
// Supported: $ref (local "#/$defs/..." only), type, const, enum, pattern,
// minLength, minimum, maximum, minItems, uniqueItems, required, properties,
// additionalProperties (boolean or schema), items, propertyNames, oneOf.
// Anything else fails closed so a schema cannot quietly lose a rule.

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

const META_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "examples",
  "default",
  "deprecated",
]);

const VALIDATION_KEYWORDS = new Set([
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "minimum",
  "maximum",
  "minItems",
  "uniqueItems",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "propertyNames",
  "oneOf",
]);

// A guard against a $ref cycle in a malformed schema; the real schemas are
// shallow.
const MAX_DEPTH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    default:
      throw new Error(`Unsupported schema type "${type}"`);
  }
}

class Validator {
  private readonly root: Record<string, unknown>;
  private readonly issues: SchemaIssue[] = [];

  constructor(root: Record<string, unknown>) {
    this.root = root;
  }

  validate(value: unknown, path = "$", depth = 0): SchemaIssue[] {
    this.check(this.root, value, path, depth);
    return this.issues;
  }

  private issue(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  private resolveReference(reference: unknown, path: string): Record<string, unknown> {
    if (typeof reference !== "string") {
      throw new Error(`$ref must be a string at ${path}`);
    }
    const prefix = "#/$defs/";
    if (!reference.startsWith(prefix)) {
      throw new Error(`Unsupported $ref "${reference}" at ${path} (only local $defs)`);
    }
    const definitions = this.root["$defs"];
    const name = reference.slice(prefix.length);
    const target =
      isRecord(definitions) && Object.hasOwn(definitions, name) ? definitions[name] : undefined;
    if (!isRecord(target)) {
      throw new Error(`$ref "${reference}" at ${path} does not resolve`);
    }
    return target;
  }

  private check(schema: Record<string, unknown>, value: unknown, path: string, depth: number): void {
    if (depth > MAX_DEPTH) throw new Error(`Schema recursion too deep at ${path}`);
    for (const keyword of Object.keys(schema)) {
      if (!META_KEYWORDS.has(keyword) && !VALIDATION_KEYWORDS.has(keyword)) {
        throw new Error(`Unsupported schema keyword "${keyword}" at ${path}`);
      }
    }

    const reference = schema["$ref"];
    if (reference !== undefined) {
      this.check(this.resolveReference(reference, path), value, path, depth + 1);
    }

    const type = schema["type"];
    if (type !== undefined) {
      const allowed = Array.isArray(type) ? type : [type];
      if (allowed.length === 0 || !allowed.every((entry) => typeof entry === "string")) {
        throw new Error(`type must be a string or string array at ${path}`);
      }
      if (!allowed.some((entry) => matchesType(value, entry as string))) {
        this.issue(path, `must be ${allowed.join(" or ")}`);
        return;
      }
    }

    const constant = schema["const"];
    if (constant !== undefined && !deepEqual(value, constant)) {
      this.issue(path, `must equal ${JSON.stringify(constant)}`);
    }

    const allowedValues = schema["enum"];
    if (allowedValues !== undefined) {
      if (!Array.isArray(allowedValues) || allowedValues.length === 0) {
        throw new Error(`enum must be a non-empty array at ${path}`);
      }
      if (!allowedValues.some((entry) => deepEqual(value, entry))) {
        this.issue(path, `must be one of ${JSON.stringify(allowedValues)}`);
      }
    }

    const pattern = schema["pattern"];
    if (pattern !== undefined) {
      if (typeof pattern !== "string") throw new Error(`pattern must be a string at ${path}`);
      if (typeof value === "string" && !new RegExp(pattern).test(value)) {
        this.issue(path, `must match ${pattern}`);
      }
    }

    const minLength = countBound(schema["minLength"], "minLength", path);
    if (minLength !== undefined) {
      if (typeof value === "string" && value.length < minLength) {
        this.issue(path, `must be at least ${minLength} characters`);
      }
    }

    const minimum = boundedNumber(schema["minimum"], "minimum", path);
    if (minimum !== undefined) {
      if (typeof value === "number" && value < minimum) {
        this.issue(path, `must be at least ${minimum}`);
      }
    }

    const maximum = boundedNumber(schema["maximum"], "maximum", path);
    if (maximum !== undefined) {
      if (typeof value === "number" && value > maximum) {
        this.issue(path, `must be at most ${maximum}`);
      }
    }

    const minItems = countBound(schema["minItems"], "minItems", path);
    if (minItems !== undefined) {
      if (Array.isArray(value) && value.length < minItems) {
        this.issue(path, `must have at least ${minItems} items`);
      }
    }

    const uniqueItems = schema["uniqueItems"];
    if (uniqueItems !== undefined) {
      if (typeof uniqueItems !== "boolean") {
        throw new Error(`uniqueItems must be a boolean at ${path}`);
      }
      if (uniqueItems && Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          for (let other = index + 1; other < value.length; other += 1) {
            if (deepEqual(value[index], value[other])) {
              this.issue(path, `must not contain duplicate items (${JSON.stringify(value[index])})`);
            }
          }
        }
      }
    }

    const required = schema["required"];
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
        throw new Error(`required must be a string array at ${path}`);
      }
      if (isRecord(value)) {
        for (const key of required) {
          if (!Object.hasOwn(value, key)) this.issue(`${path}.${key}`, "is required");
        }
      }
    }

    const properties = schema["properties"];
    if (properties !== undefined && !isRecord(properties)) {
      throw new Error(`properties must be an object at ${path}`);
    }
    const known = isRecord(properties) ? properties : {};

    if (isRecord(value)) {
      for (const [key, subschema] of Object.entries(known)) {
        if (Object.hasOwn(value, key)) {
          this.check(asSchema(subschema, `${path}.${key}`), value[key], `${path}.${key}`, depth + 1);
        }
      }
      const additional = schema["additionalProperties"];
      if (additional === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(known, key)) {
            this.issue(`${path}.${key}`, "is not a known property");
          }
        }
      } else if (isRecord(additional)) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(known, key)) {
            this.check(additional, value[key], `${path}.${key}`, depth + 1);
          }
        }
      } else if (additional !== undefined && additional !== true) {
        throw new Error(`additionalProperties must be a boolean or schema at ${path}`);
      }
    }

    const propertyNames = schema["propertyNames"];
    if (propertyNames !== undefined && isRecord(value)) {
      const subschema = asSchema(propertyNames, `${path} (propertyNames)`);
      for (const key of Object.keys(value)) {
        this.check(subschema, key, `${path}.${key}`, depth + 1);
      }
    }

    const items = schema["items"];
    if (items !== undefined && Array.isArray(value)) {
      if (Array.isArray(items)) throw new Error(`Tuple items are not supported at ${path}`);
      const subschema = asSchema(items, `${path}[]`);
      for (const [index, entry] of value.entries()) {
        this.check(subschema, entry, `${path}[${index}]`, depth + 1);
      }
    }

    const oneOf = schema["oneOf"];
    if (oneOf !== undefined) {
      if (!Array.isArray(oneOf) || oneOf.length === 0) {
        throw new Error(`oneOf must be a non-empty array at ${path}`);
      }
      let matches = 0;
      for (const alternative of oneOf) {
        const child = new Validator(this.root);
        child.check(asSchema(alternative, `${path} (oneOf)`), value, path, depth + 1);
        if (child.issues.length === 0) matches += 1;
      }
      if (matches !== 1) {
        this.issue(
          path,
          `must match exactly one of ${oneOf.length} alternatives (matched ${matches})`,
        );
      }
    }
  }
}

function asSchema(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Schema at ${label} must be an object`);
  return value;
}

function boundedNumber(value: unknown, keyword: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${keyword} must be a finite number at ${path}`);
  }
  return value;
}

function countBound(value: unknown, keyword: string, path: string): number | undefined {
  const bound = boundedNumber(value, keyword, path);
  if (bound !== undefined && (!Number.isInteger(bound) || bound < 0)) {
    throw new Error(`${keyword} must be a non-negative integer at ${path}`);
  }
  return bound;
}

export function validateAgainstSchema(schema: unknown, value: unknown): SchemaIssue[] {
  if (!isRecord(schema)) throw new Error("Schema must be an object");
  return new Validator(schema).validate(value);
}
