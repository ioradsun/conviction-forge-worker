# Conviction Forge Worker — container image for Railway.
#
# Bun runtime + git + OpenCode + gstack. Bun runs the TypeScript
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

# gstack — the engineering skills, installed into OpenCode's global skill dir
# (~/.config/opencode/skills/gstack-*) via its OpenCode host setup. This is what
# turns OpenCode into the "engineering team": /office-hours, /autoplan, /review,
# /cso, /qa, /ship, … Non-fatal so a browser-build hiccup can't block the deploy;
# the skills still register. Override the source with --build-arg GSTACK_REF=<ref>.
ARG GSTACK_REPO="https://github.com/garrytan/gstack"
ARG GSTACK_REF="main"
ENV GSTACK_DIR="/opt/gstack"
RUN { git clone --single-branch --depth 1 --branch "$GSTACK_REF" "$GSTACK_REPO" "$GSTACK_DIR" \
      && cd "$GSTACK_DIR" \
      && ./setup --host opencode ; } \
    || echo "WARNING: gstack setup incomplete; some skills may be unavailable at runtime."

# OpenCode provider config, GLOBAL so it sits beside the gstack skills (the same
# ~/.config/opencode OpenCode reads at runtime). The OpenRouter key is referenced
# by env name — never baked into the image.
RUN mkdir -p /root/.config/opencode \
    && printf '%s\n' '{ "$schema": "https://opencode.ai/config.json", "provider": { "openrouter": { "options": { "apiKey": "{env:OPENROUTER_API_KEY}" } } } }' \
       > /root/.config/opencode/opencode.json

# Foundry — the Solidity toolchain (forge/cast/anvil), for jobs that build or
# test on-chain contracts. OFF by default so it adds nothing to the image when
# unused; enable with --build-arg INSTALL_FOUNDRY=true (on Railway, set an
# INSTALL_FOUNDRY=true service variable — it is passed through as a build arg).
# The PATH entry is set unconditionally and harmlessly: if Foundry was not
# installed the directory is simply empty, so `forge` is "not found" rather than
# silently wrong. Non-fatal, like the other agent tools.
ARG INSTALL_FOUNDRY="false"
ENV PATH="/root/.foundry/bin:${PATH}"
RUN if [ "$INSTALL_FOUNDRY" = "true" ] || [ "$INSTALL_FOUNDRY" = "1" ]; then \
      { curl -L https://foundry.paradigm.xyz | bash && /root/.foundry/bin/foundryup ; } \
        || echo "WARNING: Foundry install failed; contract build/test will report unavailable." ; \
    else \
      echo "Foundry install skipped (set INSTALL_FOUNDRY=true to enable)." ; \
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
