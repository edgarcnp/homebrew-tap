#!/usr/bin/env node
"use strict";

// Shared resolver for signed apt repositories: pinned key -> InRelease ->
// Packages SHA-256 -> package SHA-256/size; picks the newest --package entry
// and strips the build-epoch suffix from the exposed upstream version.

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_PAYLOAD_BYTES,
  fetchWithRetry,
  readPayload,
  writeFileAtomic,
} = require("./net-utils");

const MAX_RELEASE_AGE_DAYS = 14;
const WARN_RELEASE_AGE_DAYS = 7;

function mapMachineArch(machine = os.arch()) {
  const normalized = String(machine).trim().toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "amd64";
  if (["arm64", "aarch64"].includes(normalized)) return "arm64";
  throw new Error(`Unsupported architecture '${machine}'; upstream packages support amd64 and arm64 only`);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function extractClearSignedPayload(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 100000) throw new Error("InRelease too large");
  if (lines.shift() !== "-----BEGIN PGP SIGNED MESSAGE-----") {
    throw new Error("InRelease is not an OpenPGP clear-signed message");
  }
  let headerCount = 0;
  let foundBlank = false;
  while (lines.length > 0) {
    if (headerCount++ > 50) throw new Error("InRelease header too large");
    const line = lines.shift();
    if (line === "") { foundBlank = true; break; }
  }
  if (!foundBlank) throw new Error("InRelease missing header terminator");
  const payload = [];
  let foundSig = false;
  for (const line of lines) {
    if (line === "-----BEGIN PGP SIGNATURE-----") { foundSig = true; break; }
    payload.push(line.startsWith("- ") ? line.slice(2) : line);
  }
  if (!foundSig) throw new Error("InRelease missing PGP signature");
  if (payload.length === 0) throw new Error("InRelease signed payload is empty");
  return payload.join("\n");
}

function parseReleaseSha256(payload) {
  const entries = new Map();
  let inSha256 = false;
  for (const line of String(payload).split(/\r?\n/)) {
    if (/^[A-Za-z0-9]+:/.test(line)) {
      inSha256 = line === "SHA256:";
      continue;
    }
    if (!inSha256) continue;
    const match = line.match(/^\s*([0-9a-f]{64})\s+(\d+)\s+(\S+)\s*$/i);
    if (match) {
      const entry = match[3];
      if (entry.includes("..") || entry.startsWith("/")) continue;
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size > MAX_PAYLOAD_BYTES || size <= 0) continue;
      entries.set(entry, { sha256: match[1].toLowerCase(), size });
    }
  }
  return entries;
}

function parseDeb822(source) {
  return String(source).trim().split(/\n\s*\n/).filter(Boolean).map((paragraph) => {
    const fields = Object.create(null);
    let current = null;
    for (const line of paragraph.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && current) {
        fields[current] += `\n${line.slice(1)}`;
        continue;
      }
      const separator = line.indexOf(":");
      if (separator < 1) throw new Error(`Malformed Packages line: ${line}`);
      current = line.slice(0, separator);
      if (current === "__proto__" || current === "constructor" || current === "prototype") throw new Error("invalid field name");
      fields[current] = line.slice(separator + 1).trim();
    }
    return fields;
  });
}

