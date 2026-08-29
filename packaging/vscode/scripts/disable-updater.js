#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const target = process.argv[2];
if (!target) {
  console.error("usage: disable-updater.js <product.json path or code directory>");
  process.exit(1);
}

const stat = fs.statSync(target);

if (stat.isFile()) {
  // Legacy: single product.json file
  const json = JSON.parse(fs.readFileSync(target, "utf8"));
  let changed = false;
  if ("updateUrl" in json) {
    delete json.updateUrl;
    changed = true;
  }
  if ("checksums" in json) {
    delete json.checksums;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(target, JSON.stringify(json, null, "\t") + "\n");
    console.error("[INFO] Removed updateUrl/checksums from product.json");
  } else {
    console.error("[INFO] product.json has no updateUrl or checksums; updater already disabled");
  }
} else if (stat.isDirectory()) {
  // Directory mode: patch product.json + replace hardcoded endpoint in all files
  const productJsonPath = path.join(target, "resources", "app", "product.json");
  if (fs.existsSync(productJsonPath)) {
    const json = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
    let changed = false;
    if ("updateUrl" in json) {
      delete json.updateUrl;
      changed = true;
    }
    if ("checksums" in json) {
      delete json.checksums;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(productJsonPath, JSON.stringify(json, null, "\t") + "\n");
      console.error("[INFO] Removed updateUrl/checksums from product.json");
    }
  }

  // Replace hardcoded updater endpoint in all files under the directory.
  // Text files get a short, inert hostname; ELF binaries must get a
  // same-length replacement or the ELF structure is corrupted.
  const from = "update.code.visualstudio.com";
  const toText = "update.invalid";                  // shorter -- safe for text
  const toBinary = "update.invalidupdate.invalid";  // same length -- safe for ELF
  if (from.length !== toBinary.length) {
    console.error(
      `[ERROR] endpoint patch length mismatch: ${from.length} vs ${toBinary.length}; refusing to corrupt ELF`,
    );
    process.exit(1);
  }
  const fromBuf = Buffer.from(from, "utf8");
  const toTextBuf = Buffer.from(toText, "utf8");
  const toBinaryBuf = Buffer.from(toBinary, "utf8");
  // ELF magic number (0x7f 'E' 'L' 'F'): every ELF executable/shared library
  // starts with these 4 bytes. Detected by offset rather than the older
  // "any NUL byte = binary" heuristic, which misclassified NUL-free binaries
  // as text and corrupted them with the short replacement.
  const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

  let replacedCount = 0;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const buf = fs.readFileSync(fullPath);
          if (!buf.includes(fromBuf)) continue;

          const isBinary = buf.indexOf(ELF_MAGIC) === 0;
          const toBuf = isBinary ? toBinaryBuf : toTextBuf;

          const chunks = [];
          let last = 0;
          let idx;
          while ((idx = buf.indexOf(fromBuf, last)) !== -1) {
            chunks.push(buf.subarray(last, idx));
            chunks.push(toBuf);
            last = idx + fromBuf.length;
          }
          chunks.push(buf.subarray(last));
          const updated = Buffer.concat(chunks);
          fs.writeFileSync(fullPath, updated);
          replacedCount++;
          console.error(`[INFO] Patched: ${fullPath}`);
        } catch (err) {
          console.error(`[WARN] Could not patch ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  walk(target);

  if (replacedCount > 0) {
    console.error(`[INFO] Patched ${replacedCount} file(s) with updated endpoint`);
  } else {
    console.error("[INFO] No files contained the updater endpoint");
  }
}