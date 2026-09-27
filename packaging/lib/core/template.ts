// Literal placeholder substitution for descriptor name templates; no regex over
// the values, so a value is never read as a pattern and never rescanned: one
// pass over the template replaces every known token.
export function substitutePlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, key: string) => values[key] ?? token);
}
