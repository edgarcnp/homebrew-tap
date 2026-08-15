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
  if (lines.shift() !== "-----BEGIN PGP SIGNED MESSAGE-----") {
    throw new Error("InRelease is not an OpenPGP clear-signed message");
  }
  while (lines.length > 0 && lines.shift() !== "") {}
  const payload = [];
  for (const line of lines) {
    if (line === "-----BEGIN PGP SIGNATURE-----") break;
    payload.push(line.startsWith("- ") ? line.slice(2) : line);
  }
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
    if (match) entries.set(match[3], { sha256: match[1].toLowerCase(), size: Number(match[2]) });
  }
  return entries;
}

function parseDeb822(source) {
  return String(source).trim().split(/\n\s*\n/).filter(Boolean).map((paragraph) => {
    const fields = {};
    let current = null;
    for (const line of paragraph.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && current) {
        fields[current] += `\n${line.slice(1)}`;
        continue;
      }
      const separator = line.indexOf(":");
      if (separator < 1) throw new Error(`Malformed Packages line: ${line}`);
      current = line.slice(0, separator);
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

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") throw new Error(`Download redirected to non-HTTPS URL (${finalUrl.protocol}) for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
}

function verifySigningKey(keyPath, expectedFingerprint) {
  const result = childProcess.spawnSync(
    "gpg", ["--batch", "--show-keys", "--with-colons", keyPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`Could not inspect pinned signing key: ${result.stderr.trim()}`);
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
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`InRelease signature verification failed: ${result.stderr.trim()}`);
  return extractClearSignedPayload(fs.readFileSync(inReleasePath, "utf8"));
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
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const keyPath = path.join(outputDir, "repository-key.gpg");
  const keyBase64 = fs.readFileSync(options.keyBase64Path, "utf8").replace(/\s+/g, "");
  fs.writeFileSync(keyPath, Buffer.from(keyBase64, "base64"), { mode: 0o600 });

  const inReleasePath = path.join(outputDir, "InRelease");
  await download(`${repository}/dists/stable/InRelease`, inReleasePath);
  const releasePayload = verifyInRelease(inReleasePath, keyPath, options.fingerprint);
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
    await download(`${repository}/${metadata.repositoryPath}`, packagePath);
    verifyIndexedFile(packagePath, metadata, path.basename(packagePath));
  }
  const result = { ...metadata, repository, path: packagePath };
  fs.writeFileSync(options.metadataPath, `${JSON.stringify(result, null, 2)}\n`);
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
