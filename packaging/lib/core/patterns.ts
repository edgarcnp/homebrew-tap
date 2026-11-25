// Regexes more than one module must agree on.

// A safe identifier: starts alphanumeric, then letters/digits/._- . Used for
// package, cask and asset basenames (no path separators, no leading dash).
export const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The API's app id contract: discovery skips `apps/<id>` directories that do
// not match, and POST /v1/homebrew/tap/event answers 422 for a record whose
// `app` does not. Unlike SAFE_IDENTIFIER it is lowercase-only, hyphenated and
// capped at 64 characters.
export const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Same as SAFE_IDENTIFIER but also allowing "+", for release tag prefixes and
// upstream package names (which may carry a "+" build marker).
export const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// Debian upstream/release versions: a leading digit, then the dpkg version
// charset. No "_": dpkg's own parser rejects it, so accepting it here would
// only defer the failure to sort/prune time. Used for tag-derived versions and
// manifest versions.
export const DEB_VERSION = /^[0-9][0-9A-Za-z.+~-]*$/;

// The one GitHub API repository URL shape the GitHub-backed advisories accept.
export const GITHUB_API_REPOSITORY =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// The GitHub latest-release URL a `"github-release"` watch may name: the same
// pinned API repository path plus `/releases/latest`, the endpoint that answers
// only a release that is neither a draft nor a prerelease (the readers strip an
// optional trailing slash). Mirror of the API's GITHUB_RELEASE_FEED.
export const GITHUB_RELEASE_FEED =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/latest\/?$/;

// Any GitHub releases API URL. A `"json"` watch may name one to read a field of
// the release object itself (the tag, whose text resolution matches), which is
// the same transport the `"github-release"` reader uses, so the validator
// applies that reader's pinned-path rule to it as well.
export const GITHUB_RELEASES_API =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases(?:[/?#]|$)/;
