// The failure taxonomy: the classes a failure site raises when it knows whether
// re-dispatching is worth anything. The CLI maps each class to a run-record
// failure code and to an exit code (cli.ts), so the verdict the API reads is
// decided where the failure happened instead of guessed from a message.
//
// A plain Error stays the deliberate catch-all: the run record reports it as
// UNCLASSIFIED, which retries under the API's global budget rather than
// dropping a failure nobody classified.

export class UpstreamUnavailableError extends Error {
  // Transport-level hints the API can time a re-dispatch with, e.g.
  // http_status, retry_after_seconds or reason. Strings only: the CLI copies
  // them into the run record's `evidence` object verbatim.
  readonly evidence: Readonly<Record<string, string>>;

  constructor(message: string, evidence: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "UpstreamUnavailableError";
    this.evidence = evidence;
  }
}

// A permanent, deliberate refusal: an allow-list, HTTPS or size guard tripped.
// Re-running the same build changes nothing, so the record says so.
export class GuardViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardViolationError";
  }
}

// The upstream served bytes that do not match what the caller pinned. Also
// permanent: the same download cannot start matching on its own.
export class ChecksumMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksumMismatchError";
  }
}

// A declared updater endpoint survived neutralization. Permanent for the same
// reason as a guard violation: the artifact, not the runner, needs fixing.
export class UpdaterResidualError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdaterResidualError";
  }
}
