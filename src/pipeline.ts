/**
 * The pipeline — every phase the worker actually performs.
 *
 * These functions are what the HTTP endpoints spawn as background work. Two
 * disciplines run through all of them, inherited from the app they serve:
 *
 *   - Honesty over plausibility. If a credential or tool is missing, the phase
 *     records a clear, named reason and stops. It never invents a plan, a
 *     passing check, or a diff — a fabricated result is worse than a missing
 *     one because it is believed.
 *   - Observability. Status, phase, plan, objections, checks and a diff summary
 *     are written to the store as they happen, so `GET /jobs/:id` always
 *     reflects real state.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  VERIFICATION_PROFILES,
  type GstackOperation,
  type VerificationProfileKey,
  type WorkerCheckResult,
} from "./contract.ts";
import { log } from "./logging.ts";
import { run } from "./shell.ts";
import { store } from "./jobs/store.ts";
import type { Job, Plan, WorkerJobStatus } from "./jobs/types.ts";
import { callModel, extractJson, openRouterConfigured } from "./agent/openrouter.ts";
import { openCodeAvailable, runOpenCode } from "./agent/opencode.ts";
import { runGstackOperation } from "./agent/gstack.ts";
import { commitsAhead, computeDiff, prepareWorkspace, pushBranch, stageAndCommit } from "./git/repo.ts";
import { createPullRequest } from "./git/github.ts";

/* ── small helpers ─────────────────────────────────────────────────────────*/

async function note(
  job: Job,
  level: "info" | "warn" | "error" | "success",
  role: "builder" | "challenger" | "escalation" | "system" | "human",
  kind: string,
  message: string,
  detail?: unknown,
) {
  await store.addEvent(job.id, { level, role, kind, message, detail });
}

async function addCost(job: Job, inputTokens: number, outputTokens: number) {
  await store.update(job.id, (j) => {
    j.cost.inputTokens += inputTokens;
    j.cost.outputTokens += outputTokens;
  });
}

/** Set a resting status/phase — but never revive a job cancelled mid-flight. */
function settle(j: Job, status: WorkerJobStatus, phase: string) {
  if (j.status === "cancelled" || j.status === "completed") return;
  j.status = status;
  j.phase = phase;
}

/** Record a phase that could not run because something is not configured. */
async function notConfigured(job: Job, reason: string) {
  await store.update(job.id, (j) => {
    j.error = reason;
    if (j.status !== "cancelled" && j.status !== "completed") j.status = "ready";
  });
  await note(job, "warn", "system", "phase.skipped", reason);
}

/** A compact, safe snapshot of the repository for reasoning prompts. */
async function repoContext(job: Job): Promise<string> {
  const parts: string[] = [];
  const tree = await run(["git", "ls-files"], { cwd: job.repoDir, timeoutMs: 30_000 });
  if (tree.code === 0) {
    const files = tree.stdout.split("\n").filter(Boolean);
    const top = new Map<string, number>();
    for (const f of files) {
      const seg = f.split("/")[0] ?? f;
      top.set(seg, (top.get(seg) ?? 0) + 1);
    }
    const summary = [...top.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([dir, n]) => `${dir} (${n})`)
      .join(", ");
    parts.push(`Repository top level: ${summary}`);
    parts.push(`Total tracked files: ${files.length}`);
  }
  for (const name of ["README.md", "package.json"]) {
    try {
      const content = await readFile(join(job.repoDir, name), "utf8");
      parts.push(`\n----- ${name} (first 2KB) -----\n${content.slice(0, 2048)}`);
    } catch {
      /* optional */
    }
  }
  return parts.join("\n");
}

/* ── clone ─────────────────────────────────────────────────────────────────*/

