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
 * Run a gstack operation over the job's checkout with `modelId` as the host
 * model. Returns the skill's output; the caller records it on the job.
 */
export async function runGstackOperation(
  job: Job,
  operation: GstackOperation,
  modelId: string,
): Promise<GstackResult> {
  const command = COMMAND[operation];
  const instruction = [
    `Run ${command} for this change.`,
    `Original request: ${job.request}`,
    "Base your work on the actual files and the current diff in this repository.",
  ].join(" ");

  const result = await runGstack(job, { modelId, instruction, timeoutMs: 600_000 });
  const output = (result.stdout || result.stderr || "").trim();
  return { operation, command, ok: result.code === 0, output, model: result.model };
}
