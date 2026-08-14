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

### OpenCode & gstack — the engineer

The engineering work runs through **OpenCode driven by gstack**
([garrytan/gstack](https://github.com/garrytan/gstack)), both installed in the image. gstack's
skills (`/office-hours`, `/autoplan`, `/review`, `/cso`, `/qa`, `/ship`, …) register into
OpenCode's global config via `./setup --host opencode`; the worker names them in the prompt to
drive them headlessly ("Load gstack. … Then run /review …"), exactly as the gstack docs describe.

Two things this depends on:

- **`--auto`.** `opencode run` does *not* apply file edits without it — it plans and stops. The
  worker always passes `--auto` (`src/agent/opencode.ts`), which is what makes the engineer
  actually write code. (Its absence was the original "implementation: +0/−0" bug.)
- **A capable model.** The Builder model comes from Conviction's model-config screen and is
  passed per job. A weak model won't drive OpenCode's tool-use; pick a strong agentic-coding
  model there.

gstack's config lives at `~/.config/opencode` (shared, so its skills are found); each job gets
its own OpenCode data/cache dir. Knobs: `OPENCODE_BIN`, `OPENCODE_MODEL_PREFIX` (default
`openrouter/`), and `GSTACK_REF` (build-arg) to pin a gstack version.

> Note: gstack's *interactive* planning skills (office-hours, design reviews) expect a human to
> answer forcing questions, which a headless worker can't provide — so the plan/debate phases
> use direct model calls, while the autonomous phases (implement, `/review`, `/cso`, `/qa`,
> `/ship`) run through gstack. Live gstack behaviour can only be validated on Railway with keys.

### Config as code

Railway's [config-as-code](https://docs.railway.com/reference/config-as-code) governs **build
and deploy only**. Those live in [`railway.toml`](./railway.toml) — builder, Dockerfile path,
watch patterns, the `/health` check, restart policy — and are applied automatically on deploy.

Two things Railway deliberately keeps **out** of that file: **volumes** and **variables/secrets**.
Committing secrets would be wrong anyway, so those are provisioned by
[`scripts/railway-setup.sh`](./scripts/railway-setup.sh), which reads secrets from your shell
(never the repo) and is safe to re-run:

```bash
railway link                        # once, to select project + service
export FORGE_WORKER_SECRET=…        # long random string; matches Conviction
export OPENROUTER_API_KEY=…
export GITHUB_TOKEN=…               # fine-grained, scoped to belief-compass
./scripts/railway-setup.sh          # creates the /workspace volume + sets vars
```

The variable list itself is documented as code in [`.env.example`](./.env.example). If you
prefer the dashboard, paste those `KEY=VALUE` lines into the service's **Variables → Raw
Editor** and add a Volume at `/workspace` — same result.

## Autonomous mode

By default (`FORGE_AUTOPILOT=on`) the worker drives its own pipeline after the clone,
pausing only at the human gates:

- **FAST:** plan → implement → verify → review → qa → *await approval* → (human opens PR)
- **DEBATE / CRITICAL:** plan → debate → *await plan lock* → implement → verify → review →
  (security) → qa → *await approval* → (human opens PR)

It never locks its own plan and never opens the PR — those stay human actions
(`POST /jobs/:id/lock`, `POST /jobs/:id/pr`). Set `FORGE_AUTOPILOT=off` to drive every step
by hand instead.

### Full autonomy (`FORGE_AUTO_APPROVE=on`)

When the plan is finalized up front (e.g. by a Discovery session), you can drop
both human gates and let the pipeline run all the way to an open pull request:

- **FAST:** plan → implement → verify → review → qa → **open PR**
- **DEBATE / CRITICAL:** plan → debate → **auto-lock** → implement → verify → review →
  (security) → qa → **open PR**

The pull request stays the single human checkpoint — the worker still has no
merge path, so nothing ships without a person. Two things still halt short of a
PR rather than proposing bad work: an implementation that produced no diff, and
a deterministic check (`lint`/`build`) that actually failed. Unresolved
CRITICAL/HIGH objections from the debate do **not** block — they are carried
into the PR body so the reviewer meets them there. Off by default.

### Self-healing (`FORGE_REPAIR_ATTEMPTS`, `FORGE_RUN_RETRIES`)

Failures are triaged by *kind*, because the right response differs:

- **A failing check is fixable, so the worker fixes it.** When `lint`/`build`
  fails, the Builder is re-run with the exact failure fed back in and the change
  re-verified — up to `FORGE_REPAIR_ATTEMPTS` times (default 2). Only if it is
  still red at the end does the pipeline stop and leave it for a human.
- **A killed run is not fixable by re-reasoning, so it is not looped.** An
  OpenCode exit of **137** is a SIGKILL — inside a container, almost always the
  **OOM killer**, not a code bug (the worker's own timeout is exit 124, a missing
  tool 127). A kill or timeout is retried `FORGE_RUN_RETRIES` times (default 1)
  to ride out a transient spike, then the job halts with a message that names the
  real cause ("killed (137), almost certainly out of memory") instead of a bare
  code. Escalating to a bigger model is deliberately *not* done here — more
  context is more memory, which makes an OOM worse, not better.

If you see 137s repeatedly, the fix is upstream of the code: give the worker
more memory on Railway, or split the task so a single pass holds less at once.

Progress is written to the job and exposed by `GET /jobs/:id`. The worker cannot reach
Conviction's database, so for the Forge **UI** to reflect this live, Conviction must poll
`GET /jobs/:id` and mirror status / plan / checks into its own tables — otherwise the work
still happens (visible in the worker's logs and `GET /jobs/:id`) but the UI stays where it
was when the job was created.

### On-chain contracts (optional)

A worker can build Solidity too. Set `--build-arg INSTALL_FOUNDRY=true` (on Railway, an
`INSTALL_FOUNDRY=true` service variable, which is passed through at build time) and the image
gains Foundry — `forge`, `cast`, `anvil`. It is off by default so it adds nothing to the
image when unused. The recommended shape is a **dedicated contracts repo**: point a worker at
it via `REPO_FULL_NAME` and set `FORGE_CHECKS=build` (mapping to `forge build`/`forge test` in
that repo's scripts), and have belief-compass call the deployed contract address rather than
carrying the toolchain itself. Keeping money code in its own repo keeps the web app's build
fast and its review surface clean.

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