export async function performClone(job: Job): Promise<void> {
  store.markRunning(job.id);
  try {
    if (!(await store.advance(job.id, "cloning", "analyze"))) return;
    await note(job, "info", "system", "clone.start", `Cloning ${job.branchName}…`);
    await prepareWorkspace(job);
    await store.advance(job.id, "ready", "analyze");
    await note(job, "success", "system", "clone.done", "Checkout ready on the forge branch.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.update(job.id, (j) => {
      if (j.status !== "cancelled" && j.status !== "completed") j.status = "failed";
      j.error = message;
    });
    await note(job, "error", "system", "clone.failed", message);
  } finally {
    store.markStopped(job.id);
  }
}

/* ── builder plan ──────────────────────────────────────────────────────────*/

function parsePlan(text: string): Plan {
  const parsed = extractJson(text) as Partial<Plan> | null;
  if (parsed && typeof parsed.summary === "string") {
    return {
      summary: parsed.summary,
      steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : undefined,
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
        ? parsed.acceptanceCriteria.map(String)
        : undefined,
      filesTouched: Array.isArray(parsed.filesTouched)
        ? parsed.filesTouched.map(String)
        : undefined,
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      raw: text,
    };
  }
  return { summary: text.slice(0, 2000), raw: text };
}

export async function performBuilder(job: Job, instruction?: string): Promise<void> {
  store.markRunning(job.id);
  try {
    if (!(await store.advance(job.id, job.plan ? "revising" : "planning", "plan"))) return;
    if (!openRouterConfigured()) return void (await notConfigured(job, "OPENROUTER_API_KEY is not configured — Builder cannot run."));

    const context = await repoContext(job);
    const messages = [
      {
        role: "system" as const,
        content:
          "You are the Builder for Conviction Forge. Produce the SMALLEST complete plan that satisfies the request, reusing existing mechanisms before inventing new ones. Reply with a single JSON object: {summary, steps[], acceptanceCriteria[], filesTouched[], risks[], confidence(0..1)}.",
      },
      {
        role: "user" as const,
        content: [
          `Request: ${job.request}`,
          instruction ? `\nHuman revision note: ${instruction}` : "",
          job.plan ? `\nPrevious plan summary: ${job.plan.summary}` : "",
          `\n${context}`,
        ].join("\n"),
      },
    ];

    const res = await callModel(job.builderModel, messages, { maxTokens: 4096 });
    await addCost(job, res.inputTokens, res.outputTokens);
    const plan = parsePlan(res.text);
    await store.update(job.id, (j) => {
      j.plan = plan;
      j.error = null;
      settle(j, "ready", "plan");
    });
    await note(job, "success", "builder", "plan.ready", plan.summary.slice(0, 200), {
      model: res.modelId,
    });
  } catch (err) {
    await failStep(job, "builder.failed", err);
  } finally {
    store.markStopped(job.id);
  }
}

/* ── challenger debate ─────────────────────────────────────────────────────*/

export async function performChallenger(job: Job): Promise<void> {
  store.markRunning(job.id);
  try {
    if (!(await store.advance(job.id, "debating", "debate"))) return;
    if (!openRouterConfigured()) return void (await notConfigured(job, "OPENROUTER_API_KEY is not configured — Challenger cannot run."));
    if (!job.plan) return void (await notConfigured(job, "No plan to challenge — run the Builder first."));

    const round =
      job.objections.reduce((max, o) => Math.max(max, o.round), 0) + 1;
    const context = await repoContext(job);
    const messages = [
      {
        role: "system" as const,
        content:
          "You are the Challenger for Conviction Forge. Prove the Builder's plan wrong: duplicate mechanisms, drift, hidden regressions, simpler implementations. Reply with a single JSON object {objections:[{severity:'CRITICAL'|'HIGH'|'MEDIUM'|'LOW', title, body}]}. Empty array means the plan survives.",
      },
      {
        role: "user" as const,
        content: `Request: ${job.request}\n\nPlan:\n${JSON.stringify(job.plan, null, 2)}\n\n${context}`,
      },
    ];

    const res = await callModel(job.challengerModel, messages, { maxTokens: 3072, temperature: 0.2 });
    await addCost(job, res.inputTokens, res.outputTokens);

    const parsed = extractJson(res.text) as { objections?: unknown[] } | null;
    const rawList = Array.isArray(parsed?.objections) ? parsed!.objections : [];
    const created = rawList
      .map((o, i) => normalizeObjection(o, round, i))
      .filter((o): o is Job["objections"][number] => o !== null);

    await store.update(job.id, (j) => {
      j.objections.push(...created);
      j.error = null;
      settle(j, "ready", "debate");
    });
    await note(
      job,
      created.some((o) => o.severity === "CRITICAL" || o.severity === "HIGH") ? "warn" : "success",
      "challenger",
      "debate.done",
      `Round ${round}: ${created.length} objection(s).`,
      { model: res.modelId },
    );
  } catch (err) {
    await failStep(job, "challenger.failed", err);
  } finally {
    store.markStopped(job.id);
  }
}

