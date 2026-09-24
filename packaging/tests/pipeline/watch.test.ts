import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadDescriptor } from "../../lib/pipeline/descriptor.ts";
import { atomEntryTitles, planHold, selectFeedVersion } from "../../lib/pipeline/watch.ts";
import type { WatchConfig } from "../../lib/core/types.ts";

// Shaped like releases.atom: the feed carries its own <title>, and entries
// arrive in release-date order, not version order.
function atom(feedTitle: string, entryTitles: string[]): string {
  return [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<feed xmlns=\"http://www.w3.org/2005/Atom\">",
    `  <title>${feedTitle}</title>`,
    ...entryTitles.map(
      (title) =>
        `  <entry><id>tag:github.com,2008:Repository/1</id><title>${title}</title><updated>2026-09-22T13:13:04Z</updated></entry>`,
    ),
    "</feed>",
    "",
  ].join("\n");
}

function watch(app: string): WatchConfig {
  const config = loadDescriptor(app).watch;
  assert.ok(config !== undefined, `${app} must declare a watch block`);
  return config;
}

describe("atomEntryTitles", () => {
  it("reads entry titles and leaves the feed's own title out", () => {
    const titles = atomEntryTitles(atom("v9.9.9", ["v2.0.14", "v2.0.13"]));
    assert.deepEqual(titles, ["v2.0.14", "v2.0.13"]);
  });

  it("unwraps CDATA and decodes character references", () => {
    const xml = atom("Release notes", ["<![CDATA[v2.0.15]]>", "Command &amp; Code 0.1.29"]);
    assert.deepEqual(atomEntryTitles(xml), ["v2.0.15", "Command & Code 0.1.29"]);
  });
});

describe("selectFeedVersion", () => {
  it("picks the newest version an atom feed advertises", () => {
    const feed = atom("Release notes from opencode", ["v2.0.14", "v2.0.13", "v2.0.12"]);
    assert.equal(selectFeedVersion(watch("opencode-desktop"), feed), "2.0.14");
  });

  it("orders by dpkg semantics, not by feed position", () => {
    // Date order puts the older 1.x backport first; 2.0.12 is still newer.
    const feed = atom("Release notes from opencode", ["v1.18.32", "v2.0.12", "v2.0.11"]);
    assert.equal(selectFeedVersion(watch("opencode-desktop"), feed), "2.0.12");
  });

  it("reads titles that are release names rather than tags", () => {
    const feed = atom("Release notes from cline", ["CLI v3.0.65", "Desktop v0.0.35"]);
    assert.equal(selectFeedVersion(watch("cline-desktop"), feed), "0.0.35");
  });

  it("returns null when no entry matches", () => {
    assert.equal(selectFeedVersion(watch("opencode-desktop"), atom("Release notes", ["nightly"])), null);
    assert.equal(selectFeedVersion(watch("opencode-desktop"), "<feed></feed>"), null);
  });

  it("applies skipPattern before the version pattern", () => {
    const skipped: WatchConfig = {
      feedUrl: "https://example.com/releases.atom",
      format: "atom",
      versionPattern: "(\\d+\\.\\d+\\.\\d+)",
      skipPattern: "^nightly/",
    };
    const feed = atom("Release notes", ["nightly/9.9.9", "1.1.0"]);
    assert.equal(selectFeedVersion(skipped, feed), "1.1.0");
  });

  it("reads a JSON feed at its dotted versionField", () => {
    assert.equal(selectFeedVersion(watch("little-genius"), "{\"version\":\"0.6.7\"}"), "0.6.7");
    const nested: WatchConfig = {
      feedUrl: "https://example.com/manifest.json",
      format: "json",
      versionPattern: "^(\\d+\\.\\d+\\.\\d+)$",
      versionField: "metadata.version",
    };
    assert.equal(selectFeedVersion(nested, "{\"metadata\":{\"version\":\"1.2.3\"}}"), "1.2.3");
    assert.equal(selectFeedVersion(nested, "{\"metadata\":{}}"), null);
  });

  it("rejects a JSON feed that is not JSON", () => {
    assert.throws(() => selectFeedVersion(watch("little-genius"), "<html>maintenance</html>"), /not valid JSON/);
  });

  it("skips entries dpkg cannot order, so a junk title cannot reach the shell", () => {
    const loose: WatchConfig = {
      feedUrl: "https://example.com/releases.atom",
      format: "atom",
      versionPattern: "v(.+)",
    };
    assert.equal(selectFeedVersion(loose, atom("Release notes", ["v1.0_bad", "v2.0.0"])), "2.0.0");
    assert.equal(selectFeedVersion(loose, atom("Release notes", ["v1.0_bad"])), null);
    // A capture big enough to carry a workflow command line is still one line.
    const injected = atom("Release notes", ["v1.0.0\n::error::boom", "v2.0.0"]);
    assert.equal(selectFeedVersion(loose, injected), "2.0.0");
  });
});

describe("planHold", () => {
  it("holds when the feed is ahead of the cask and resolve has not moved", () => {
    // The 2.0.14 incident: the feed had published, the update manifest had not.
    assert.equal(planHold({ caskVersion: "2.0.13", upstreamVersion: "2.0.13", feedVersion: "2.0.14" }), true);
  });

  it("does not hold a run that is already up to date", () => {
    assert.equal(planHold({ caskVersion: "2.0.13", upstreamVersion: "2.0.13", feedVersion: "2.0.13" }), false);
    assert.equal(planHold({ caskVersion: "2.0.13", upstreamVersion: "2.0.13", feedVersion: null }), false);
    assert.equal(planHold({ caskVersion: "2.0.13", upstreamVersion: "2.0.13", feedVersion: "" }), false);
  });

  it("does not hold a run whose build is already due", () => {
    // resolve moved past the cask: build now instead of waiting for the feed.
    assert.equal(planHold({ caskVersion: "2.0.12", upstreamVersion: "2.0.13", feedVersion: "2.0.14" }), false);
    assert.equal(planHold({ caskVersion: "2.0.13", upstreamVersion: "2.0.14", feedVersion: "2.0.14" }), false);
  });

  it("does not hold when the cask is ahead of the feed", () => {
    assert.equal(planHold({ caskVersion: "2.0.14", upstreamVersion: "2.0.13", feedVersion: "2.0.14" }), false);
  });

  it("ignores a feed version that is not a cask version", () => {
    assert.equal(planHold({ caskVersion: "2.0.13", upstreamVersion: "2.0.13", feedVersion: "nightly" }), false);
  });

  it("ignores a feed version dpkg cannot order", () => {
    assert.equal(planHold({ caskVersion: "1.0.0", upstreamVersion: "1.0.0", feedVersion: "1.0_bad" }), false);
  });

  it("leaves a broken cask pin to the gate", () => {
    assert.equal(planHold({ caskVersion: "", upstreamVersion: "2.0.13", feedVersion: "2.0.14" }), false);
  });
});
