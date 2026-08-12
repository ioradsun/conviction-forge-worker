#!/usr/bin/env bash
#
# Provision the Railway pieces that CANNOT live in railway.toml: the /workspace
# volume and the service variables. Idempotent — safe to re-run.
#
# Secrets are read from THIS shell's environment and never written to the repo.
# Set them first (e.g. in an untracked .env you `source`, or export inline):
#
#   export FORGE_WORKER_SECRET=…        # long random string; must match Conviction
#   export OPENROUTER_API_KEY=…         # OpenCode's model provider
#   export GITHUB_TOKEN=…               # fine-grained, scoped to belief-compass
#
# Then, from a linked project (run `railway link` once first):
#
#   ./scripts/railway-setup.sh
#
# Docs: https://docs.railway.com/reference/config-as-code
#       https://docs.railway.com/volumes

set -euo pipefail

# Optional: target a specific service by name (else Railway uses the linked one).
SERVICE="${RAILWAY_SERVICE:-}"
svc_args=()
[ -n "$SERVICE" ] && svc_args=(--service "$SERVICE")

command -v railway >/dev/null 2>&1 || {
  echo "The Railway CLI is required: https://docs.railway.com/cli" >&2
  exit 1
}

# Set KEY=VALUE across CLI versions: v4 uses `variables --set`, older ones a
# `set` subcommand. We detect which is available.
set_var() {
  if railway variables --help 2>/dev/null | grep -q -- "--set"; then
    railway variables "${svc_args[@]}" --set "$1"
  else
    railway variables "${svc_args[@]}" set "$1"
  fi
}

echo "→ Volume mounted at /workspace"
railway volume add "${svc_args[@]}" --mount-path /workspace \
  || echo "  (a volume at /workspace may already exist — continuing)"

echo "→ Non-secret configuration"
set_var "WORKSPACE_ROOT=/workspace"
set_var "REPO_FULL_NAME=ioradsun/belief-compass"
set_var "BASE_BRANCH=main"

echo "→ Secrets (from your shell environment; not stored in this file)"
: "${FORGE_WORKER_SECRET:?export FORGE_WORKER_SECRET before running}"
: "${OPENROUTER_API_KEY:?export OPENROUTER_API_KEY before running}"
: "${GITHUB_TOKEN:?export GITHUB_TOKEN before running}"
set_var "FORGE_WORKER_SECRET=${FORGE_WORKER_SECRET}"
set_var "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
set_var "GITHUB_TOKEN=${GITHUB_TOKEN}"

echo "✓ Volume and variables provisioned."
echo "  Deploy with:  railway up      (or just push to main)"
echo "  Then set FORGE_WORKER_URL + FORGE_WORKER_SECRET on the Conviction side."
