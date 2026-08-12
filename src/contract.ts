/**
 * The wire contract — this worker's copy of the vocabulary the Conviction app
 * defines in `belief-compass/src/lib/forge/{worker.server,types}.ts`.
 *
 * These shapes cross the network, so they are duplicated here on purpose: the
 * worker must agree with the client byte-for-byte, and it must not import the
 * app to do so. If the app's contract changes, this file changes with it.
 */

export const FORGE_MODES = ["FAST", "DEBATE", "CRITICAL"] as const;
export type ForgeMode = (typeof FORGE_MODES)[number];

export const VERIFICATION_PROFILE_KEYS = ["ui", "feed", "identity", "money"] as const;
export type VerificationProfileKey = (typeof VERIFICATION_PROFILE_KEYS)[number];

export const GSTACK_OPERATIONS = [
  "office-hours",
  "plan review",
  "engineering review",
  "review",
  "investigate",
  "qa",
  "cso",
  "ship",
] as const;
export type GstackOperation = (typeof GSTACK_OPERATIONS)[number];

/** Body of `POST /jobs`. */
export type CreateJobInput = {
  jobId: string;
  request: string;
  mode: ForgeMode;
  branchName: string;
  verificationProfile: VerificationProfileKey;
  builderModel: string;
  challengerModel: string;
  escalationModel: string;
};

/** Response of `POST /jobs`. */
export type WorkerJobRef = { workerJobId: string };

/** One element of the `POST /jobs/:id/checks` response array. */
export type WorkerCheckResult = {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  outputSummary?: string;
  failureSummary?: string;
};

/** Part of the `GET /jobs/:id/diff` response. */
export type DiffSummary = {
  filesChanged: number;
  additions: number;
  deletions: number;
  files?: { path: string; additions: number; deletions: number }[];
};

/**
 * Verification profiles — mirrored from the app so the worker runs exactly the
 * package.json scripts Conviction expects for a change of a given shape, in
 * order. The worker selects a profile; it does not invent checks.
 */
export type VerificationProfile = {
  key: VerificationProfileKey;
  label: string;
  checks: readonly string[];
  gates?: readonly string[];
};

export const VERIFICATION_PROFILES: Record<VerificationProfileKey, VerificationProfile> = {
  ui: {
    key: "ui",
    label: "UI",
    checks: ["check:types", "lint", "build"],
    gates: ["browser QA"],
  },
  feed: {
    key: "feed",
    label: "Feed & discovery",
    checks: [
      "check:types",
      "check:data-flow",
      "check:opportunities",
      "check:feed-supply",
      "check:feed-archetypes",
      "check:composition",
      "check:insider",
      "build",
    ],
  },
  identity: {
    key: "identity",
    label: "Calibration & identity",
    checks: [
      "check:types",
      "check:positions",
      "check:dna",
      "check:dna-archetypes",
      "check:discovery",
      "check:challenge-integrity",
      "check:composition",
      "build",
    ],
  },
  money: {
    key: "money",
    label: "Money & schema",
    checks: [
      "check:types",
      "check:schema",
      "check:ownership",
      "check:positions",
      "check:market-state",
      "check:data-flow",
      "check:connection",
      "build",
    ],
    gates: ["security review", "premium review"],
  },
};

export function defaultProfileForMode(mode: ForgeMode): VerificationProfileKey {
  return mode === "CRITICAL" ? "money" : mode === "FAST" ? "ui" : "feed";
}

/** Type guards used when validating request bodies from the network. */
export function isForgeMode(v: unknown): v is ForgeMode {
  return typeof v === "string" && (FORGE_MODES as readonly string[]).includes(v);
}
export function isProfileKey(v: unknown): v is VerificationProfileKey {
  return typeof v === "string" && (VERIFICATION_PROFILE_KEYS as readonly string[]).includes(v);
}
export function isGstackOperation(v: unknown): v is GstackOperation {
  return typeof v === "string" && (GSTACK_OPERATIONS as readonly string[]).includes(v);
}
