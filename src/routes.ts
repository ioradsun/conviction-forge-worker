/**
 * The HTTP surface — all fifteen endpoints of the Forge Worker contract.
 *
 * Shape rules, enforced everywhere:
 *   - Auth on every protected route (health checks excepted).
 *   - Long operations START work and return immediately; the caller polls
 *     `GET /jobs/:id`. The Conviction adapter aborts at 60s, so nothing here
 *     holds a connection open across real model or build time.
 *   - Every response is valid JSON, including the "void" endpoints, which
 *     answer `{ ok: true }`.
 */
import { join } from "node:path";
import { requireAuth } from "./auth.ts";
import { config, features } from "./config.ts";
import {
  isForgeMode,
  isGstackOperation,
  isProfileKey,
  type CreateJobInput,
} from "./contract.ts";
import { fail, json, ok, Router, type Ctx } from "./http.ts";
import { store } from "./jobs/store.ts";
import { detailOf } from "./jobs/serialize.ts";
import type { Job } from "./jobs/types.ts";
import { assertSafeBranch, computeDiff } from "./git/repo.ts";
import { run } from "./shell.ts";
import {
  abortDebate,
  autopilotBuild,
  autopilotFromClone,
  checkResults,
  performBuilder,
  performChallenger,
  performChecks,
  performClone,
  performImplementation,
  performPullRequest,
  performQa,
  performReview,
} from "./pipeline.ts";

/** Fire a background task; its own try/catch records failure on the job. */
function spawn(task: Promise<unknown>): void {
  void task.catch(() => {
    /* pipeline functions already record their own failures */
  });
}

/** Load a job or produce a 404 response. */
function loadJob(id: string): { job: Job } | { res: Response } {
  const job = store.get(id);
  if (!job) return { res: fail(404, `No job ${id}`) };
  return { job };
}

/** Guard mutating steps against truly terminal jobs. */
function ensureOperable(job: Job): Response | null {
  if (job.status === "cancelled") return fail(409, "Job was cancelled.");
  if (job.status === "completed") return fail(409, "Job is completed.");
  return null;
}

function validateCreate(body: unknown): CreateJobInput | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const b = body as Record<string, unknown>;
  const need = (k: string) => (typeof b[k] === "string" && (b[k] as string).length > 0);
  if (!need("jobId")) return "jobId is required.";
  if (!need("request")) return "request is required.";
  if (!need("branchName")) return "branchName is required.";
  if (!need("builderModel") || !need("challengerModel") || !need("escalationModel"))
    return "builderModel, challengerModel and escalationModel are required.";
  if (!isForgeMode(b.mode)) return "mode must be FAST, DEBATE or CRITICAL.";
  if (!isProfileKey(b.verificationProfile)) return "verificationProfile is invalid.";
  try {
    assertSafeBranch(b.branchName as string);
  } catch (e) {
    return e instanceof Error ? e.message : "branchName is unsafe.";
  }
  return {
    jobId: b.jobId as string,
    request: b.request as string,
    mode: b.mode,
    branchName: b.branchName as string,
    verificationProfile: b.verificationProfile,
    builderModel: b.builderModel as string,
    challengerModel: b.challengerModel as string,
    escalationModel: b.escalationModel as string,
  };
}

