# Conviction Forge Worker

An isolated coding worker for [`ioradsun/belief-compass`](https://github.com/ioradsun/belief-compass).

The Conviction web server never touches a filesystem, runs a test, or holds a git
checkout. Everything that writes code happens here, in an external service behind a
shared secret. This worker implements the exact contract the app defines in
`belief-compass/src/lib/forge/worker.server.ts` — no more, no less.

```text
conviction.company/admin/forge
          │
          ▼
   Conviction server   ──Bearer FORGE_WORKER_SECRET──►  Forge Worker (this service, on Railway)
                                                                │
                                                    OpenCode + gstack ──► OpenRouter
                                                                │
                                                    belief-compass checkout
                                                                │
                                              checks → diff → branch → pull request
```

## Design rules

These are not aspirations; they are enforced in code and covered by tests.

- **Honesty over plausibility.** If a credential or tool is missing, a phase records a
  named reason and stops. It never fabricates a plan, a passing check, or a diff — a
  believed-but-false result is worse than a missing one.
- **Start fast, poll for progress.** The Conviction adapter aborts any request at 60s, so
  long operations (`builder`, `implement`, `checks`, `review`, `qa`) start work and return
  immediately. Progress is observed through `GET /jobs/:id`.
- **Valid JSON, always.** Every response — including 401/404/500 and the "void" endpoints —
  is JSON, because the client always calls `res.json()`. Void endpoints answer `{ "ok": true }`.
- **The worker proposes; humans dispose.** It pushes `forge/*` branches and opens pull
  requests. It has no merge path — there is no call to a merge endpoint anywhere in the code.
- **Least privilege, bounded blast radius.** `main`/`master` are refused; pushes are never
  forced; the GitHub token never appears in argv, logs, or `.git/config`; repository content
  is treated as untrusted (no shell string interpolation, neutralised git hooks, curated
  subprocess env with no secrets); all job state stays under `WORKSPACE_ROOT`.

## The contract

| Method | Path | Purpose | Returns |
| --- | --- | --- | --- |
| `GET` | `/status` | Liveness + capability report | `{ version, workspace, … }` |
| `POST` | `/jobs` | Create a job; clone + branch in background | `{ workerJobId }` |
| `GET` | `/jobs/:id` | Observe a job | `{ status, detail }` |
| `POST` | `/jobs/:id/debate` | Start Challenger debate (async) | `{ ok: true }` |
| `POST` | `/jobs/:id/builder` | Run Builder plan / revision (async) | `{ ok: true }` |
| `POST` | `/jobs/:id/challenger` | Run a Challenger round (async) | `{ ok: true }` |
| `POST` | `/jobs/:id/lock` | Human gate: lock the plan | `{ ok: true }` |
| `POST` | `/jobs/:id/implement` | Implement via OpenCode (async) | `{ ok: true }` |
| `POST` | `/jobs/:id/checks` | Run the verification profile (async) | `WorkerCheckResult[]` |
| `POST` | `/jobs/:id/review` | Run a gstack operation (async) | `{ ok: true }` |
| `POST` | `/jobs/:id/qa` | Run a QA pass (async) | `{ ok: true }` |
| `GET` | `/jobs/:id/diff` | Branch diff vs base | `{ summary, patch }` |
| `GET` | `/jobs/:id/preview` | Preview URL, if any | `{ url }` |
| `POST` | `/jobs/:id/pr` | Push + open a pull request (sync) | `{ url }` |
| `POST` | `/jobs/:id/cancel` | Cancel a job | `{ ok: true }` |

`GET /health` (and `/`, `/healthz`) is unauthenticated for the platform health check.
Every other endpoint requires `Authorization: Bearer <FORGE_WORKER_SECRET>`.

`GET /jobs/:id` returns the worker's status string plus a rich `detail`: phase, plan,
objections, live check rows, diff summary, PR URL, a recent event log, a token ledger, and a
`stalled` flag that is honest about a transient status left behind by a restart.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `FORGE_WORKER_SECRET` | yes | — | Shared bearer secret. Must equal Conviction's copy. |
| `OPENROUTER_API_KEY` | for AI phases | — | OpenCode's model provider. |
| `GITHUB_TOKEN` | for push/PR | — | Fine-grained token scoped to the repo. |
| `REPO_FULL_NAME` | — | `ioradsun/belief-compass` | Repository under work. |
| `BASE_BRANCH` | — | `main` | Branch to fork from and target PRs at. |
| `WORKSPACE_ROOT` | — | `/workspace` | Root for per-job checkouts (the Railway Volume). |
| `PORT` | — | `8080` | Injected by Railway. |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | — | `Conviction Forge` / `forge@conviction.company` | Local commit identity. |
| `OPENCODE_BIN` | — | `opencode` | OpenCode binary name/path. |
| `GSTACK_DIR` | — | `/opt/gstack` | Where gstack is installed. |
| `REPO_URL` | — | derived | Override the clone URL (mirror/GHE/test remote). |

Secrets are read once, in `src/config.ts`, and the logger scrubs their exact values (plus
bearer/GitHub/OpenRouter token shapes) from everything it prints.

## Deploy on Railway

1. **Push this repo** to a private GitHub repository (e.g. `ioradsun/conviction-forge-worker`).
2. **New Project → Deploy from GitHub →** select the repo. Railway builds the `Dockerfile`.
3. **Attach a Volume** mounted at `/workspace` (Railway dashboard → service → Volumes), so
   checkouts survive deploys and restarts.
4. **Set service variables:**
   ```
   FORGE_WORKER_SECRET=<long random string>
   OPENROUTER_API_KEY=<your OpenRouter key>
   GITHUB_TOKEN=<fine-grained token, repo-scoped>
   WORKSPACE_ROOT=/workspace
   REPO_FULL_NAME=ioradsun/belief-compass
   ```
5. **Generate a public domain** for the service (Railway → Settings → Networking).
6. **Wire Conviction** — in the Conviction/Lovable *server-side* secrets (never `VITE_*`, never a
   browser-facing form):
   ```
   FORGE_WORKER_URL=https://<your-worker>.railway.app
   FORGE_WORKER_SECRET=<the exact same secret>
   ```

### GitHub token

Use a **fine-grained** personal access token restricted to `ioradsun/belief-compass` with
**Contents: read/write** and **Pull requests: read/write** — enough to push the forge branch
and open a PR, and nothing else. Do not use a broad classic token.

### OpenCode & gstack

OpenCode is installed in the image. gstack is optional and hosted on OpenCode; supply its
source at build time and it is set up with `./setup --host opencode`:

```
docker build --build-arg GSTACK_REPO=<git-url> --build-arg GSTACK_REF=main .
```

Without gstack present, the `review`/`qa` operations still run — directly through OpenCode
with the operation's intent. OpenCode's CLI flags move between versions; the binary name
(`OPENCODE_BIN`) and model prefix (`OPENCODE_MODEL_PREFIX`, default `openrouter/`) are the two
knobs, centralised in `src/agent/opencode.ts`.

## Bring-up order

Don't start with the full loop. Bring it up one green light at a time — this is also the order
in which each layer's dependency (a secret, a tool) comes online:

1. **`/status`** → in Forge you see *Connected ✓, Version 0.1.0, Workspace /workspace*.
2. **Create a job** → the worker clones belief-compass, cuts a `forge/…` branch, `GET /jobs/:id`
   shows `ready`. *(No AI needed yet.)*
3. **OpenRouter key** → Builder plans, Challenger debates.
4. **OpenCode** → `implement` writes code; `diff` shows it.
5. **Checks** → the verification profile runs.
6. **GitHub token** → `pr` pushes the branch and opens the pull request.

## Local development

```bash
bun install
cp .env.example .env      # fill in FORGE_WORKER_SECRET at least
bun run dev               # watch mode on 0.0.0.0:$PORT (default 8080)

curl localhost:8080/health
curl -H "Authorization: Bearer $FORGE_WORKER_SECRET" localhost:8080/status
```

## Tests

```bash
bun test        # hermetic contract test: a local git remote stands in for
                # belief-compass; no network, no OpenRouter, no GitHub required.
bun run typecheck
```

The contract test drives every endpoint and asserts the shapes against
`worker.server.ts`, including that the degraded "nothing configured" path still returns valid
JSON and never fabricates a result.

## Layout

```
src/
  index.ts          entry — Bun.serve on 0.0.0.0:$PORT, loads the store
  config.ts         one place that reads env; the secret registry
  logging.ts        structured logs, secrets scrubbed by construction
  auth.ts           constant-time bearer check, fail-closed
  http.ts           JSON-always responses + a tiny path-param router
  shell.ts          the only subprocess runner (argv arrays, curated env)
  contract.ts       the wire contract + verification profiles (mirrored)
  routes.ts         the fifteen endpoints
  pipeline.ts       every phase the worker performs
  agent/            openrouter · opencode · gstack
  git/              repo (clone/branch/diff/push) · github (pull request)
  jobs/             types · durable store · GET detail serializer
test/
  contract.test.ts  the contract, exercised end to end
```
