// Debian version comparison, a faithful port of dpkg's verrevcmp()/order()
// (libdpkg/version.c): digit characters and the end of a part weigh 0, '~'
// weighs -1, letters weigh their ASCII value, and every other character
// weighs its value plus 256. So letters sort before all other punctuation, a
// tilde sorts before the end of a part, and digit runs compare numerically
// with leading zeros ignored. Comparing raw strings instead (what this
// replaced) ordered letters after punctuation and got those picks wrong.

import { fail } from "./guards.ts";

export type Ordering = -1 | 0 | 1;

// Ordering weight of a single character; "" stands for the end of a part.
function order(char: string): number {
  if (char === "") return 0;
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return 0;
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return code;
  if (char === "~") return -1;
  return code === 0 ? 0 : code + 256;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

// dpkg's verrevcmp: compare one upstream or revision part.
function compareParts(a: string, b: string): Ordering {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    let firstDiff = 0;
    while ((i < a.length && !isDigit(a[i] ?? "")) || (j < b.length && !isDigit(b[j] ?? ""))) {
      const ac = order(a[i] ?? "");
      const bc = order(b[j] ?? "");
      if (ac !== bc) return ac < bc ? -1 : 1;
      i += 1;
      j += 1;
    }
    while (a[i] === "0") i += 1;
    while (b[j] === "0") j += 1;
    while (i < a.length && j < b.length && isDigit(a[i] ?? "") && isDigit(b[j] ?? "")) {
      if (firstDiff === 0) firstDiff = (a[i] ?? "").charCodeAt(0) - (b[j] ?? "").charCodeAt(0);
      i += 1;
      j += 1;
    }
    if (i < a.length && isDigit(a[i] ?? "")) return 1;
    if (j < b.length && isDigit(b[j] ?? "")) return -1;
    if (firstDiff !== 0) return firstDiff < 0 ? -1 : 1;
  }
  return 0;
}

interface ParsedVersion {
  epoch: string;
  upstream: string;
  revision: string;
}

export function parseDebVersion(version: string): ParsedVersion {
  const match = /^(\d+):(.*)$/.exec(version);
  let rest = version;
  let epoch = "0";
  if (match) {
    epoch = match[1] ?? "0";
    rest = match[2] ?? "";
  }
  if (rest.length === 0) fail(`Invalid package version: ${version}`);
  const separator = rest.lastIndexOf("-");
  const upstream = separator === -1 ? rest : rest.slice(0, separator);
  const revision = separator === -1 ? "" : rest.slice(separator + 1);
  // dpkg splits at the last hyphen and does not police the policy charset; we
  // accept the same shapes and reject only structurally unsafe input.
  if (!/^[0-9][0-9A-Za-z.+~-]*$/.test(upstream)) {
    fail(`Invalid package version: ${version}`);
  }
  if (revision !== "" && !/^[0-9A-Za-z.+~]*$/.test(revision)) {
    fail(`Invalid package version: ${version}`);
  }
  return { epoch, upstream, revision };
}

// Numeric epochs compared without going through Number(), which loses
// precision on absurdly long epochs.
function compareEpochs(a: string, b: string): Ordering {
  const trim = (value: string): string => value.replace(/^0+(?=\d)/, "");
  const na = trim(a);
  const nb = trim(b);
  if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

export function compareDebVersions(a: string, b: string): Ordering {
  const pa = parseDebVersion(a);
  const pb = parseDebVersion(b);
  const epochOrder = compareEpochs(pa.epoch, pb.epoch);
  if (epochOrder !== 0) return epochOrder;
  const upstreamOrder = compareParts(pa.upstream, pb.upstream);
  if (upstreamOrder !== 0) return upstreamOrder;
  return compareParts(pa.revision, pb.revision);
}

// Ascending sort under the same ordering the gate and the casks use. Callers
// that publish or prune releases must not re-derive an order from `sort -V`:
// GNU's version sort and dpkg disagree about which of two versions is newer.
// For "1.0.109a" vs "1.0.109-1" sort -V ranks the lettered version first,
// while dpkg splits the hyphen into upstream+revision, compares the upstream
// parts ("1.0.109" < "1.0.109a", because an ended part sorts before a letter)
// and so ranks it second - and pruning must never drop the newest release.
export function sortDebVersions(versions: readonly string[]): string[] {
  // Validate every entry up front: comparing alone would never look at a
  // version that the sort leaves uncompared (a single-element list, or an
  // element that happens to need no comparison), and a caller that prunes by
  // index must not receive a list holding an unparseable version.
  for (const version of versions) parseDebVersion(version);
  return [...versions].sort(compareDebVersions);
}

// Strips a numeric build-epoch suffix so a cask/tag version stays stable
// across per-architecture rebuilds; versions without one are kept verbatim.
export function normalizeUpstreamVersion(version: string): string {
  if (/^[0-9][0-9A-Za-z.+~]*-[0-9]+$/.test(version)) {
    return version.slice(0, version.indexOf("-"));
  }
  return version;
}
