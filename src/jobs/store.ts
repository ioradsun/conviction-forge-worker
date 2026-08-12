/**
 * The job store — durable across restarts via the Railway volume.
 *
 * Each job is persisted to `WORKSPACE_ROOT/<id>/job.json`, written atomically
 * (temp file + rename) so a crash mid-write cannot corrupt it. On boot we
 * reload every job.json, which means a worker restart does not lose the ledger,
 * the plan, or the branch — those live on the same volume as the checkout.
 *
 * A separate in-memory set tracks which jobs have a live background task. It is
 * deliberately NOT persisted: after a restart nothing is running, so a job left
 * in a transient status ("implementing", …) is reported as stalled rather than
 * pretended to be in flight.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { log } from "../logging.ts";
import type { Job, JobEvent, WorkerJobStatus } from "./types.ts";
import { isTerminal } from "./types.ts";

const MAX_EVENTS = 250;

class JobStore {
  private jobs = new Map<string, Job>();
  private running = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();

  /** Load all persisted jobs from the workspace root. Safe to call once at boot. */
  async load(): Promise<void> {
    await mkdir(config.workspaceRoot, { recursive: true });
    let entries: string[] = [];
    try {
      entries = await readdir(config.workspaceRoot);
    } catch (err) {
      log.warn("could not read workspace root", { error: String(err) });
      return;
    }
    for (const entry of entries) {
      const file = join(config.workspaceRoot, entry, "job.json");
      try {
        const raw = await readFile(file, "utf8");
        const job = JSON.parse(raw) as Job;
        if (job?.id) this.jobs.set(job.id, job);
      } catch {
        // Not every directory is a job; ignore non-job entries silently.
      }
    }
    log.info("job store loaded", { count: this.jobs.size });
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(job: Job): Promise<Job> {
    this.jobs.set(job.id, job);
    await this.persist(job);
    return job;
  }

  /**
   * Apply a mutation, bump updatedAt, and persist. Mutations are serialized
   * per job so two background steps cannot interleave a read-modify-write.
   */
  async update(id: string, mutate: (job: Job) => void): Promise<Job | undefined> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.locks.set(id, prev.then(() => gate));
    await prev;
    try {
      const job = this.jobs.get(id);
      if (!job) return undefined;
      mutate(job);
      job.updatedAt = new Date().toISOString();
      await this.persist(job);
      return job;
    } finally {
      release();
      if (this.locks.get(id) === gate) this.locks.delete(id);
    }
  }

  async setStatus(id: string, status: WorkerJobStatus, phase?: string | null): Promise<void> {
    await this.update(id, (job) => {
      job.status = status;
      if (phase !== undefined) job.phase = phase;
    });
  }

  /**
   * Move a job to a new status ONLY if it is not already terminal. Background
   * phases use this so a job cancelled mid-flight is never quietly revived by a
   * task that finishes afterwards.
   */
  async advance(id: string, status: WorkerJobStatus, phase?: string | null): Promise<boolean> {
    let moved = false;
    await this.update(id, (job) => {
      if (job.status === "cancelled" || job.status === "completed") return;
      job.status = status;
      if (phase !== undefined) job.phase = phase;
      moved = true;
    });
    return moved;
  }

  async addEvent(id: string, event: Omit<JobEvent, "ts"> & { ts?: string }): Promise<void> {
    const full: JobEvent = { ts: event.ts ?? new Date().toISOString(), ...event };
    await this.update(id, (job) => {
      job.events.push(full);
      if (job.events.length > MAX_EVENTS) job.events = job.events.slice(-MAX_EVENTS);
    });
    log.info(`job ${id}: ${full.message}`, { kind: full.kind, level: full.level });
  }

  markRunning(id: string): void {
    this.running.add(id);
  }
  markStopped(id: string): void {
    this.running.delete(id);
  }
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** True when a job's status implies work in flight but no task is live. */
  isStalled(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (isTerminal(job.status)) return false;
    const transient: WorkerJobStatus[] = [
      "cloning",
      "analyzing",
      "planning",
      "debating",
      "revising",
      "implementing",
      "verifying",
      "reviewing",
      "qa",
      "creating_pr",
    ];
    return transient.includes(job.status) && !this.running.has(id);
  }

  private async persist(job: Job): Promise<void> {
    const dir = join(config.workspaceRoot, job.id);
    const file = join(dir, "job.json");
    const tmp = join(dir, `.job.${process.pid}.tmp`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
      await rename(tmp, file);
    } catch (err) {
      log.error("failed to persist job", { id: job.id, error: String(err) });
    }
  }
}

export const store = new JobStore();
