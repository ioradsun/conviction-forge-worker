/**
 * gstack — the operation vocabulary, run through OpenCode.
 *
 * gstack (github.com/garrytan/gstack) installs ~30 skills into OpenCode at
 * `~/.config/opencode/skills/gstack-*` via `./setup --host opencode`. They are
 * invoked as slash-commands. The documented way to drive them headlessly is to
 * name the command in the prompt of a spawned session — e.g. "Load gstack. Run
 * /review" — which is exactly what `runGstack` does.
 *
 * Forge names an operation; this maps it to the gstack command that plays that
 * role and returns the skill's output.
 */
import type { GstackOperation } from "../contract.ts";
import type { Job } from "../jobs/types.ts";
import { runGstack } from "./opencode.ts";

/** Forge operation → gstack slash-command. */
const COMMAND: Record<GstackOperation, string> = {
  "office-hours": "/office-hours",
  "plan review": "/plan-ceo-review",
  "engineering review": "/plan-eng-review",
  review: "/review",
  investigate: "/investigate",
  qa: "/qa",
  cso: "/cso",
  ship: "/ship",
};

export type GstackResult = {
  operation: GstackOperation;
  command: string;
  ok: boolean;
  output: string;
  model: string;
};

/**
 * The bar a review must hold a change to. Appended to the review operations so
 * a plausible-looking but valueless diff — the classic being speculative React
 * memoization that changes nothing — is rejected rather than waved through.
 * Deterministic checks cannot catch this class of defect; only the review can.
 */
export const REVIEW_RUBRIC = [
  "Hold the change to this bar and REJECT what fails it:",
  "- Value: it must solve a real, stated problem. A diff that changes no observable behaviour and carries no measurement is a failure, not a success — reject it and say why.",
  "- Performance and refactor claims need proof, not plausibility: demand the measured problem (a profile, a benchmark, or a reproduced slow path with numbers) and a before/after figure. No numbers means no evidence — reject.",
  "- Memoization must actually work: React.memo does nothing when the component still receives new-identity props each render (an inline arrow or object at the call site defeats it); useCallback/useMemo does nothing when the value is only used inline in the same render and never reaches a memoized child or a hook dependency. Treat speculative memo/useCallback/useMemo, caches, indexes, and abstractions as no-ops and reject them.",
  "- Scope and safety: no unrelated churn, and never weaken or delete tests to make something pass.",
].join("\n");

/** Operations that read a diff for quality, where the rubric applies. */
const REVIEW_OPERATIONS: ReadonlySet<GstackOperation> = new Set([
  "review",
  "engineering review",
]);

/**
 * Run a gstack operation over the job's checkout with `modelId` as the host
 * model. Returns the skill's output; the caller records it on the job.
 */
export async function runGstackOperation(
  job: Job,
  operation: GstackOperation,
  modelId: string,
): Promise<GstackResult> {
  const command = COMMAND[operation];
  const base = [
    `Run ${command} for this change.`,
    `Original request: ${job.request}`,
    "Base your work on the actual files and the current diff in this repository.",
  ].join(" ");
  const instruction = REVIEW_OPERATIONS.has(operation) ? `${base}\n\n${REVIEW_RUBRIC}` : base;

  const result = await runGstack(job, { modelId, instruction, timeoutMs: 600_000 });
  const output = (result.stdout || result.stderr || "").trim();
  return { operation, command, ok: result.code === 0, output, model: result.model };
}
