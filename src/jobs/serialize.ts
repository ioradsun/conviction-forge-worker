/**
 * The `detail` payload of `GET /jobs/:id`.
 *
 * Everything the Forge UI needs to render a job without a second round trip:
 * where it is, what the plan says, what the Challenger objected to, how the
 * checks went, and the diff shape. `stalled` is the honest flag for a
 * transient status left behind by a worker restart.
 */
import { store } from "./store.ts";
import type { Job } from "./types.ts";

const RECENT_EVENTS = 60;

export function detailOf(job: Job) {
  return {
    workerJobId: job.id,
    forgeJobId: job.forgeJobId,
    request: job.request,
    mode: job.mode,
    status: job.status,
    phase: job.phase,
    stalled: store.isStalled(job.id),
    running: store.isRunning(job.id),
    branchName: job.branchName,
    baseBranch: job.baseBranch,
    verificationProfile: job.verificationProfile,
    models: {
      builder: job.builderModel,
      challenger: job.challengerModel,
      escalation: job.escalationModel,
    },
    plan: job.plan,
    planLockedAt: job.planLockedAt,
    objections: job.objections,
    checks: job.checks,
    lastGstackOperation: job.lastGstackOperation,
    diffSummary: job.diffSummary,
    previewUrl: job.previewUrl,
    prUrl: job.prUrl,
    cost: job.cost,
    error: job.error,
    events: job.events.slice(-RECENT_EVENTS),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
