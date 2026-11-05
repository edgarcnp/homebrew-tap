// Literal placeholder substitution for descriptor name templates; no regex over
// the values, so a value is never read as a pattern and never rescanned: one
// pass over the template replaces every known token.
export function substitutePlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, key: string) => values[key] ?? token);
}

// True when a name template carries at least one `{token}` placeholder. A
// template without one is a hard-coded upstream filename the pipeline can
// neither re-derive per release nor check, so descriptors reject it.
export function hasPlaceholder(template: string): boolean {
  return /\{[A-Za-z0-9_]+\}/.test(template);
}
