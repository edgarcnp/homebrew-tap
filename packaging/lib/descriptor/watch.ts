// Release-watch block. versionPattern matches the feed entry *title*: an atom
// entry title, the GitHub release `name` (or its `tag_name` when the name is
// empty) for `"github-release"`, or the JSON `versionField` value for
// `format: "json"` feeds; capture group 1 is the version.

import { z } from "zod";
import { dottedField, httpsUrl, nonEmptyString, ownerRepo } from "./scalars.ts";

export const watchFormatSchema = z.enum(["atom", "json", "github-release"]);

export const watchSchema = z.strictObject({
  feedUrl: httpsUrl,
  versionPattern: nonEmptyString,
  // Entries whose title matches are skipped, e.g. GitComet's "-rc" releases.
  skipPattern: nonEmptyString.exactOptional(),
  // Upstream repo (owner/repo) the watch feed belongs to; informational for
  // the API's watcher.
  repo: ownerRepo.exactOptional(),
  // Feed format: "atom" parses releases.atom entry titles, "github-release"
  // reads the GitHub releases list from the pinned API URL, and "json" reads a
  // single version string at `versionField`.
  format: watchFormatSchema,
  // Dotted path to the version string in a JSON feed; required with "json",
  // rejected otherwise.
  versionField: dottedField.exactOptional(),
});

export type WatchFormat = z.infer<typeof watchFormatSchema>;
export type WatchConfig = z.infer<typeof watchSchema>;