export function buildRouter(): Router {
  const r = new Router();

  /* ── health (unauthenticated) ────────────────────────────────────────────*/
  const health = () => json({ ok: true, service: "conviction-forge-worker", version: config.version });
  r.get("/", health);
  r.get("/health", health);
  r.get("/healthz", health);

  /* Everything below is authenticated. */
  const guard = (h: (c: Ctx) => Response | Promise<Response>) => (c: Ctx) =>
    requireAuth(c.req) ?? h(c);

  /* ── GET /status ─────────────────────────────────────────────────────────*/
  r.get(
    "/status",
    guard(() =>
      json({
        ok: true,
        version: config.version,
        workspace: config.workspaceRoot,
        repo: config.repoFullName,
        baseBranch: config.baseBranch,
        features: { openRouter: features.openRouter, github: features.github },
      }),
    ),
  );

  /* ── POST /jobs ──────────────────────────────────────────────────────────*/
  r.post(
    "/jobs",
    guard(async ({ body }) => {
      const input = validateCreate(body);
      if (typeof input === "string") return fail(400, input);

      const workerJobId = crypto.randomUUID();
      const workspaceDir = join(config.workspaceRoot, workerJobId);
      const now = new Date().toISOString();
      const job: Job = {
        id: workerJobId,
        forgeJobId: input.jobId,
        request: input.request,
        mode: input.mode,
        branchName: input.branchName,
        baseBranch: config.baseBranch,
        verificationProfile: input.verificationProfile,
        builderModel: input.builderModel,
        challengerModel: input.challengerModel,
        escalationModel: input.escalationModel,
        status: "created",
        phase: "analyze",
        workspaceDir,
        repoDir: join(workspaceDir, "repo"),
        plan: null,
        planLockedAt: null,
        objections: [],
        checks: [],
        lastGstackOperation: null,
        diffSummary: null,
        previewUrl: null,
        prUrl: null,
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        error: null,
        events: [],
        createdAt: now,
        updatedAt: now,
      };
      await store.create(job);
      await store.addEvent(job.id, {
        level: "info",
        role: "system",
        kind: "job.created",
        message: `Job accepted — ${job.mode} mode, ${job.verificationProfile} profile.`,
      });
      // Clone, then (in self-driving mode) drive the pipeline to the first
      // human gate. Manual mode stops at a ready checkout, awaiting step calls.
      spawn(
        config.autopilot
          ? performClone(job).then(() => autopilotFromClone(job.id))
          : performClone(job),
      );
      return json({ workerJobId } satisfies { workerJobId: string });
    }),
  );

  /* ── GET /jobs/:id ───────────────────────────────────────────────────────*/
  r.get(
    "/jobs/:id",
    guard(({ params }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      return json({ status: found.job.status, detail: detailOf(found.job) });
    }),
  );

  /* Helper for the start-and-return-fast background endpoints. */
  const background = (
    kind: string,
    make: (job: Job, body: unknown) => Promise<unknown>,
  ) =>
    guard(async ({ params, body }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      const denied = ensureOperable(found.job);
      if (denied) return denied;
      if (store.isRunning(found.job.id)) return ok({ alreadyRunning: true });
      spawn(make(found.job, body));
      return ok({ started: true, kind });
    });

  /* ── POST /jobs/:id/debate ───────────────────────────────────────────────*/
  r.post("/jobs/:id/debate", background("debate", (job) => performChallenger(job)));

  /* ── POST /jobs/:id/builder ──────────────────────────────────────────────*/
  r.post(
    "/jobs/:id/builder",
    background("builder", (job, body) => {
      const instruction =
        body && typeof body === "object" && typeof (body as Record<string, unknown>).instruction === "string"
          ? ((body as Record<string, unknown>).instruction as string)
          : undefined;
      return performBuilder(job, instruction);
    }),
  );

  /* ── POST /jobs/:id/challenger ───────────────────────────────────────────*/
  r.post("/jobs/:id/challenger", background("challenger", (job) => performChallenger(job)));

  /* ── POST /jobs/:id/lock ─────────────────────────────────────────────────*/
  r.post(
    "/jobs/:id/lock",
    guard(async ({ params }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      const denied = ensureOperable(found.job);
      if (denied) return denied;
      await store.update(found.job.id, (j) => {
        j.status = "plan_locked";
        j.phase = "lock";
        j.planLockedAt = new Date().toISOString();
      });
      await store.addEvent(found.job.id, {
        level: "success",
        role: "human",
        kind: "plan.locked",
        message: "Plan locked.",
      });
      // In self-driving mode, a human lock resumes the pipeline: implement →
      // verify → review → qa, up to the final approval gate.
      if (config.autopilot && found.job.mode !== "FAST") {
        // If a debate is in flight, abort it now so we don't wait out the model
        // timeout — autopilotFromClone then continues straight into the build
        // (planLockedAt is set). If nothing was running, start the build here.
        const abortedDebate = abortDebate(found.job.id);
        if (!abortedDebate && !store.isRunning(found.job.id)) {
          spawn(autopilotBuild(found.job.id));
        }
      }
      return ok();
    }),
  );

  /* ── POST /jobs/:id/implement ────────────────────────────────────────────*/
  r.post("/jobs/:id/implement", background("implement", (job) => performImplementation(job)));

  /* ── POST /jobs/:id/checks ───────────────────────────────────────────────*/
  r.post(
    "/jobs/:id/checks",
    guard(async ({ params, body }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      const denied = ensureOperable(found.job);
      if (denied) return denied;
      const profile =
        body && typeof body === "object" && isProfileKey((body as Record<string, unknown>).profile)
          ? ((body as Record<string, unknown>).profile as CreateJobInput["verificationProfile"])
          : found.job.verificationProfile;
      // Start (or continue) the run in the background; answer with the
      // terminal results known so far. Live per-check state is in GET /jobs/:id.
      if (!store.isRunning(found.job.id)) spawn(performChecks(found.job, profile));
      return json(checkResults(found.job));
    }),
  );

  /* ── POST /jobs/:id/review ───────────────────────────────────────────────*/
  r.post(
    "/jobs/:id/review",
    guard(async ({ params, body }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      const denied = ensureOperable(found.job);
      if (denied) return denied;
      const op = body && typeof body === "object" ? (body as Record<string, unknown>).operation : undefined;
      if (!isGstackOperation(op)) return fail(400, "operation must be a valid gstack operation.");
      if (store.isRunning(found.job.id)) return ok({ alreadyRunning: true });
      spawn(performReview(found.job, op));
      return ok({ started: true });
    }),
  );

  /* ── POST /jobs/:id/qa ───────────────────────────────────────────────────*/
  r.post("/jobs/:id/qa", background("qa", (job) => performQa(job)));

  /* ── GET /jobs/:id/diff ──────────────────────────────────────────────────*/
  r.get(
    "/jobs/:id/diff",
    guard(async ({ params }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      const job = found.job;
      const ready = await run(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: job.repoDir,
        timeoutMs: 10_000,
      });
      if (ready.code !== 0) {
        // Workspace not cloned yet — an honest empty diff, not an error.
        return json({ summary: { filesChanged: 0, additions: 0, deletions: 0, files: [] }, patch: "" });
      }
      return json(await computeDiff(job));
    }),
  );

  /* ── GET /jobs/:id/preview ───────────────────────────────────────────────*/
  r.get(
    "/jobs/:id/preview",
    guard(({ params }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      return json({ url: found.job.previewUrl ?? null });
    }),
  );

  /* ── POST /jobs/:id/pr ───────────────────────────────────────────────────*/
  r.post(
    "/jobs/:id/pr",
    guard(async ({ params }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      const denied = ensureOperable(found.job);
      if (denied) return denied;
      // Synchronous: the caller needs the URL, and push + PR is seconds, not minutes.
      const { url } = await performPullRequest(found.job);
      return json({ url });
    }),
  );

  /* ── POST /jobs/:id/cancel ───────────────────────────────────────────────*/
  r.post(
    "/jobs/:id/cancel",
    guard(async ({ params }) => {
      const found = loadJob(params.id!);
      if ("res" in found) return found.res;
      abortDebate(found.job.id); // stop any in-flight debate model call promptly
      store.markStopped(found.job.id);
      await store.update(found.job.id, (j) => {
        if (j.status !== "completed") j.status = "cancelled";
      });
      await store.addEvent(found.job.id, {
        level: "warn",
        role: "human",
        kind: "job.cancelled",
        message: "Cancelled by operator.",
      });
      return ok();
    }),
  );

  return r;
}