function compareDebVersions(a, b) {
  const parse = (version) => {
    const epoch = String(version).match(/^(\d+):/);
    return {
      epoch: epoch ? Number(epoch[1]) : 0,
      tokens: String(version)
        .slice(epoch ? epoch[0].length : 0)
        .split(/(\d+|~|[^0-9~]+)/)
        .filter(Boolean)
        .map((token) => (/^\d+$/.test(token) ? { numeric: true, value: Number(token) } : { numeric: false, value: token })),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.epoch !== pb.epoch) return pa.epoch < pb.epoch ? -1 : 1;
  const length = Math.max(pa.tokens.length, pb.tokens.length);
  for (let i = 0; i < length; i += 1) {
    const x = pa.tokens[i] ?? { numeric: false, value: "" };
    const y = pb.tokens[i] ?? { numeric: false, value: "" };
    if (x.value === "~" || y.value === "~") {
      if (x.value !== y.value) return x.value === "~" ? -1 : 1;
      continue;
    }
    if (x.numeric && y.numeric) {
      if (x.value !== y.value) return x.value < y.value ? -1 : 1;
    } else if (!x.numeric && !y.numeric) {
      if (x.value !== y.value) return x.value < y.value ? -1 : 1;
    } else {
      // Per Debian policy, numeric segments sort after letters.
      return x.numeric ? 1 : -1;
    }
  }
  return 0;
}

function normalizeUpstreamVersion(version) {
  // Strip a trailing build-epoch suffix so cask/tag versions stay stable
  // across per-architecture rebuilds; versions without one are kept verbatim.
  if (/^[0-9][0-9A-Za-z.+~]*-[0-9]+$/.test(version)) {
    return version.slice(0, version.indexOf("-"));
  }
  return version;
}

function selectLatestPackage(source, packageName, architecture) {
  const entries = parseDeb822(source).filter(
    (entry) => entry.Package === packageName && entry.Architecture === architecture,
  );
  if (entries.length === 0) {
    throw new Error(`No ${packageName}/${architecture} entry found`);
  }
  for (const entry of entries) {
    if (!/^\d[0-9A-Za-z.+:~-]*$/.test(entry.Version ?? "")) throw new Error(`Invalid ${packageName} version in Packages`);
    const filename = entry.Filename ?? "";
    if (!/^pool\/[A-Za-z0-9._+\/-]+\.deb$/.test(filename)) throw new Error(`Unsafe ${packageName} Filename in Packages`);
    if (filename.includes("..") || filename.startsWith("/")) throw new Error(`Unsafe ${packageName} Filename in Packages`);
    if (!/^[0-9a-f]{64}$/i.test(entry.SHA256 ?? "")) throw new Error(`Invalid ${packageName} SHA256 in Packages`);
    if (!/^\d+$/.test(entry.Size ?? "")) throw new Error(`Invalid ${packageName} Size in Packages`);
  }
  const latest = entries.reduce((best, entry) =>
    compareDebVersions(entry.Version, best.Version) > 0 ? entry : best,
  );
  return {
    package: latest.Package,
    version: normalizeUpstreamVersion(latest.Version),
    packageVersion: latest.Version,
    architecture: latest.Architecture,
    repositoryPath: latest.Filename,
    sha256: latest.SHA256.toLowerCase(),
    size: Number(latest.Size),
    depends: latest.Depends ?? "",
  };
}

function verifyIndexedFile(filePath, expected, label) {
  const stat = fs.statSync(filePath);
  if (stat.size !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, got ${stat.size}`);
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest();
  const expectedDigest = Buffer.from(expected.sha256, "hex");
  if (actual.length !== expectedDigest.length) {
    throw new Error(`${label} SHA256 mismatch: expected ${expected.sha256}, got ${actual.toString("hex")}`);
  }
  if (!crypto.timingSafeEqual(actual, expectedDigest)) {
    throw new Error(`${label} SHA256 mismatch: expected ${expected.sha256}, got ${actual.toString("hex")}`);
  }
}

async function download(url, destination, timeoutMs = 30000) {
  const requestUrl = new URL(url);
  if (requestUrl.protocol !== "https:") throw new Error(`URL must be https: ${url}`);
  const expectedHost = requestUrl.hostname;
  const response = await fetchWithRetry(url, { redirect: "follow", timeoutMs });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") throw new Error(`Download redirected to non-HTTPS URL (${finalUrl.protocol}) for ${url}`);
  if (finalUrl.hostname !== expectedHost) throw new Error(`Download redirected to unexpected host (${finalUrl.hostname}) for ${url}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_PAYLOAD_BYTES) throw new Error(`Payload too large (${contentLength} bytes) for ${url}`);
  const bytes = await readPayload(response);
  writeFileAtomic(destination, bytes);
}

function verifySigningKey(keyPath, expectedFingerprint) {
  const result = childProcess.spawnSync(
    "gpg", ["--batch", "--show-keys", "--with-colons", keyPath],
    { encoding: "utf8", timeout: 10000, maxBuffer: 1 << 20 },
  );
  if (result.error && result.error.code === "ETIMEDOUT") throw new Error(`Could not inspect pinned signing key: timed out`);
  if (result.status !== 0) throw new Error(`Could not inspect pinned signing key: ${(result.stderr || "").trim()}`);
  const fingerprints = result.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9]);
  if (!fingerprints.includes(expectedFingerprint)) {
    throw new Error(`Pinned signing key does not contain expected fingerprint ${expectedFingerprint}`);
  }
}

