import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { listApps, loadDescriptor } from "./descriptor.ts";
import { renderDesktopEntry, writeDesktopEntry } from "./render.ts";

describe("renderDesktopEntry", () => {
  it("renders every app's real template", () => {
    for (const app of listApps()) {
      const descriptor = loadDescriptor(app);
      const rendered = renderDesktopEntry(descriptor, "1.2.3");
      assert.doesNotMatch(rendered, /__[A-Z_]+__/);
      assert.match(rendered, new RegExp(`^Name=${descriptor.displayName}$`, "m"));
      assert.match(rendered, new RegExp(`^Comment=${descriptor.comment.replace(/\./g, "\\.")}$`, "m"));
      assert.match(rendered, new RegExp(`^Icon=${descriptor.cask}$`, "m"));
      assert.match(rendered, /^Exec=/m);
      assert.match(rendered, /^Type=Application$/m);
      assert.match(rendered, /^X-AppImage-Version=1\.2\.3$/m);
      assert.equal(rendered.endsWith("\n"), true);
    }
  });

  it("substitutes literals without regex or sed escaping", () => {
    const descriptor = { ...loadDescriptor("vscode"), displayName: "Code & Co. / [x]" };
    const rendered = renderDesktopEntry(descriptor, "1.0.0");
    assert.match(rendered, /^Name=Code & Co\. \/ \[x\]$/m);
  });

  it("rejects unsafe versions and missing templates", () => {
    const descriptor = loadDescriptor("vscode");
    assert.throws(
      () => renderDesktopEntry(descriptor, "1.0.0\nPath=/etc"),
      /newlines or NUL/,
    );
    assert.throws(
      () => renderDesktopEntry(descriptor, "1.0.0;rm -rf /"),
      /Unsafe desktop entry version/,
    );
    assert.throws(
      () => renderDesktopEntry({ ...descriptor, desktopTemplate: "templates/absent.desktop" }, "1.0.0"),
      /Missing desktop template/,
    );
  });
});

describe("writeDesktopEntry", () => {
  it("writes a 0644 desktop entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbr-render-"));
    try {
      const destination = path.join(dir, "vscode.desktop");
      writeDesktopEntry(loadDescriptor("vscode"), "1.2.3", destination);
      assert.equal(fs.statSync(destination).mode & 0o777, 0o644);
      assert.match(fs.readFileSync(destination, "utf8"), /^Name=Visual Studio Code$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
