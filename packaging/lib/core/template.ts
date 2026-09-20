// Literal placeholder substitution for descriptor name templates; no regex, so
// a value is never read as a pattern.

export function substitutePlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}
