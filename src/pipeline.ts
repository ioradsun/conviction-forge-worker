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
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  VERIFICATION_PROFILES,
  type GstackOperation,
  type VerificationProfileKey,
  type WorkerCheckResult,
} from "./contract.ts";
import { config } from "./config.ts";
import { log } from "./logging.ts";
import { run } from "./shell.ts";
import { store } from "./jobs/store.ts";
import type { Job, Plan, WorkerJobStatus } from "./jobs/types.ts";
import { callModel, extractJson, openRouterConfigured } from "./agent/openrouter.ts";
import { openCodeAvailable, runGstack } from "./agent/opencode.ts";
import { REVIEW_RUBRIC, runGstackOperation } from "./agent/gstack.ts";
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

/**
 * Per-role OpenRouter rates (USD per 1M tokens), mirrored from belief-compass
 * `src/lib/forge/models.ts`. Kept here only to populate the cost ledger so the
 * UI shows real spend rather than $0.00; Conviction remains the source of truth
 * for pricing.
 */
const RATES: Record<"builder" | "challenger" | "escalation", { in: number; out: number }> = {
  builder: { in: 0.27, out: 1.1 },
  challenger: { in: 0.3, out: 1.2 },
  escalation: { in: 15, out: 75 },
};

async function addCost(
  job: Job,
  role: "builder" | "challenger" | "escalation",
  inputTokens: number,
  outputTokens: number,
) {
  const r = RATES[role];
  const usd = (inputTokens / 1e6) * r.in + (outputTokens / 1e6) * r.out;
  await store.update(job.id, (j) => {
    j.cost.inputTokens += inputTokens;
    j.cost.outputTokens += outputTokens;
    j.cost.costUsd += usd;
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
    await addCost(job, "builder", res.inputTokens, res.outputTokens);
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

/**
 * Per-job handle to abort the in-flight debate model call. A plan lock (or a
 * cancel) that lands while the debate is running aborts it immediately instead
 * of waiting out the model timeout.
 */
const debateAborts = new Map<string, AbortController>();

/** Abort a running debate for `jobId`. Returns true if one was aborted. */
export function abortDebate(jobId: string): boolean {
  const controller = debateAborts.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}

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

    const controller = new AbortController();
    debateAborts.set(job.id, controller);
    const res = await callModel(job.challengerModel, messages, {
      maxTokens: 3072,
      temperature: 0.2,
      signal: controller.signal,
    });
    await addCost(job, "challenger", res.inputTokens, res.outputTokens);

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
    // The debate is advisory. A failed or timed-out round must never fail the
    // job — especially once the plan is locked and implementation is underway.
    const message = err instanceof Error ? err.message : String(err);
    await store.update(job.id, (j) => settle(j, "ready", "debate"));
    if (store.get(job.id)?.planLockedAt) {
      await note(job, "info", "challenger", "debate.superseded", "Debate superseded by the plan lock.");
    } else {
      await note(job, "warn", "challenger", "debate.failed", `Challenger round did not complete: ${message}`);
    }
  } finally {
    debateAborts.delete(job.id);
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

    const instruction = [
      "You are the engineer. Implement the approved plan in this repository, making the",
      "smallest change that satisfies it and following existing patterns. Actually edit",
      "the files — do not just describe the change. Then run /review and fix what it finds.",
      "Do not commit — leave the changes in the working tree.",
      "",
      `Request: ${job.request}`,
      `Plan: ${JSON.stringify(job.plan, null, 2)}`,
      "",
      "When you run /review, hold your own change to this bar:",
      REVIEW_RUBRIC,
    ].join("\n");

    await note(job, "info", "builder", "implement.start", "OpenCode + gstack implementing the plan…");
    const res = await runGstack(job, { modelId: job.builderModel, instruction, timeoutMs: 900_000 });
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
  // bun.lockb (binary, ≤1.0) or bun.lock (text, ≥1.1) — belief-compass uses the latter.
  if ((await exists("bun.lockb")) || (await exists("bun.lock")))
    return { install: ["bun", "install"], runPrefix: ["bun", "run"] };
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
  // Package-manager-agnostic "already installed" marker: node_modules present.
  const installed = await stat(join(job.repoDir, "node_modules"))
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (installed) {
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
      // The isolated worker can't run data-integrity checks (they need a live
      // DB), and the app typecheck is re-run by the pull request's own CI. Skip
      // anything outside the allowlist rather than reporting a false failure.
      if (!config.workerChecks.includes(check)) {
        const now = new Date().toISOString();
        await store.update(job.id, (j) => {
          const rec = j.checks.find((c) => c.name === check);
          if (rec) {
            rec.status = "skipped";
            rec.completedAt = now;
            rec.failureSummary = "Skipped in the worker — needs a live database, or is covered by the PR's CI.";
          }
        });
        await note(job, "info", "system", "check.skipped", `${check}: skipped (not run in the worker)`);
        continue;
      }

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

/* ── autopilot ─────────────────────────────────────────────────────────────
 * Self-driving mode. After the clone, the worker walks its own pipeline to the
 * next human gate instead of waiting to be told. It pauses exactly where a
 * person is required — the plan lock (DEBATE/CRITICAL) and the final approval
 * before a pull request — and never opens the PR itself.
 *
 * The phases are the same `performX` functions the endpoints call, awaited in
 * sequence; between each we re-read the job (a phase mutates it) and stop early
 * if it failed or was cancelled.
 */

function alive(jobId: string): boolean {
  const j = store.get(jobId);
  return !!j && j.status !== "failed" && j.status !== "cancelled" && j.status !== "completed";
}

/** From a fresh clone: plan, then debate (DEBATE/CRITICAL) or build (FAST). */
export async function autopilotFromClone(jobId: string): Promise<void> {
  const job = store.get(jobId);
  if (!job || job.status !== "ready") return; // only proceed from a successful clone
  await note(job, "info", "system", "autopilot.start", "Self-driving: Builder is analysing the repository.");

  await performBuilder(store.get(jobId)!);
  if (!alive(jobId)) return;
  if (!store.get(jobId)!.plan) {
    await note(store.get(jobId)!, "warn", "system", "autopilot.halt", "Halted: no plan was produced (is OPENROUTER_API_KEY set?).");
    return;
  }

  if (store.get(jobId)!.mode === "FAST") {
    await autopilotBuild(jobId); // no debate, no lock gate
    return;
  }

  // DEBATE / CRITICAL — attack the plan, then wait for a human to lock it.
  await performChallenger(store.get(jobId)!);
  if (!alive(jobId)) return;
  // A human may have locked the plan while the debate was still running. If so,
  // continue into the build now (the /lock endpoint deliberately did NOT start
  // it, to avoid debating and implementing at the same time); otherwise pause.
  if (store.get(jobId)!.planLockedAt) {
    await autopilotBuild(jobId);
  } else {
    await store.advance(jobId, "ready", "lock");
    await note(store.get(jobId)!, "info", "human", "autopilot.awaiting_lock", "Debate complete — awaiting human plan lock before implementing.");
  }
}

/** Guards the build phase so a lock and a finishing debate can't both start it. */
const building = new Set<string>();

/** After the plan is locked (or immediately, for FAST): implement → verify → review → qa. */
export async function autopilotBuild(jobId: string): Promise<void> {
  if (building.has(jobId)) return; // already implementing — never run it twice
  building.add(jobId);
  try {
    if (!alive(jobId)) return;
    await performImplementation(store.get(jobId)!);
    if (!alive(jobId)) return;

    if (!store.get(jobId)!.diffSummary || store.get(jobId)!.diffSummary!.filesChanged === 0) {
      await note(store.get(jobId)!, "warn", "system", "autopilot.halt", "Halted: implementation produced no changes.");
      await store.advance(jobId, "ready_for_human", "human");
      return;
    }

    await performChecks(store.get(jobId)!, store.get(jobId)!.verificationProfile);
    if (!alive(jobId)) return;

    await performReview(store.get(jobId)!, "engineering review");
    if (!alive(jobId)) return;

    if (store.get(jobId)!.mode === "CRITICAL") {
      await performReview(store.get(jobId)!, "cso"); // security review
      if (!alive(jobId)) return;
    }

    await performQa(store.get(jobId)!);
    if (!alive(jobId)) return;

    await store.advance(jobId, "ready_for_human", "human");
    await note(store.get(jobId)!, "success", "human", "autopilot.ready", "Ready for human review — approve to open the pull request.");
  } finally {
    building.delete(jobId);
  }
}
