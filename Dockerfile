# Conviction Forge Worker — container image for Railway.
#
# Bun runtime + git + OpenCode (+ optional gstack). Bun runs the TypeScript
# source directly, so there is no separate build/transpile step to drift from
# the source. The service listens on 0.0.0.0:$PORT and keeps job checkouts under
# /workspace, which Railway mounts as a persistent Volume.

FROM oven/bun:1

# Build and run as root so apt, the OpenCode install, and the /workspace volume
# are writable regardless of the base image's default user.
USER root

# System tools: git for checkouts; curl + tar (the Linux OpenCode installer
# extracts a tarball) + unzip; ca-certificates for HTTPS to GitHub/OpenRouter.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl tar unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# OpenCode — the headless coding agent, installed as a standalone binary to
# $HOME/.opencode/bin. NON-FATAL by design: an optional agent tool must never
# block the service from deploying. If it fails, the implement/review/qa phases
# report "OpenCode not available" at runtime until it is fixed.
ENV PATH="/root/.opencode/bin:${PATH}"
RUN curl -fsSL https://opencode.ai/install | bash \
    || echo "WARNING: OpenCode install failed; agent phases will report unavailable."

# gstack — optional, hosted on OpenCode. Supply its source at build time:
#   docker build --build-arg GSTACK_REPO=<git-url> [--build-arg GSTACK_REF=<ref>]
# When omitted, the worker's gstack operations run directly through OpenCode.
ARG GSTACK_REPO=""
ARG GSTACK_REF="main"
ENV GSTACK_DIR="/opt/gstack"
RUN if [ -n "$GSTACK_REPO" ]; then \
      { git clone --depth 1 --branch "$GSTACK_REF" "$GSTACK_REPO" "$GSTACK_DIR" \
        && cd "$GSTACK_DIR" \
        && ./setup --host opencode ; } \
      || echo "WARNING: gstack setup failed; review/qa run via OpenCode directly." ; \
    else \
      echo "No GSTACK_REPO provided — gstack operations run via OpenCode directly." ; \
    fi

WORKDIR /app

# Dependencies first, for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Application source.
COPY tsconfig.json ./
COPY src ./src

# Note: no build-time typecheck — Bun runs the TypeScript directly, and type
# safety is enforced by `bun test` / `bun run typecheck` in dev/CI. Keeping tsc
# out of the image removes a needless failure vector from the deploy path.

ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/workspace
ENV PORT=8080
EXPOSE 8080

# Persistent checkout space lives on a Railway Volume mounted at /workspace
# (attach it in the dashboard or via scripts/railway-setup.sh). Railway rejects
# a Docker `VOLUME` instruction, so we deliberately do NOT declare one here.

CMD ["bun", "run", "src/index.ts"]