function verifyInRelease(inReleasePath, keyPath, expectedFingerprint) {
  verifySigningKey(keyPath, expectedFingerprint);
  // gpgv does not enforce pinned-key expiry/revocation; key rotation must be tracked in-repo.
  const result = childProcess.spawnSync(
    "gpgv", ["--keyring", keyPath, inReleasePath],
    { encoding: "utf8", timeout: 10000, maxBuffer: 1 << 20 },
  );
  if (result.error && result.error.code === "ETIMEDOUT") throw new Error(`InRelease signature verification failed: timed out`);
  if (result.status !== 0) throw new Error(`InRelease signature verification failed: ${(result.stderr || "").trim()}`);
  return extractClearSignedPayload(fs.readFileSync(inReleasePath, "utf8"));
}

function assertReleaseFreshness(payload) {
  // Enforce apt-style freshness on the verified payload: a replayed old
  // signed index must not silently downgrade the resolved package.
  const fields = parseDeb822(payload)[0] ?? {};
  const toTimestamp = (value, field) => {
    if (value == null || value === "") return null;
    const ms = Date.parse(String(value));
    if (Number.isNaN(ms)) throw new Error(`Invalid ${field} in InRelease: ${value}`);
    return ms;
  };
  const now = Date.now();
  const validUntilMs = toTimestamp(fields["Valid-Until"], "Valid-Until");
  if (validUntilMs != null) {
    if (now > validUntilMs) {
      throw new Error(`InRelease expired: Valid-Until ${fields["Valid-Until"]} is in the past`);
    }
    return;
  }
  const dateMs = toTimestamp(fields.Date, "Date");
  if (dateMs == null) throw new Error("InRelease missing Date field; cannot verify freshness");
  const ageDays = (now - dateMs) / (24 * 60 * 60 * 1000);
  if (ageDays > MAX_RELEASE_AGE_DAYS) {
    throw new Error(`InRelease too old: Date ${fields.Date} is more than ${MAX_RELEASE_AGE_DAYS} days old`);
  }
  if (ageDays > WARN_RELEASE_AGE_DAYS) {
    console.warn(`InRelease is ${Math.floor(ageDays)} days old (Date ${fields.Date})`);
  }
}

