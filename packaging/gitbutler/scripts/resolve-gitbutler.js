#!/usr/bin/env node
"use strict";

// Resolver for GitButler's Linux .deb releases: the app.gitbutler.com
// redirect is the only version source (no signed apt repo or GitHub
// release). The payload is hashed on download; --metadata-only resolves
// the URL and version without downloading the .deb.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeUpstreamVersion,
} = require(path.join(__dirname, "..", "..", "lib", "upstream-linux-package.js"));

// Cap on payload bytes: upstream .debs are ~100 MiB; a broken or malicious
// redirect serving a huge body must fail instead of exhausting memory.
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

// Pin to releases.gitbutler.com to prevent open redirect to attacker-controlled host
const ALLOWED_HOSTS = new Set(["releases.gitbutler.com"]);
const ALLOWED_INIT_HOSTS = new Set(["app.gitbutler.com"]);

async function fetchWithRetry(url, opts, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, opts);
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries - 1) {
          const retryAfter = response.headers.get("retry-after");
          let delay = 100 * Math.pow(2, attempt);
          if (retryAfter) {
            const secs = Number(retryAfter);
            if (!Number.isNaN(secs)) delay = secs * 1000;
            else {
              const date = Date.parse(retryAfter);
              if (!Number.isNaN(date)) delay = Math.max(0, date - Date.now());
            }
          }
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      return response;
    } catch (e) {
      lastError = e;
      if (attempt < retries - 1) {
        const delay = 100 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

function writeFileAtomic(filePath, data) {
  const tmp = filePath + ".tmp." + crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function sha256Buffer(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Assumed upstream URL layout (live-verified 2026-08, both architectures):
//   GET <repository>/<archPath>/deb                    (302 redirect)
//   -> https://releases.gitbutler.com/releases/release/<version>[-<build>]/linux/<archPath>/GitButler_<version>_<debArch>.deb
// parseFinalUrl validates exactly that shape, so an upstream layout change
// fails loudly instead of producing a wrong download.
async function fetchFollowRedirects(url) {
  const initial = new URL(url);
  if (initial.protocol !== "https:") throw new Error(`Initial URL must be https (got ${initial.protocol}) for ${url}`);
  // Abort slow/stalled downloads (30s or 60s) instead of hanging indefinitely
  const response = await fetchWithRetry(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload too large (Content-Length ${declaredLength}) for ${url}`);
  }
  const finalHost = new URL(response.url).hostname;
  if (!ALLOWED_HOSTS.has(finalHost)) throw new Error(`Unexpected redirect host (${finalHost}) for ${response.url}`);
  return response;
}

async function readPayload(response) {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error(`Payload too large (${bytes.length} bytes) for ${response.url}`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`Payload exceeds size cap (${MAX_PAYLOAD_BYTES} bytes) for ${response.url}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseFinalUrl(finalUrl) {
  const url = new URL(finalUrl);
  if (url.protocol !== "https:") throw new Error(`Redirected to non-HTTPS URL (${url.protocol}) for ${finalUrl}`);
  // Pin to releases.gitbutler.com to prevent open redirect to attacker-controlled host
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`Unexpected redirect host (${url.hostname}) for ${finalUrl}`);
  const segments = url.pathname.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] ?? "";
  const archPath = segments[segments.length - 2] ?? "";
  const release = segments[segments.length - 4] ?? "";
  const releaseMatch = /^[0-9][0-9A-Za-z.+~]*(?:-[0-9]+)?$/.test(release);
  if (releaseMatch === false) throw new Error(`Unrecognized release segment: ${release}`);
  const fileNameMatch = fileName.match(/^GitButler_(.+)_(amd64|arm64)\.deb$/);
  if (!fileNameMatch) throw new Error(`Unrecognized .deb filename: ${fileName}`);
  const fileVersion = fileNameMatch[1];
  if (!/^[0-9][0-9A-Za-z.+~]*$/.test(fileVersion)) throw new Error(`Unsafe .deb version: ${fileVersion}`);
  if (fileVersion !== normalizeUpstreamVersion(release)) {
    throw new Error(`Release version ${release} does not match filename version ${fileVersion}`);
  }
  return {
    repository: url.origin,
    repositoryPath: url.pathname.slice(1),
    archPath,
    fileName,
    fileVersion,
    releaseVersion: release,
  };
}

async function resolveGitButlerPackage(options) {
  const architecture = String(options.architecture).trim().toLowerCase();
  let archPath;
  let debArch;
  if (architecture === "amd64") {
    archPath = "x86_64";
    debArch = "amd64";
  } else if (architecture === "arm64") {
    archPath = "aarch64";
    debArch = "arm64";
  } else {
    throw new Error(`Unsupported architecture '${architecture}'; GitButler packages support amd64 and arm64 only`);
  }

  let repository = String(options.repository).replace(/\/+$/, "");
  try {
    const u = new URL(repository);
    if (u.protocol !== "https:") throw new Error(`Repository must be https (got ${u.protocol}) for ${repository}`);
    if (u.search || u.hash) throw new Error(`Repository must not contain query or hash for ${repository}`);
    repository = u.origin + u.pathname.replace(/\/+$/, "");
    if (!ALLOWED_INIT_HOSTS.has(new URL(repository).hostname)) throw new Error("unexpected repository host");
  } catch (e) {
    if (e.message.includes("Repository must be https") || e.message.includes("Repository must not contain") || e.message.includes("unexpected repository host")) throw e;
    throw new Error(`Invalid repository URL (${repository}): ${e.message}`);
  }
  // Validate RESOLVE_BASE_URL if present - must be https to prevent downgrade via env override
  if (process.env.RESOLVE_BASE_URL) {
    try {
      const base = new URL(process.env.RESOLVE_BASE_URL);
      if (base.protocol !== "https:") throw new Error(`RESOLVE_BASE_URL must be https (got ${base.protocol}) for ${process.env.RESOLVE_BASE_URL}`);
    } catch (e) {
      if (e.message.includes("RESOLVE_BASE_URL must be https")) throw e;
      throw new Error(`Invalid RESOLVE_BASE_URL (${process.env.RESOLVE_BASE_URL}): ${e.message}`);
    }
  }
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const resolvedMeta = path.resolve(options.metadataPath);
  const resolvedOut = path.resolve(options.outputDir);
  if (!resolvedMeta.startsWith(resolvedOut + path.sep) && resolvedMeta !== resolvedOut) throw new Error("metadataPath must be inside outputDir");

// The redirect target URL is the version source; metadata-only mode
// downloads the payload to compute the SHA-256 (the CDN publishes no
// checksums) but discards the bytes instead of writing them to disk.
  const response = await fetchFollowRedirects(`${repository}/${archPath}/deb`);
  const parsed = parseFinalUrl(response.url);
  if (parsed.archPath !== archPath) {
    throw new Error(`Redirect arch ${parsed.archPath} does not match requested ${archPath}`);
  }

  const version = normalizeUpstreamVersion(parsed.releaseVersion);
  let sha256 = "";
  let size = null;
  let packagePath = null;
  {
    const len = Number(response.headers.get("content-length") || 0);
    if (len > MAX_PAYLOAD_BYTES) throw new Error(`Payload too large (Content-Length ${len}) for ${response.url}`);
  }
  if (!options.metadataOnly) {
    const bytes = await readPayload(response);
    sha256 = sha256Buffer(bytes);
    size = bytes.length;
    packagePath = path.join(outputDir, `git-butler_${version}_${debArch}.deb`);
    writeFileAtomic(packagePath, bytes);
    const onDisk = sha256Buffer(fs.readFileSync(packagePath));
    if (onDisk !== sha256) {
      throw new Error(`Downloaded .deb SHA256 mismatch after write: got ${onDisk}, expected ${sha256}`);
    }
  } else {
    // The CDN publishes no checksums, so the SHA-256 must be computed from
    // the payload itself; download and hash it, then discard the bytes.
    const bytes = await readPayload(response);
    sha256 = sha256Buffer(bytes);
    size = bytes.length;
  }
  const result = {
    package: "git-butler",
    version,
    packageVersion: version,
    architecture: debArch,
    repositoryPath: parsed.repositoryPath,
    sha256,
    size,
    repository: parsed.repository,
    path: packagePath,
  };
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
    values[args[i]] = args[i + 1];
    i += 2;
  }
  // GitButler publishes no signed apt repository, so there is no key to pin;
  // the shared workflow may still pass --key-base64 (empty), which is
  // tolerated and unused.
  for (const flag of ["--output-dir", "--metadata", "--repository"]) {
    if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
  }
  if (!["amd64", "arm64"].includes(values["--arch"])) {
    throw new Error("--arch must be amd64 or arm64");
  }
  const result = await resolveGitButlerPackage({
    outputDir: values["--output-dir"],
    metadataPath: values["--metadata"],
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
  fetchFollowRedirects,
  normalizeUpstreamVersion,
  parseFinalUrl,
  readPayload,
  resolveGitButlerPackage,
  sha256Buffer,
};