function normalizeObjection(o: unknown, round: number, i: number): Job["objections"][number] | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  const sev = String(rec.severity ?? "MEDIUM").toUpperCase();
  const severity = (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(sev) ? sev : "MEDIUM") as
    | "CRITICAL"
    | "HIGH"
    | "MEDIUM"
    | "LOW";
  const title = String(rec.title ?? "").trim();
  if (!title) return null;
  return {
    id: `${round}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    round,
    severity,
    title: title.slice(0, 200),
    body: rec.body ? String(rec.body).slice(0, 4000) : null,
    status: "open",
    createdAt: new Date().toISOString(),
  };
}

/* ── implementation ────────────────────────────────────────────────────────*/

export async function performImplementation(job: Job): Promise<void> {
  store.markRunning(job.id);
  try {
    if (!(await store.advance(job.id, "implementing", "implement"))) return;
    if (!job.plan) return void (await notConfigured(job, "No plan to implement — run the Builder first."));
    if (!openRouterConfigured()) return void (await notConfigured(job, "OPENROUTER_API_KEY is not configured — implementation cannot run."));
    if (!(await openCodeAvailable())) return void (await notConfigured(job, "OpenCode is not available on the worker — implementation cannot run."));

    const prompt = [
      "Implement the following approved plan in this repository.",
      "Make the smallest change that satisfies it. Follow existing patterns; do not touch unrelated code. Do not commit — leave changes in the working tree.",
      "",
      `Request: ${job.request}`,
      "",
      `Plan: ${JSON.stringify(job.plan, null, 2)}`,
    ].join("\n");

    await note(job, "info", "builder", "implement.start", "OpenCode implementing the plan…");
    const res = await runOpenCode(job, { modelId: job.builderModel, prompt, timeoutMs: 600_000 });
    if (res.code !== 0) {
      throw new Error(`OpenCode exited ${res.code}: ${(res.stderr || res.stdout).slice(0, 300)}`);
    }

    const sha = await stageAndCommit(job, `forge: ${job.request.split("\n")[0]?.slice(0, 72) ?? "implement change"}`);
    const diff = await computeDiff(job);
    await store.update(job.id, (j) => {
      j.diffSummary = diff.summary;
      j.error = null;
      settle(j, "ready", "implement");
    });
    if (!sha) {
      await note(job, "warn", "builder", "implement.nochange", "Implementation produced no file changes.");
    } else {
      await note(job, "success", "builder", "implement.done", `Committed ${diff.summary.filesChanged} file(s).`, { sha });
    }
  } catch (err) {
    await failStep(job, "implement.failed", err);
  } finally {
    store.markStopped(job.id);
  }
}

/* ── verification checks ───────────────────────────────────────────────────*/

type PackageManager = { install: string[]; runPrefix: string[] };

async function detectPackageManager(repoDir: string): Promise<PackageManager> {
  const exists = async (f: string) =>
    Bun.file(join(repoDir, f))
      .exists()
      .catch(() => false);
  if (await exists("bun.lockb")) return { install: ["bun", "install"], runPrefix: ["bun", "run"] };
  if (await exists("pnpm-lock.yaml"))
    return { install: ["pnpm", "install", "--frozen-lockfile"], runPrefix: ["pnpm", "run"] };
  if (await exists("yarn.lock")) return { install: ["yarn", "install"], runPrefix: ["yarn", "run"] };
  if (await exists("package-lock.json"))
    return { install: ["npm", "ci", "--no-audit", "--no-fund"], runPrefix: ["npm", "run"] };
  return { install: ["npm", "install", "--no-audit", "--no-fund"], runPrefix: ["npm", "run"] };
}

let depsInstalled = new Set<string>();

async function ensureDependencies(job: Job, pm: PackageManager): Promise<boolean> {
  if (depsInstalled.has(job.id)) return true;
  if (await Bun.file(join(job.repoDir, "node_modules", ".package-lock.json")).exists().catch(() => false)) {
    depsInstalled.add(job.id);
    return true;
  }
  await note(job, "info", "system", "deps.install", `Installing dependencies (${pm.install.join(" ")})…`);
  const r = await run(pm.install, { cwd: job.repoDir, timeoutMs: 600_000 });
  if (r.code !== 0) {
    await note(job, "warn", "system", "deps.failed", `Dependency install failed (exit ${r.code}).`, {
      stderr: r.stderr.slice(-1000),
    });
    return false;
  }
  depsInstalled.add(job.id);
  return true;
}

function summarize(text: string, lines = 8): string {
  return text.split("\n").filter(Boolean).slice(-lines).join("\n").slice(0, 1500);
}

export async function performChecks(job: Job, profileKey: VerificationProfileKey): Promise<void> {
  store.markRunning(job.id);
  try {
    if (!(await store.advance(job.id, "verifying", "verify"))) return;
    const profile = VERIFICATION_PROFILES[profileKey];
    const pm = await detectPackageManager(job.repoDir);

    // Seed the check ledger as pending so getJob shows the whole plan up front.
    await store.update(job.id, (j) => {
      j.checks = profile.checks.map((name, i) => ({
        name,
        command: `${pm.runPrefix.join(" ")} ${name}`,
        status: "pending",
        durationMs: 0,
        position: i,
        startedAt: null,
        completedAt: null,
      }));
    });

    const haveDeps = await ensureDependencies(job, pm);
    if (!haveDeps) {
      const now = new Date().toISOString();
      await store.update(job.id, (j) => {
        for (const c of j.checks) {
          c.status = "skipped";
          c.completedAt = now;
          c.failureSummary = "Dependencies not installed.";
        }
        settle(j, "ready", "verify");
      });
      await note(job, "warn", "system", "checks.skipped", "Checks skipped — dependencies unavailable.");
      return;
    }

    for (const check of profile.checks) {
      const startedAt = new Date().toISOString();
      await store.update(job.id, (j) => {
        const rec = j.checks.find((c) => c.name === check);
        if (rec) {
          rec.status = "running";
          rec.startedAt = startedAt;
        }
      });
      const r = await run([...pm.runPrefix, check], { cwd: job.repoDir, timeoutMs: 300_000 });
      const passed = r.code === 0;
      await store.update(job.id, (j) => {
        const rec = j.checks.find((c) => c.name === check);
        if (rec) {
          rec.status = passed ? "passed" : "failed";
          rec.durationMs = r.durationMs;
          rec.completedAt = new Date().toISOString();
          rec.outputSummary = summarize(r.stdout || r.stderr);
          if (!passed) rec.failureSummary = summarize(r.stderr || r.stdout);
        }
      });
      await note(
        job,
        passed ? "success" : "error",
        "system",
        passed ? "check.passed" : "check.failed",
        `${check}: ${passed ? "passed" : "failed"} (${Math.round(r.durationMs / 1000)}s)`,
      );
    }

    await store.update(job.id, (j) => settle(j, "ready", "verify"));
  } catch (err) {
    await failStep(job, "checks.failed", err);
  } finally {
    store.markStopped(job.id);
  }
}

/** Resolved check results for the wire response — pending/running are omitted. */
export function checkResults(job: Job): WorkerCheckResult[] {
  const resolved: WorkerCheckResult["status"][] = ["passed", "failed", "skipped"];
  return job.checks
    .filter((c) => resolved.includes(c.status as WorkerCheckResult["status"]))
    .map((c) => ({
      name: c.name,
      command: c.command,
      status: c.status as WorkerCheckResult["status"],
      durationMs: c.durationMs,
      outputSummary: c.outputSummary,
      failureSummary: c.failureSummary,
    }));
}

/* ── gstack review / qa ────────────────────────────────────────────────────*/

export async function performReview(job: Job, operation: GstackOperation): Promise<void> {
  store.markRunning(job.id);
  try {
    if (!(await store.advance(job.id, "reviewing", "review"))) return;
    if (!openRouterConfigured()) return void (await notConfigured(job, "OPENROUTER_API_KEY is not configured — review cannot run."));
    if (!(await openCodeAvailable())) return void (await notConfigured(job, "OpenCode is not available — gstack review cannot run."));

    await note(job, "info", "challenger", "review.start", `gstack "${operation}"…`);
    const result = await runGstackOperation(job, operation, job.challengerModel);
    await store.update(job.id, (j) => {
      j.lastGstackOperation = operation;
      j.error = null;
      settle(j, "ready", "review");
    });
    await note(
      job,
      result.ok ? "success" : "warn",
      "challenger",
      "review.done",
      `gstack "${operation}" complete.`,
      { output: result.output.slice(0, 4000) },
    );
  } catch (err) {
    await failStep(job, "review.failed", err);
  } finally {
    store.markStopped(job.id);
  }
}

export async function performQa(job: Job): Promise<void> {
  store.markRunning(job.id);
  try {
    if (!(await store.advance(job.id, "qa", "qa"))) return;
    if (!openRouterConfigured()) return void (await notConfigured(job, "OPENROUTER_API_KEY is not configured — QA cannot run."));
    if (!(await openCodeAvailable())) return void (await notConfigured(job, "OpenCode is not available — QA cannot run."));

    await note(job, "info", "system", "qa.start", "gstack QA pass…");
    const result = await runGstackOperation(job, "qa", job.challengerModel);
    await store.update(job.id, (j) => {
      j.error = null;
      settle(j, "ready", "qa");
    });
    await note(job, result.ok ? "success" : "warn", "system", "qa.done", "QA pass complete.", {
      output: result.output.slice(0, 4000),
    });
  } catch (err) {
    await failStep(job, "qa.failed", err);
  } finally {
    store.markStopped(job.id);
  }
}

/* ── pull request ──────────────────────────────────────────────────────────*/

/** Runs synchronously in the request: push + open PR, and return the URL. */
export async function performPullRequest(job: Job): Promise<{ url: string }> {
  const ahead = await commitsAhead(job);
  if (ahead === 0) throw new Error("Nothing to open a pull request for — the branch has no commits.");
  if (!(await store.advance(job.id, "creating_pr", "pr"))) {
    throw new Error("Job is not operable (cancelled or completed).");
  }
  try {
    await pushBranch(job);
    const { url } = await createPullRequest(job);
    await store.update(job.id, (j) => {
      j.prUrl = url;
      j.error = null;
      settle(j, "pr_created", "pr");
    });
    await note(job, "success", "system", "pr.created", `Pull request opened: ${url}`);
    return { url };
  } catch (err) {
    await failStep(job, "pr.failed", err);
    throw err;
  }
}

/* ── failure ───────────────────────────────────────────────────────────────*/

async function failStep(job: Job, kind: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await store.update(job.id, (j) => {
    // A cancelled job stays cancelled — a late failure does not overwrite it.
    if (j.status !== "cancelled" && j.status !== "completed") j.status = "failed";
    j.error = message;
  });
  await note(job, "error", "system", kind, message);
  log.error("pipeline step failed", { job: job.id, kind, error: message });
}
