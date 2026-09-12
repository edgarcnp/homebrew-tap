// Desktop entry rendering. Replaces the shell's sed-based render_template:
// substitutions are literal (no regex or sed escaping) and every token is
// validated, so a descriptor cannot inject extra keys or lines.

import * as fs from "node:fs";
import { assertSingleLine, fail } from "./guards.ts";
import { writeFileAtomic } from "./http.ts";
import { appDir } from "./paths.ts";
import type { AppDescriptor } from "./types.ts";

const REQUIRED_KEYS = ["Name=", "Comment=", "Exec=", "Icon=", "Type=Application"];

export function renderDesktopEntry(descriptor: AppDescriptor, version: string): string {
  const templatePath = `${appDir(descriptor.id)}/${descriptor.desktopTemplate}`;
  if (!fs.existsSync(templatePath)) fail(`Missing desktop template: ${templatePath}`);
  const template = fs.readFileSync(templatePath, "utf8");

  const substitutions: Record<string, string> = {
    __PACKAGE_NAME__: descriptor.cask,
    __PACKAGE_DISPLAY_NAME__: assertSingleLine(descriptor.displayName, "displayName"),
    __PACKAGE_COMMENT__: assertSingleLine(descriptor.comment, "comment"),
    __VERSION__: assertSingleLine(version, "version"),
  };
  if (!/^[0-9A-Za-z._+-]+$/.test(version)) fail(`Unsafe desktop entry version: ${version}`);

  let rendered = template;
  for (const [token, value] of Object.entries(substitutions)) {
    rendered = rendered.split(token).join(value);
  }
  const leftover = /__[A-Z_]+__/.exec(rendered);
  if (leftover !== null) fail(`Desktop template has an unsubstituted token: ${leftover[0]}`);
  if (!rendered.endsWith("\n")) rendered += "\n";
  for (const key of REQUIRED_KEYS) {
    if (!rendered.includes(`\n${key}`)) {
      fail(`Desktop template is missing a ${key} entry`);
    }
  }
  return rendered;
}

export function writeDesktopEntry(
  descriptor: AppDescriptor,
  version: string,
  destination: string,
): void {
  writeFileAtomic(destination, renderDesktopEntry(descriptor, version));
  fs.chmodSync(destination, 0o644);
}