async function resolveUpstreamPackage(options) {
  if (!/^[a-z0-9][a-z0-9.+_-]*$/.test(options.packageName)) {
    throw new Error(`Unsafe package name: ${options.packageName}`);
  }
  if (!/^[0-9A-Fa-f]{40}$/.test(options.fingerprint)) {
    throw new Error(`Invalid expected key fingerprint: ${options.fingerprint}`);
  }
  const architecture = mapMachineArch(options.architecture);
  const repository = String(options.repository).replace(/\/+$/, "");
  {
    const u = new URL(repository);
    if (u.protocol !== "https:" || u.search || u.hash) throw new Error("URL must be https without query/hash: " + repository);
  }
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const resolvedMeta = path.resolve(options.metadataPath);
  if (!resolvedMeta.startsWith(outputDir + path.sep) && resolvedMeta !== outputDir) {
    throw new Error("metadataPath must be inside outputDir");
  }
  if (options.keyBase64Path) {
    const resolvedKey = path.resolve(options.keyBase64Path);
    const resolvedOut = path.resolve(options.outputDir);
    // The key may live in the tap repository itself (outside the scratch
    // outputDir); derive the repo root from this file's location so the
    // containment check does not depend on the caller's working directory.
    const repoRoot = path.resolve(__dirname, "..", "..");
    const insideOutput = resolvedKey.startsWith(resolvedOut + path.sep) || resolvedKey === resolvedOut;
    const insideRepo = resolvedKey.startsWith(repoRoot + path.sep) || resolvedKey === repoRoot;
    if (!insideOutput && !insideRepo) throw new Error("keyBase64Path must be inside outputDir or the tap repository");
    const stat = fs.statSync(resolvedKey);
    if (!stat.isFile()) throw new Error("keyBase64Path is not a regular file");
    if (stat.size > 1024 * 1024) throw new Error("keyBase64 too large");
  }

  const keyPath = path.join(outputDir, "repository-key.gpg");
  const rawKeyBase64 = fs.readFileSync(options.keyBase64Path, "utf8");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(rawKeyBase64)) throw new Error("keyBase64 contains invalid characters");
  const keyBase64 = rawKeyBase64.replace(/\s+/g, "");
  writeFileAtomic(keyPath, Buffer.from(keyBase64, "base64"));

  const inReleasePath = path.join(outputDir, "InRelease");
  await download(`${repository}/dists/stable/InRelease`, inReleasePath);
  const releasePayload = verifyInRelease(inReleasePath, keyPath, options.fingerprint);
  assertReleaseFreshness(releasePayload);
  const releaseEntries = parseReleaseSha256(releasePayload);
  const packagesRelative = `main/binary-${architecture}/Packages`;
  const indexedPackages = releaseEntries.get(packagesRelative);
  if (!indexedPackages) throw new Error(`Signed InRelease does not index ${packagesRelative}`);

  const packagesPath = path.join(outputDir, `Packages.${architecture}`);
  await download(`${repository}/dists/stable/${packagesRelative}`, packagesPath);
  verifyIndexedFile(packagesPath, indexedPackages, packagesRelative);
  const metadata = selectLatestPackage(
    fs.readFileSync(packagesPath, "utf8"),
    options.packageName,
    architecture,
  );

  let packagePath = null;
  if (!options.metadataOnly) {
    packagePath = path.join(outputDir, `${options.packageName}_${metadata.packageVersion}_${architecture}.deb`);
    await download(`${repository}/${metadata.repositoryPath}`, packagePath, 60000);
    verifyIndexedFile(packagePath, metadata, path.basename(packagePath));
  }
  const result = { ...metadata, repository, path: packagePath };
  writeFileAtomic(options.metadataPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const values = {};
  let metadataOnly = false;
  for (let i = 0; i < args.length;) {
    if (args[i] === "--metadata-only") {
      metadataOnly = true;
      i += 1;
      continue;
    }
    if (!args[i].startsWith("--") || i + 1 >= args.length) {
      throw new Error(`Invalid argument: ${args[i]}`);
    }
    if (Object.prototype.hasOwnProperty.call(values, args[i])) {
      throw new Error(`Duplicate argument: ${args[i]}`);
    }
    values[args[i]] = args[i + 1];
    i += 2;
  }
  for (const flag of ["--output-dir", "--metadata", "--key-base64", "--package", "--fingerprint", "--repository"]) {
    if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
  }
  if (!["amd64", "arm64"].includes(values["--arch"])) {
    throw new Error("--arch must be amd64 or arm64");
  }
  const result = await resolveUpstreamPackage({
    outputDir: values["--output-dir"],
    metadataPath: values["--metadata"],
    keyBase64Path: values["--key-base64"],
    packageName: values["--package"],
    fingerprint: values["--fingerprint"],
    architecture: values["--arch"],
    repository: values["--repository"],
    metadataOnly,
  });
  process.stdout.write(`${result.path ?? values["--metadata"]}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  assertReleaseFreshness,
  compareDebVersions,
  extractClearSignedPayload,
  mapMachineArch,
  normalizeUpstreamVersion,
  parseDeb822,
  parseReleaseSha256,
  resolveUpstreamPackage,
  selectLatestPackage,
  sha256File,
  verifyIndexedFile,
  verifyInRelease,
  verifySigningKey,
};
