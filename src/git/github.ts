/**
 * GitHub — open the pull request, and nothing more.
 *
 * The worker's authority stops at "propose". It can push a `forge/*` branch and
 * open a PR against the base branch; it has no merge path, by construction —
 * there is no call to the merge endpoint anywhere in this service. If a PR for
 * the branch already exists we return it rather than failing, so the operation
 * is idempotent from Conviction's point of view.
 */
import { config } from "./../config.ts";
import { log } from "../logging.ts";
import type { Job } from "../jobs/types.ts";

const API = "https://api.github.com";

function parseRepo(): { owner: string; repo: string } {
  const [owner, repo] = config.repoFullName.split("/");
  if (!owner || !repo) throw new Error(`REPO_FULL_NAME is malformed: ${config.repoFullName}`);
  return { owner, repo };
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "conviction-forge-worker",
    "content-type": "application/json",
  };
}

function prTitle(job: Job): string {
  const firstLine = job.request.split("\n")[0]?.trim() ?? job.request.trim();
  const title = firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
  return title || `Forge change ${job.forgeJobId.slice(0, 8)}`;
}

function prBody(job: Job): string {
  const lines: string[] = [];
  lines.push("Proposed by **Conviction Forge**. Review required — this branch is never auto-merged.");
  lines.push("");
  lines.push(`- Mode: \`${job.mode}\``);
  lines.push(`- Verification profile: \`${job.verificationProfile}\``);
  lines.push(`- Forge job: \`${job.forgeJobId}\``);
  if (job.plan?.summary) {
    lines.push("");
    lines.push("### Plan");
    lines.push(job.plan.summary);
  }
  const passed = job.checks.filter((c) => c.status === "passed").length;
  const failed = job.checks.filter((c) => c.status === "failed").length;
  if (job.checks.length) {
    lines.push("");
    lines.push("### Checks");
    lines.push(`${passed} passed, ${failed} failed, ${job.checks.length} total.`);
    for (const c of job.checks) {
      const mark = c.status === "passed" ? "✅" : c.status === "failed" ? "❌" : "⚪️";
      lines.push(`- ${mark} \`${c.name}\``);
    }
  }
  return lines.join("\n");
}

async function findExistingPr(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const url = new URL(`${API}/repos/${owner}/${repo}/pulls`);
  url.searchParams.set("head", `${owner}:${branch}`);
  url.searchParams.set("state", "open");
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) return null;
  const list = (await res.json()) as { html_url?: string }[];
  return list[0]?.html_url ?? null;
}

/** Create (or find) the pull request for a job's branch. Returns its html URL. */
export async function createPullRequest(job: Job): Promise<{ url: string }> {
  const token = config.githubToken;
  if (!token) throw new Error("GITHUB_TOKEN is not configured — cannot open a pull request.");
  const { owner, repo } = parseRepo();

  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      title: prTitle(job),
      head: job.branchName,
      base: config.baseBranch,
      body: prBody(job),
      maintainer_can_modify: true,
      draft: false,
    }),
  });

  if (res.ok) {
    const pr = (await res.json()) as { html_url: string; number: number };
    log.info("pull request opened", { job: job.id, number: pr.number });
    return { url: pr.html_url };
  }

  // 422 most often means "a pull request already exists for this branch".
  if (res.status === 422) {
    const existing = await findExistingPr(token, owner, repo, job.branchName);
    if (existing) {
      log.info("pull request already existed", { job: job.id });
      return { url: existing };
    }
  }

  const detail = (await res.text()).slice(0, 300);
  throw new Error(`GitHub PR creation failed (${res.status}): ${detail}`);
}
