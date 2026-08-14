/**
 * OpenCode — the coding agent that actually edits files, driven by gstack.
 *
 * Two things this file gets right that the first cut got wrong:
 *
 *   1. `--auto`. `opencode run` does NOT apply file edits without it — it plans
 *      and stops, which is exactly why implementations came back +0/-0. With
 *      `--auto` OpenCode auto-approves the edit/bash/skill permissions and does
 *      the work non-interactively.
 *   2. Global config. gstack installs its skills to `~/.config/opencode/skills`
 *      at image-build time, and the OpenRouter provider config lives beside it.
 *      So we must NOT redirect XDG_CONFIG_HOME/HOME per job (that hid the
 *      skills); only per-job DATA and CACHE are isolated.
 *
 * The OpenRouter key is passed as one env var; the provider config references it
 * by name, so it is never written to the volume.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { log } from "../logging.ts";
import { run, type RunResult } from "../shell.ts";
import type { Job } from "../jobs/types.ts";

const MODEL_PREFIX = process.env.OPENCODE_MODEL_PREFIX ?? "openrouter/";

let availability: boolean | null = null;

/** Is the OpenCode binary present and runnable? Cached after first probe. */
export async function openCodeAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  const r = await run([config.openCodeBin, "--version"], {
    cwd: config.workspaceRoot,
    timeoutMs: 10_000,
  });
  availability = r.code === 0;
  if (!availability) log.warn("opencode binary not available", { bin: config.openCodeBin });
  return availability;
}

/**
 * Per-job environment. Config (the global `~/.config/opencode` with gstack's
 * skills and the OpenRouter provider) is deliberately shared; only data and
 * cache are isolated per job. The provider credential travels as one env var.
 */
async function prepareEnv(job: Job): Promise<Record<string, string>> {
  const home = join(job.workspaceDir, ".agent");
  await mkdir(join(home, "data"), { recursive: true });
  await mkdir(join(home, "cache"), { recursive: true });
  return {
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    OPENROUTER_API_KEY: config.openRouterApiKey ?? undefined,
  } as Record<string, string>;
}

export type OpenCodeResult = RunResult & { model: string };

/** How a non-clean OpenCode run ended — the axis the repair ladder branches on. */
export type ExitKind = "killed" | "timeout" | "missing" | "error";

/**
 * Classify a non-zero OpenCode exit. The worker's own timeout is 124 and a
 * missing/unspawnable binary is 127 (see shell.ts). A code ≥ 128 is death by a
 * signal (128 + N): 137 is SIGKILL, which inside a container is almost always
 * the OOM killer. Anything else is a genuine error exit from the tool itself.
 * Returns null for a clean exit(0).
 */
export function classifyExit(code: number): ExitKind | null {
  if (code === 0) return null;
  if (code === 124) return "timeout";
  if (code === 127) return "missing";
  if (code >= 128) return "killed";
  return "error";
}

/** A killed/timed-out run is worth retrying; a missing tool will not self-fix. */
export function isRetryableExit(code: number): boolean {
  const kind = classifyExit(code);
  return kind !== null && kind !== "missing";
}

/** A human, actionable reason for a non-zero exit — what actually happened. */
export function describeExit(code: number, detail = ""): string {
  const tail = detail.trim() ? ` — ${detail.trim().slice(0, 300)}` : "";
  switch (classifyExit(code)) {
    case "killed":
      return code === 137
        ? `OpenCode was killed (exit 137 = SIGKILL), almost certainly out of memory. The task may be too large for a single pass, or the worker needs more memory.${tail}`
        : `OpenCode was killed by a signal (exit ${code}).${tail}`;
    case "timeout":
      return `OpenCode timed out (exit 124) before finishing.${tail}`;
    case "missing":
      return `OpenCode could not run (exit 127) — its binary or a tool it needs is missing.${tail}`;
    default:
      return `OpenCode exited ${code}.${tail}`;
  }
}

/**
 * Run OpenCode non-interactively against the job's checkout. `--auto` is what
 * makes it actually edit files. The caller commits whatever it changed.
 */
export async function runOpenCode(
  job: Job,
  args: { modelId: string; prompt: string; timeoutMs?: number },
): Promise<OpenCodeResult> {
  const env = await prepareEnv(job);
  const model = `${MODEL_PREFIX}${args.modelId}`;
  const result = await run(
    [config.openCodeBin, "run", "--auto", "--model", model, args.prompt],
    { cwd: job.repoDir, env, timeoutMs: args.timeoutMs ?? 900_000 },
  );
  if (result.code !== 0) {
    log.warn("opencode run non-zero exit", { job: job.id, code: result.code });
  }
  return { ...result, model };
}

/**
 * Run an instruction through gstack, hosted on OpenCode. gstack skills are
 * loaded from the global config; naming them in the prompt is exactly how the
 * gstack docs drive a headless coding session
 * ("Load gstack. Run /autoplan, implement the plan, then run /ship").
 */
export async function runGstack(
  job: Job,
  args: { modelId: string; instruction: string; timeoutMs?: number },
): Promise<OpenCodeResult> {
  return runOpenCode(job, {
    modelId: args.modelId,
    prompt: `Load gstack. ${args.instruction}`,
    timeoutMs: args.timeoutMs,
  });
}
