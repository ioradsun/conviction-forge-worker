/**
 * The worker's own view of a job. Richer than the wire contract: it carries the
 * filesystem locations, the running plan, the objection ledger, the check
 * results and the event log that `GET /jobs/:id` exposes as `detail`.
 */
import type {
  DiffSummary,
  ForgeMode,
  GstackOperation,
  VerificationProfileKey,
} from "../contract.ts";

/**
 * The worker's status vocabulary. Distinct from the app's ForgeStatus: the
 * Conviction server owns the authoritative pipeline state, and reads this only
 * to observe progress. Every value is a plain string on the wire.
 */
export type WorkerJobStatus =
  | "created"
  | "cloning"
  | "ready"
  | "analyzing"
  | "planning"
  | "debating"
  | "revising"
  | "plan_locked"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "qa"
  | "ready_for_human"
  | "creating_pr"
  | "pr_created"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: readonly WorkerJobStatus[] = [
  "completed",
  "failed",
  "cancelled",
] as const;

export type EventLevel = "info" | "warn" | "error" | "success";
export type EventRole = "builder" | "challenger" | "escalation" | "system" | "human";

export type JobEvent = {
  ts: string;
  level: EventLevel;
  role: EventRole;
  kind: string;
  message: string;
  detail?: unknown;
};

export type Plan = {
  summary: string;
  steps?: string[];
  acceptanceCriteria?: string[];
  filesTouched?: string[];
  risks?: string[];
  confidence?: number;
  /** Raw model text, kept for audit when structured parsing is partial. */
  raw?: string;
};

export type ObjectionSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ObjectionStatus = "open" | "resolved" | "maintained" | "waived";

export type Objection = {
  id: string;
  round: number;
  severity: ObjectionSeverity;
  title: string;
  body: string | null;
  status: ObjectionStatus;
  createdAt: string;
};

/**
 * A check row while/after it runs. Its status is richer than the wire
 * WorkerCheckResult (which only knows passed/failed/skipped) so the live view
 * can show pending and running; only resolved rows are mapped onto the wire.
 */
export type CheckStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type CheckRecord = {
  name: string;
  command: string;
  status: CheckStatus;
  durationMs: number;
  outputSummary?: string;
  failureSummary?: string;
  position: number;
  startedAt: string | null;
  completedAt: string | null;
};

export type CostLedger = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type Job = {
  /** The worker's own handle, returned as workerJobId. */
  id: string;
  /** The Conviction job id from CreateJobInput.jobId. */
  forgeJobId: string;
  request: string;
  mode: ForgeMode;
  branchName: string;
  baseBranch: string;
  verificationProfile: VerificationProfileKey;
  builderModel: string;
  challengerModel: string;
  escalationModel: string;

  status: WorkerJobStatus;
  phase: string | null;

  workspaceDir: string;
  repoDir: string;

  plan: Plan | null;
  planLockedAt: string | null;
  objections: Objection[];
  checks: CheckRecord[];
  lastGstackOperation: GstackOperation | null;
  diffSummary: DiffSummary | null;
  previewUrl: string | null;
  prUrl: string | null;
  cost: CostLedger;
  error: string | null;
  events: JobEvent[];

  createdAt: string;
  updatedAt: string;
};

export function isTerminal(status: WorkerJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
