/**
 * Configuration — read the environment once, in one place.
 *
 * Every other module imports `config` rather than touching `process.env`, so
 * there is a single list of what the worker needs and a single registry of
 * which values are secret. The logger scrubs exactly the strings named here,
 * which is why nothing else is allowed to read a secret out of the environment
 * on its own.
 */

const VERSION = "0.1.0";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function envOr(name: string, fallback: string): string {
  return env(name) ?? fallback;
}

export type Config = {
  version: string;
  /** HTTP */
  host: string;
  port: number;
  /** Auth — the bearer secret Conviction must present. */
  workerSecret: string | null;
  /** OpenRouter — OpenCode's model provider. */
  openRouterApiKey: string | null;
  /** GitHub — push + PR. */
  githubToken: string | null;
  /** Repository under work, e.g. "ioradsun/belief-compass". */
  repoFullName: string;
  repoUrl: string;
  baseBranch: string;
  /** Filesystem root for per-job workspaces. */
  workspaceRoot: string;
  /** Git identity for local commits/merges. */
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** External tools. */
  openCodeBin: string;
  gstackDir: string;
  /** Self-driving mode: drive the pipeline to the next human gate automatically. */
  autopilot: boolean;
  /**
   * Full autonomy: once a plan is finalized, run all the way to an open pull
   * request with no human gate in between — no plan lock, no pre-PR approval.
   * The PR itself stays the one human checkpoint; the worker still never merges.
   * A real check failure still halts (broken code is never proposed).
   */
  autoApprove: boolean;
  /**
   * Self-repair: how many times the Builder is re-run to fix failing checks
   * before the pipeline halts and leaves it for a human. 0 disables self-repair.
   */
  repairAttempts: number;
  /**
   * Infra resilience: how many times a killed or timed-out OpenCode run is
   * retried before giving up. A kill (exit 137) is almost always the OOM killer,
   * so this is deliberately small — retrying the same heavy pass just dies again.
   */
  runRetries: number;
  /** Verification checks the worker actually runs; others are skipped. */
  workerChecks: string[];
};

function boolEnv(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return !["off", "false", "0", "no"].includes(v.toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config: Config = {
  version: VERSION,
  host: envOr("HOST", "0.0.0.0"),
  port: Number.parseInt(envOr("PORT", "8080"), 10),
  workerSecret: env("FORGE_WORKER_SECRET") ?? null,
  openRouterApiKey: env("OPENROUTER_API_KEY") ?? null,
  githubToken: env("GITHUB_TOKEN") ?? null,
  repoFullName: envOr("REPO_FULL_NAME", "ioradsun/belief-compass"),
  get repoUrl() {
    // REPO_URL overrides the derived GitHub URL — for a mirror, GHE host, or a
    // local remote in tests. PR creation still targets REPO_FULL_NAME on github.com.
    return env("REPO_URL") ?? `https://github.com/${this.repoFullName}`;
  },
  baseBranch: envOr("BASE_BRANCH", "main"),
  workspaceRoot: envOr("WORKSPACE_ROOT", "/workspace"),
  gitAuthorName: envOr("GIT_AUTHOR_NAME", "Conviction Forge"),
  gitAuthorEmail: envOr("GIT_AUTHOR_EMAIL", "forge@conviction.company"),
  openCodeBin: envOr("OPENCODE_BIN", "opencode"),
  gstackDir: envOr("GSTACK_DIR", "/opt/gstack"),
  autopilot: boolEnv("FORGE_AUTOPILOT", true),
  autoApprove: boolEnv("FORGE_AUTO_APPROVE", false),
  repairAttempts: intEnv("FORGE_REPAIR_ATTEMPTS", 2),
  runRetries: intEnv("FORGE_RUN_RETRIES", 1),
  // Checks the isolated worker can meaningfully run. The rest (data-integrity
  // checks that need a live DB; the app typecheck, re-run by the PR's own CI)
  // are skipped rather than failed. Override with FORGE_CHECKS="a,b,c".
  workerChecks: envOr("FORGE_CHECKS", "lint,build")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

/** Feature availability — used by /status and by honest degradation. */
export const features = {
  get auth() {
    return Boolean(config.workerSecret);
  },
  get openRouter() {
    return Boolean(config.openRouterApiKey);
  },
  get github() {
    return Boolean(config.githubToken);
  },
};

/**
 * The exact secret strings the logger must never emit. Values only — never the
 * names. Empty/short values are excluded so we don't accidentally scrub common
 * substrings.
 */
export function secretValues(): string[] {
  return [config.workerSecret, config.openRouterApiKey, config.githubToken].filter(
    (v): v is string => typeof v === "string" && v.length >= 6,
  );
}
