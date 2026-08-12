# Conviction Forge Worker — container image for Railway.
#
# Bun runtime + git + OpenCode (+ optional gstack). Bun runs the TypeScript
# source directly, so there is no separate build/transpile step to drift from
# the source. The service listens on 0.0.0.0:$PORT and keeps job checkouts under
# /workspace, which Railway mounts as a persistent Volume.

FROM oven/bun:1

# System tools: git for the checkouts, curl/unzip/ca-certificates for the
# OpenCode installer and for HTTPS to GitHub/OpenRouter.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# OpenCode — the headless coding agent. Installed as a standalone binary.
# Pinned onto PATH at its default install location.
ENV PATH="/root/.opencode/bin:${PATH}"
RUN curl -fsSL https://opencode.ai/install | bash

# gstack — optional, hosted on OpenCode. Supply its source at build time:
#   docker build --build-arg GSTACK_REPO=<git-url> [--build-arg GSTACK_REF=<ref>]
# When omitted, the worker's gstack operations run directly through OpenCode.
ARG GSTACK_REPO=""
ARG GSTACK_REF="main"
ENV GSTACK_DIR="/opt/gstack"
RUN if [ -n "$GSTACK_REPO" ]; then \
      git clone --depth 1 --branch "$GSTACK_REF" "$GSTACK_REPO" "$GSTACK_DIR" \
      && cd "$GSTACK_DIR" \
      && ./setup --host opencode ; \
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

# Fail the build on a type error rather than at runtime.
RUN bunx tsc --noEmit

ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/workspace
ENV PORT=8080
EXPOSE 8080

# Persistent checkout space. On Railway, attach a Volume mounted at /workspace.
VOLUME ["/workspace"]

CMD ["bun", "run", "src/index.ts"]
