/**
 * gstack — the operation vocabulary, run through the OpenCode host.
 *
 * gstack is installed in the container against OpenCode (`./setup --host
 * opencode`) and exposes the operations Conviction names: plan review,
 * engineering review, review, investigate, qa, cso, ship, office-hours. Forge
 * asks for an operation by name; this module turns that name into a bounded
 * agent pass over the current checkout and returns the review text.
 *
 * The wiring point is deliberately one function: whether an operation is driven
 * by the gstack CLI or by an OpenCode prompt carrying the operation's intent,
 * callers upstream never change.
 */
import type { GstackOperation } from "../contract.ts";
import type { Job } from "../jobs/types.ts";
import { runOpenCode } from "./opencode.ts";

/**
 * What each operation asks the host agent to do. Read-only by intent except
 * where the operation is explicitly a fix pass ("ship" prepares, it does not
 * merge — merging is never the worker's move).
 */
const OPERATION_INTENT: Record<GstackOperation, string> = {
  "office-hours":
    "Act as an office-hours reviewer. Answer open questions about this change and surface anything the author may have missed. Do not edit files.",
  "plan review":
    "Review the proposed plan against the repository. Is it the smallest correct change? Does it reuse existing mechanisms instead of inventing new ones? List concrete objections. Do not edit files.",
  "engineering review":
    "Perform an engineering review of the current diff: correctness, drift from existing patterns, hidden regressions, and simpler implementations. List findings by severity. Do not edit files.",
  review:
    "Review the current diff for defects and unnecessary complexity. Report concrete, file-anchored findings. Do not edit files.",
  investigate:
    "Investigate the current change and the surrounding code to answer whether it is safe and complete. Report findings. Do not edit files.",
  qa: "Act as QA for this change. Enumerate the user-visible behaviours it affects and how to exercise them. Report risks. Do not edit files.",
  cso: "Act as a chief security officer. Audit the current diff for security-sensitive changes: authz, secrets, money/schema/permission logic, injection. Report findings by severity. Do not edit files.",
  ship: "Prepare this change for shipping: confirm the diff is coherent and the branch is clean. Do NOT merge and do NOT push. Report readiness only.",
};

export type GstackResult = {
  operation: GstackOperation;
  ok: boolean;
  output: string;
  model: string;
};

/**
 * Run a gstack operation over the job's checkout using `modelId` as the host
 * model. Returns the review text; the caller records it on the job.
 */
export async function runGstackOperation(
  job: Job,
  operation: GstackOperation,
  modelId: string,
): Promise<GstackResult> {
  const intent = OPERATION_INTENT[operation];
  const prompt = [
    `You are running the gstack "${operation}" operation for the Conviction Forge worker.`,
    intent,
    "",
    `Original request: ${job.request}`,
    "",
    "Base your review on the actual files and the current diff in this repository.",
  ].join("\n");

  const result = await runOpenCode(job, { modelId, prompt, timeoutMs: 420_000 });
  const output = (result.stdout || result.stderr || "").trim();
  return { operation, ok: result.code === 0, output, model: result.model };
}
