// The cask-smoke gate: one launcher per app. Homebrew's app_image artifact
// installs the desktop entry packed into the AppImage and the cask's postflight
// writes its own, so the two names have to agree. When they do not the user
// gets two identical icons (an entry named after the cask beside one named
// after the AppImage), and every install check still passes because both files
// are valid entries.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { REPO_ROOT } from "../../lib/core/paths.ts";

const SCRIPT = path.join(REPO_ROOT, "packaging", "scripts", "check-desktop-entries.sh");

let applications: string;

function entry(name: string, exec: string): void {
  fs.writeFileSync(
    path.join(applications, name),
    ["[Desktop Entry]", "Type=Application", `Name=${name}`, `Exec=${exec}`, ""].join("\n"),
  );
}

function check(app = "vscode"): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [SCRIPT, "--app", app, "--applications-dir", applications], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

beforeEach(() => {
  applications = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-entries-"));
});

afterEach(() => {
  fs.rmSync(applications, { recursive: true, force: true });
});

describe("check-desktop-entries.sh", () => {
  // What vscode's cask postflight writes.
  const caskEntry = '"/home/linuxbrew/.linuxbrew/bin/code" %F';
  // What the app_image artifact installs: the AppImage's own entry.
  const imageEntry =
    "env DESKTOPINTEGRATION=1 /home/edgarcnp/Applications/vscode-1.2.3-x86_64.AppImage %F";

  it("accepts the cask's entry alone", () => {
    entry("vscode.desktop", caskEntry);

    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ok vscode: vscode\.desktop/);
  });

  it("rejects the entry the app_image artifact installs beside it", () => {
    entry("vscode.desktop", caskEntry);
    entry("vscode-alt.desktop", imageEntry);

    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /vscode: 2 desktop entries for one app: vscode-alt\.desktop vscode\.desktop/);
  });

  it("rejects the artifact's entry on its own", () => {
    entry("vscode-alt.desktop", imageEntry);

    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /vscode: expected vscode\.desktop, found vscode-alt\.desktop/);
  });

  it("rejects an app with no desktop entry at all", () => {
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /vscode: no desktop entry in /);
  });

  it("ignores another app's entries", () => {
    entry("vscode.desktop", caskEntry);
    entry("zed.desktop", '"/home/linuxbrew/.linuxbrew/bin/zed" %F');

    const result = check();
    assert.equal(result.status, 0, result.stderr);
  });
});
