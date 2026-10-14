// The failure taxonomy: the classes a failure site raises when it knows whether
// re-running is worth anything. The CLI maps each class to a run-record failure
// code and to an exit code (cli.ts), so the verdict the retry plan reads is
// decided where the failure happened instead of guessed from a message.
//
// A plain Error stays the deliberate catch-all: the run record reports it as
// UNCLASSIFIED, which the retry workflow re-runs within its attempt cap rather
// than dropping a failure nobody classified.

export class UpstreamUnavailableError extends Error {
  // Transport-level hints the retry plan can time a re-run with, e.g.
  // http_status, retry_after_seconds or reason. Strings only: the CLI copies
  // them into the run record's `evidence` object verbatim.
  readonly evidence: Readonly<Record<string, string>>;

  constructor(message: string, evidence: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "UpstreamUnavailableError";
    this.evidence = evidence;
  }
}

// Upstream contradicts itself: the signed index and the file it indexes
// disagree even after a re-read. Transient, unlike ChecksumMismatchError — the
// publisher is mid-republish and the snapshot heals, so the record asks for a
// bounded re-run with a wait instead of a human.
export class UpstreamConflictError extends Error {
  // Same contract as UpstreamUnavailableError's: strings only, copied into the
  // run record's `evidence` object verbatim (e.g. reason for the conflict).
  readonly evidence: Readonly<Record<string, string>>;

  constructor(message: string, evidence: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "UpstreamConflictError";
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
