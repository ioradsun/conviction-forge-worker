/**
 * Contract test — the worker against `belief-compass/src/lib/forge/worker.server.ts`.
 *
 * It exercises the router directly (no port) with a LOCAL git remote standing in
 * for belief-compass, so it is hermetic: no network, no OpenRouter, no GitHub.
 * That "nothing configured" posture is deliberate — it proves the two things
 * the adapter depends on hold even on the degraded path: every response is
 * valid JSON, and the void endpoints answer `{ ok: true }`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "test-secret-0123456789";

let router: { handle: (req: Request) => Promise<Response> };
let store: typeof import("../src/jobs/store.ts").store;
let workRoot: string;
let remoteDir: string;
let workerJobId: string;

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

type Opts = { auth?: boolean; body?: unknown };
async function call(method: string, path: string, opts: Opts = {}) {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) headers.authorization = `Bearer ${SECRET}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await router.handle(
    new Request(`http://worker.test${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
  const text = await res.text();
  let json: unknown;
  // The core invariant: every response body parses as JSON.
  expect(() => (json = JSON.parse(text))).not.toThrow();
  return { status: res.status, json: json as Record<string, unknown> };
}

async function waitFor(id: string, pred: (detail: Record<string, unknown>) => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { json } = await call("GET", `/jobs/${id}`);
    if (pred((json.detail as Record<string, unknown>) ?? {})) return json;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "cfw-work-"));
  remoteDir = await mkdtemp(join(tmpdir(), "cfw-remote-"));

  // A local stand-in for belief-compass with a main branch and echo-based checks.
  git(["init", "-b", "main"], remoteDir);
  git(["config", "user.email", "t@test"], remoteDir);
  git(["config", "user.name", "Test"], remoteDir);
  await writeFile(join(remoteDir, "README.md"), "# fake belief-compass\n");
  await writeFile(
    join(remoteDir, "package.json"),
    JSON.stringify(
      { name: "fake", scripts: { "check:types": "echo types-ok", lint: "echo lint-ok", build: "echo build-ok" } },
      null,
      2,
    ),
  );
  git(["add", "-A"], remoteDir);
  git(["commit", "-m", "init"], remoteDir);

  process.env.FORGE_WORKER_SECRET = SECRET;
  process.env.WORKSPACE_ROOT = workRoot;
  process.env.REPO_FULL_NAME = "ioradsun/belief-compass";
  process.env.REPO_URL = remoteDir;
  process.env.BASE_BRANCH = "main";
  process.env.FORGE_AUTOPILOT = "off"; // drive phases explicitly in these tests
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GITHUB_TOKEN;

  const routesMod = await import("../src/routes.ts");
  const storeMod = await import("../src/jobs/store.ts");
  store = storeMod.store;
  await store.load();
  router = routesMod.buildRouter();
});

afterAll(async () => {
  // Let any background tasks settle before removing their working dirs.
  await new Promise((r) => setTimeout(r, 300));
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  await rm(remoteDir, { recursive: true, force: true }).catch(() => {});
});

describe("health", () => {
  test("GET /health needs no auth", async () => {
    const { status, json } = await call("GET", "/health", { auth: false });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });
});

describe("auth", () => {
  test("GET /status without a bearer is 401", async () => {
    const { status, json } = await call("GET", "/status", { auth: false });
    expect(status).toBe(401);
    expect(json.ok).toBe(false);
  });

  test("POST /jobs without a bearer is 401", async () => {
    const { status } = await call("POST", "/jobs", { auth: false, body: {} });
    expect(status).toBe(401);
  });
});

describe("GET /status", () => {
  test("returns version and workspace", async () => {
    const { status, json } = await call("GET", "/status");
    expect(status).toBe(200);
    // worker.server.ts reads { version?, workspace? }.
    expect(typeof json.version).toBe("string");
    expect(json.workspace).toBe(workRoot);
  });
});

describe("POST /jobs", () => {
  test("rejects an invalid body with 400", async () => {
    const { status } = await call("POST", "/jobs", { body: { request: "x" } });
    expect(status).toBe(400);
  });

  test("accepts a valid CreateJobInput and returns { workerJobId }", async () => {
    const { status, json } = await call("POST", "/jobs", {
      body: {
        jobId: "forge-job-abc12345",
        request: "Add a small date formatting helper",
        mode: "FAST",
        branchName: "forge/date-helper-abc12345",
        verificationProfile: "ui",
        builderModel: "deepseek/deepseek-v4-flash",
        challengerModel: "minimax/minimax-m2.5",
        escalationModel: "anthropic/claude-opus-5",
      },
    });
    expect(status).toBe(200);
    expect(typeof json.workerJobId).toBe("string");
    workerJobId = json.workerJobId as string;
  });

  test("clones the repo and reaches a ready state", async () => {
    const snap = await waitFor(workerJobId, (d) => d.status === "ready" || d.status === "failed");
    expect(snap.status).toBe("ready");
    const detail = snap.detail as Record<string, unknown>;
    expect(detail.branchName).toBe("forge/date-helper-abc12345");
  });
});

describe("GET /jobs/:id", () => {
  test("returns { status, detail }", async () => {
    const { json } = await call("GET", `/jobs/${workerJobId}`);
    expect(typeof json.status).toBe("string");
    expect(typeof json.detail).toBe("object");
  });

  test("404s an unknown job", async () => {
    const { status } = await call("GET", "/jobs/does-not-exist");
    expect(status).toBe(404);
  });
});

describe("void endpoints answer { ok: true }", () => {
  for (const path of ["debate", "builder", "challenger", "lock", "implement", "qa"]) {
    test(`POST /jobs/:id/${path}`, async () => {
      const { status, json } = await call("POST", `/jobs/${workerJobId}/${path}`, { body: {} });
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      // Give a spawned background task a beat to release the run lock.
      await new Promise((r) => setTimeout(r, 50));
    });
  }
});

describe("POST /jobs/:id/review", () => {
  test("rejects an invalid operation", async () => {
    const { status } = await call("POST", `/jobs/${workerJobId}/review`, { body: { operation: "nope" } });
    expect(status).toBe(400);
  });
  test("accepts a valid operation", async () => {
    const { json } = await call("POST", `/jobs/${workerJobId}/review`, { body: { operation: "review" } });
    expect(json.ok).toBe(true);
  });
});

describe("POST /jobs/:id/checks", () => {
  test("returns a WorkerCheckResult[] and runs the profile", async () => {
    // Ensure no prior background task holds the run lock, so /checks starts.
    await waitFor(workerJobId, (d) => d.running === false);
    // Pre-seed node_modules so the runner does not shell out to a package
    // manager; the echo-based scripts then execute offline.
    const job = store.get(workerJobId)!;
    await mkdir(join(job.repoDir, "node_modules"), { recursive: true });
    await writeFile(join(job.repoDir, "node_modules", ".package-lock.json"), "{}");

    const { status, json } = await call("POST", `/jobs/${workerJobId}/checks`, { body: { profile: "ui" } });
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);

    const snap = await waitFor(
      workerJobId,
      (d) => Array.isArray(d.checks) && (d.checks as unknown[]).length === 3 &&
        (d.checks as { status: string }[]).every((c) => c.status === "passed"),
    );
    const checks = (snap.detail as { checks: { name: string; status: string; command: string }[] }).checks;
    expect(checks.map((c) => c.name).sort()).toEqual(["build", "check:types", "lint"]);
    expect(checks.every((c) => c.status === "passed")).toBe(true);
  });
});

describe("diff, preview", () => {
  test("GET /jobs/:id/diff returns { summary, patch } and reflects a commit", async () => {
    const job = store.get(workerJobId)!;
    await writeFile(join(job.repoDir, "src-added.txt"), "hello forge\n");
    git(["add", "-A"], job.repoDir);
    git(["commit", "-m", "add file"], job.repoDir);

    const { json } = await call("GET", `/jobs/${workerJobId}/diff`);
    const summary = json.summary as { filesChanged: number; additions: number };
    expect(summary.filesChanged).toBeGreaterThanOrEqual(1);
    expect(summary.additions).toBeGreaterThanOrEqual(1);
    expect(typeof json.patch).toBe("string");
    expect(json.patch as string).toContain("src-added.txt");
  });

  test("GET /jobs/:id/preview returns { url }", async () => {
    const { json } = await call("GET", `/jobs/${workerJobId}/preview`);
    expect(json).toHaveProperty("url");
    expect(json.url).toBeNull();
  });
});

describe("autopilot (self-driving)", () => {
  async function freshJob(mode: string, slug: string) {
    const { json } = await call("POST", "/jobs", {
      body: {
        jobId: `auto-${slug}`,
        request: `autopilot ${mode} test`,
        mode,
        branchName: `forge/${slug}-auto1234`,
        verificationProfile: mode === "CRITICAL" ? "money" : mode === "FAST" ? "ui" : "feed",
        builderModel: "x/y",
        challengerModel: "x/y",
        escalationModel: "x/y",
      },
    });
    const id = json.workerJobId as string;
    await waitFor(id, (d) => d.status === "ready" || d.status === "failed");
    return id;
  }

  test("halts honestly when the Builder produces no plan (no key)", async () => {
    const { autopilotFromClone } = await import("../src/pipeline.ts");
    const id = await freshJob("FAST", "halt-noplan");
    await autopilotFromClone(id);
    const { json } = await call("GET", `/jobs/${id}`);
    const detail = json.detail as { events: { kind: string }[]; plan: unknown };
    const kinds = detail.events.map((e) => e.kind);
    expect(kinds).toContain("autopilot.start");
    expect(kinds).toContain("autopilot.halt");
    expect(detail.plan).toBeNull();
  });

  test("DEBATE drives to the plan-lock gate once a plan exists", async () => {
    const { autopilotFromClone } = await import("../src/pipeline.ts");
    const id = await freshJob("DEBATE", "debate-gate");
    // Stand in for a Builder that produced a plan (no OpenRouter key in this env).
    await store.update(id, (j) => {
      j.plan = { summary: "seeded plan" };
    });
    await autopilotFromClone(id);
    const { json } = await call("GET", `/jobs/${id}`);
    const detail = json.detail as { phase: string; events: { kind: string }[] };
    expect(detail.events.map((e) => e.kind)).toContain("autopilot.awaiting_lock");
    expect(detail.phase).toBe("lock");
  });
});

describe("POST /jobs/:id/pr without a token fails honestly as JSON", () => {
  test("returns a JSON error rather than fabricating a URL", async () => {
    const { status, json } = await call("POST", `/jobs/${workerJobId}/pr`, { body: {} });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain("GITHUB_TOKEN");
  });
});

describe("POST /jobs/:id/cancel", () => {
  test("cancels and then refuses further steps", async () => {
    const { json } = await call("POST", `/jobs/${workerJobId}/cancel`, { body: {} });
    expect(json.ok).toBe(true);

    const after = await call("GET", `/jobs/${workerJobId}`);
    expect(after.json.status).toBe("cancelled");

    const impl = await call("POST", `/jobs/${workerJobId}/implement`, { body: {} });
    expect(impl.status).toBe(409);
  });
});
