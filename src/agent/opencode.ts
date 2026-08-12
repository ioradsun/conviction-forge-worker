/**
 * OpenCode — the coding agent that actually edits files.
 *
 * OpenCode runs headless (`opencode run`) inside the job's checkout, with
 * OpenRouter as its model provider. Two things keep it bounded:
 *
 *   - Everything it writes outside the repo (config, sessions, cache) is
 *     redirected into the job workspace via HOME and the XDG_* variables, so a
 *     job cannot leave state on the container or read another job's session.
 *   - The OpenRouter key is handed to it by *reference* — the generated config
 *     says `{env:OPENROUTER_API_KEY}` and we pass that one variable — so the
 *     key is never written to a file on the volume.
 *
 * OpenCode's exact flags move between versions; the binary name and the model
 * prefix are the two things that vary, and both are configurable here.
 */
import { mkdir, writeFile } from "node:fs/promises";
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

/** Directory holding this job's agent state, always inside the workspace. */
function agentHome(job: Job): string {
  return join(job.workspaceDir, ".agent");
}

/**
 * Write a per-job OpenCode config selecting the OpenRouter provider, and return
 * the environment that points OpenCode at it while sandboxing its writes.
 */
async function prepareEnv(job: Job): Promise<Record<string, string>> {
  const home = agentHome(job);
  const configDir = join(home, "config");
  const opencodeDir = join(configDir, "opencode");
  await mkdir(opencodeDir, { recursive: true });
  await mkdir(join(home, "data"), { recursive: true });
  await mkdir(join(home, "cache"), { recursive: true });

  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      openrouter: {
        options: { apiKey: "{env:OPENROUTER_API_KEY}" },
      },
    },
  };
  await writeFile(
    join(opencodeDir, "opencode.json"),
    JSON.stringify(opencodeConfig, null, 2),
    "utf8",
  );

  return {
    // Sandbox every place a CLI tends to write.
    HOME: home,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    // The provider credential — by reference from the config above.
    OPENROUTER_API_KEY: config.openRouterApiKey ?? undefined,
  } as Record<string, string>;
}

export type OpenCodeResult = RunResult & { model: string };

/**
 * Run OpenCode non-interactively against the job's checkout with a prompt.
 * The caller is responsible for committing whatever files OpenCode changed.
 */
export async function runOpenCode(
  job: Job,
  args: { modelId: string; prompt: string; timeoutMs?: number },
): Promise<OpenCodeResult> {
  const env = await prepareEnv(job);
  const model = `${MODEL_PREFIX}${args.modelId}`;
  const result = await run(
    [config.openCodeBin, "run", "--model", model, args.prompt],
    { cwd: job.repoDir, env, timeoutMs: args.timeoutMs ?? 600_000 },
  );
  if (result.code !== 0) {
    log.warn("opencode run non-zero exit", { job: job.id, code: result.code });
  }
  return { ...result, model };
}
