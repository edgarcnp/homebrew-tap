// Desktop entry rendering: literal substitution (no regex/sed), every token
// validated, so a descriptor cannot inject extra keys or lines.

import * as fs from "node:fs";
import { assertSingleLine, fail } from "../core/guards.ts";
import { writeFileAtomic } from "../core/http.ts";
import { appDir } from "../core/paths.ts";
import type { AppDescriptor } from "../descriptor/app.ts";

const REQUIRED_KEYS = ["Name=", "Comment=", "Exec=", "Icon=", "Type=Application"];

// The launcher name: the desktopId when the app needs an entry name of its
// own, else the cask token. It names the entry at the AppDir root — the one
// Homebrew's app_image artifact installs — the copy under share/applications,
// the entry the cask writes and the icon the cask installs. A single name
// keeps the artifact's entry and the cask's entry the same file.
export function launcherId(descriptor: AppDescriptor): string {
  return descriptor.desktopId ?? descriptor.cask;
}

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

  // One pass over the template: a substituted value is never rescanned, so a
  // display name containing a token cannot inject another substitution.
  let rendered = template.replace(/__[A-Z_]+__/g, (token) => substitutions[token] ?? token);
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
