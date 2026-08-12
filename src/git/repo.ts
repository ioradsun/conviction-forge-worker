/**
 * Git — the isolated checkout, the branch, the diff, the push.
 *
 * Hard rules enforced here, not left to convention:
 *   - Work happens on `forge/<…>` branches only. `main`/`master` (or anything
 *     that fails the branch-name guard) is refused before a single file moves.
 *   - Pushes are plain, never `--force` and never `--force-with-lease`; pushed
 *     history is never rewritten.
 *   - The GitHub token travels in a `GIT_CONFIG_*` env var as an HTTP auth
 *     header, so it is never in a command's argv (invisible to `ps` and to our
 *     own command logging) and never written into `.git/config` on disk.
 *   - Repo-provided hooks are neutralised (`core.hooksPath` → /dev/null): a
 *     clone of untrusted content cannot run code during our git operations.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import type { DiffSummary } from "../contract.ts";
import { log } from "../logging.ts";
import { run, type RunResult } from "../shell.ts";
import type { Job } from "../jobs/types.ts";

const MAX_PATCH_BYTES = 512 * 1024;

/** git-safe, forge-scoped, never the trunk. */
export function assertSafeBranch(branch: string): void {
  if (!/^forge\/[A-Za-z0-9._\-/]+$/.test(branch)) {
    throw new Error(`Refusing unsafe branch name: ${JSON.stringify(branch)}`);
  }
  if (branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new Error(`Refusing malformed branch name: ${JSON.stringify(branch)}`);
  }
  const trunk = new Set(["main", "master", config.baseBranch]);
  const leaf = branch.replace(/^forge\//, "");
  if (trunk.has(branch) || trunk.has(leaf)) {
    throw new Error(`Refusing to operate on a trunk branch: ${branch}`);
  }
}

/**
 * Credentials as an HTTP header, injected through git's env-based config so the
 * token never reaches argv or disk. Empty when no token is configured (public
 * reads still work; push/PR will fail honestly later).
 */
function gitAuthEnv(): Record<string, string> {
  const token = config.githubToken;
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const host = new URL(config.repoUrl).origin; // https://github.com
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${host}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function gitEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitAuthorName,
    GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
    ...extra,
  };
}

async function git(job: Job, args: string[], opts?: { auth?: boolean; timeoutMs?: number }) {
  const env = opts?.auth ? gitEnv(gitAuthEnv()) : gitEnv();
  return run(["git", ...args], { cwd: job.repoDir, env, timeoutMs: opts?.timeoutMs ?? 120_000 });
}

function assertOk(r: RunResult, what: string): RunResult {
  if (r.code !== 0) {
    throw new Error(`${what} failed (exit ${r.code}): ${r.stderr || r.stdout}`.trim());
  }
  return r;
}

/**
 * Clone the repo into an isolated per-job workspace and create the forge
 * branch. Idempotent-ish: if a previous half-clone exists it is removed first.
 */
export async function prepareWorkspace(job: Job): Promise<void> {
  assertSafeBranch(job.branchName);
  await mkdir(job.workspaceDir, { recursive: true });
  await rm(job.repoDir, { recursive: true, force: true });

  const cloneEnv = gitEnv(gitAuthEnv());
  const clone = await withRetry(() =>
    run(
      [
        "git",
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        job.baseBranch,
        config.repoUrl,
        job.repoDir,
      ],
      { cwd: job.workspaceDir, env: cloneEnv, timeoutMs: 300_000 },
    ),
  );
  assertOk(clone, "git clone");

  // Neutralise untrusted hooks and pin identity locally.
  await git(job, ["config", "core.hooksPath", "/dev/null"]);
  await git(job, ["config", "user.name", config.gitAuthorName]);
  await git(job, ["config", "user.email", config.gitAuthorEmail]);

  assertOk(await git(job, ["checkout", "-B", job.branchName]), "git checkout -B");
  log.info("workspace prepared", { job: job.id, branch: job.branchName });
}

/** Stage everything and commit. Returns the commit sha, or null if nothing changed. */
export async function stageAndCommit(job: Job, message: string): Promise<string | null> {
  await git(job, ["add", "-A"]);
  const status = await git(job, ["status", "--porcelain"]);
  if (!status.stdout.trim()) return null;

  const commit = await git(job, ["commit", "-m", message, "--no-verify"]);
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  const sha = (await git(job, ["rev-parse", "HEAD"])).stdout.trim();
  log.info("committed", { job: job.id, sha });
  return sha;
}

const baseRef = () => `origin/${config.baseBranch}`;

/** Number of commits the branch is ahead of base — i.e. real work exists. */
export async function commitsAhead(job: Job): Promise<number> {
  const r = await git(job, ["rev-list", "--count", `${baseRef()}..HEAD`]);
  return r.code === 0 ? Number.parseInt(r.stdout.trim() || "0", 10) : 0;
}

/** Compute the diff of the branch against its base: a summary and a capped patch. */
export async function computeDiff(job: Job): Promise<{ summary: DiffSummary; patch: string }> {
  const numstat = await git(job, ["diff", "--numstat", `${baseRef()}...HEAD`]);
  const files: { path: string; additions: number; deletions: number }[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [addRaw, delRaw, ...rest] = trimmed.split("\t");
    const path = rest.join("\t");
    // Binary files report "-\t-".
    const add = addRaw === "-" ? 0 : Number.parseInt(addRaw ?? "0", 10) || 0;
    const del = delRaw === "-" ? 0 : Number.parseInt(delRaw ?? "0", 10) || 0;
    additions += add;
    deletions += del;
    if (path) files.push({ path, additions: add, deletions: del });
  }

  const patchRun = await git(job, ["diff", `${baseRef()}...HEAD`]);
  let patch = patchRun.stdout;
  if (patch.length > MAX_PATCH_BYTES) {
    patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n…[patch truncated at ${MAX_PATCH_BYTES} bytes]…\n`;
  }

  return {
    summary: { filesChanged: files.length, additions, deletions, files },
    patch,
  };
}

/** Push the forge branch. Never force. Requires a configured token. */
export async function pushBranch(job: Job): Promise<void> {
  assertSafeBranch(job.branchName);
  if (!config.githubToken) throw new Error("GITHUB_TOKEN is not configured — cannot push.");
  const push = await git(
    job,
    ["push", "--set-upstream", "origin", `HEAD:refs/heads/${job.branchName}`],
    { auth: true, timeoutMs: 180_000 },
  );
  assertOk(push, "git push");
  log.info("branch pushed", { job: job.id, branch: job.branchName });
}

async function withRetry<T extends RunResult>(fn: () => Promise<T>): Promise<T> {
  const delays = [2000, 4000, 8000, 16000];
  let last: T | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    last = await fn();
    if (last.code === 0) return last;
    // Only retry on things that look transient (network), not on auth/ref errors.
    const text = `${last.stderr}\n${last.stdout}`.toLowerCase();
    const transient =
      text.includes("could not resolve host") ||
      text.includes("timed out") ||
      text.includes("connection reset") ||
      text.includes("temporary failure") ||
      text.includes("early eof") ||
      text.includes("rpc failed");
    if (!transient || attempt === delays.length) return last;
    const wait = delays[attempt] ?? 16000;
    log.warn("git op failed, retrying", { attempt: attempt + 1, waitMs: wait });
    await new Promise((r) => setTimeout(r, wait));
  }
  return last as T;
}
