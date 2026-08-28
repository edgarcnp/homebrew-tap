#!/usr/bin/env node
"use strict";

// Removes the `updateUrl` field from VS Code's `product.json` so the
// built-in updater is disabled (updates come via Homebrew only). Usage:
//   node disable-updater.js <path-to-product.json>
// Fails loudly if the file cannot be read or rewritten.

const fs = require("node:fs");

const path = process.argv[2];
if (!path) {
  console.error("usage: disable-updater.js <product.json path>");
  process.exit(1);
}

const json = JSON.parse(fs.readFileSync(path, "utf8"));
if ("updateUrl" in json) {
  delete json.updateUrl;
  fs.writeFileSync(path, JSON.stringify(json, null, "\t") + "\n");
  console.error("[INFO] Removed updateUrl from product.json");
} else {
  console.error("[INFO] product.json has no updateUrl; updater already disabled");
}
