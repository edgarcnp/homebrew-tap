#!/usr/bin/env node
// Entry point for the packaging CLI. Node's native type stripping runs the
// TypeScript directly, so the repository needs no build step and no runtime
// dependencies.

import { errorExitCode, runCli } from "../lib/cli.ts";

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
  // 2 for usage errors, 3-6 for classified failures, 1 for everything else;
  // the workflow passes the code through and reads the verdict from the
  // fragment when --failure-out was given.
  process.exitCode = errorExitCode(error);
}
