// Literal placeholder substitution for descriptor-declared name templates
// ("<name>-{version}-{arch}.deb"). Substitution is by literal split/join, not
// regex, so a value can never be read as a pattern.

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
