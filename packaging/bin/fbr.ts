#!/usr/bin/env node
// Entry point for the packaging CLI. Runs directly on Node (type stripping),
// so the repository needs no build step and no runtime dependencies.

import { isUsageError, runCli } from "../lib/cli.ts";

// Piping into a pager or head closes stdout early; that is not a failure.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(1);
});

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = isUsageError(error) ? 2 : 1;
}
