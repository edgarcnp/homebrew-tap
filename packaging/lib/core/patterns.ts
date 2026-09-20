// Regexes more than one module must agree on.

// A safe identifier: starts alphanumeric, then letters/digits/._- . Used for
// package, cask and asset basenames (no path separators, no leading dash).
export const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Same as SAFE_IDENTIFIER but also allowing "+", for release tag prefixes and
// upstream package names (which may carry a "+" build marker).
export const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// Debian upstream/release versions: a leading digit, then the dpkg version
// charset. Used for tag-derived versions and manifest versions.
export const DEB_VERSION = /^[0-9][0-9A-Za-z.+~_-]*$/;

// The one GitHub API repository URL shape the GitHub-backed oracles accept.
export const GITHUB_API_REPOSITORY =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
