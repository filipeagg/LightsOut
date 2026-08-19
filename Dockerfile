# LightsOut runtime image (RT-01, ST-05).
# Build context expects `dist/` to be built on the host or in a builder stage.

FROM node:22-slim AS builder
# node:22-slim ships npm 10.9.8, whose arborist crashes resolving vitest's optional peer set
# ("Cannot read properties of null (reading 'edgesOut')") since @vitejs/devtools-vitest started
# publishing 0.4.x. Nothing in this repo changed; the registry did. npm 12 resolves it, so both
# stages that install devDependencies pin it. Pinned, not @latest, so the build stays reproducible.
RUN npm install -g npm@12.0.2 --no-audit --no-fund
WORKDIR /build
COPY package*.json tsconfig.json ./
# --ignore-scripts: the builder only typechecks/emits JS, so native modules
# (better-sqlite3) must not be compiled here. The runtime stage builds them.
RUN npm install --ignore-scripts --no-audit --no-fund
COPY src/ ./src/
COPY scripts/copy-assets.mjs ./scripts/
RUN npx tsc -p tsconfig.json && node scripts/copy-assets.mjs

# Test stage: dev dependencies plus the toolchain better-sqlite3 needs.
# Built and run by scripts/verify/phase2.sh; not part of the runtime image.
FROM node:22-slim AS test
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Same npm pin as the builder stage, and for the same reason.
RUN npm install -g npm@12.0.2 --no-audit --no-fund
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src/ ./src/
COPY test/ ./test/
COPY examples/ ./examples/
COPY builtin/ ./builtin/
COPY scaffold/ ./scaffold/
CMD ["npm", "test"]

# Runtime stage. Named so the release workflow can target it explicitly (SU-01).
FROM node:22-slim AS runtime

# python3-pip is not a convenience: without it an agent that needs a library reaches for
# `ensurepip`, which writes into the interpreter's own directory — outside the workspace, and so
# denied by the hard floor of PE-03, which no grant can lift. The image must ship the toolchain,
# because an agent can never install it (ST-03b, DESIGN §3.2).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates tini python3 python3-pip python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/*

# ST-08: system packages a project asked for and the user approved. One file per project, each a
# machine-first list of package names; the build installs the union. Empty by default, so a clean
# checkout installs nothing extra. LightsOut writes these files but never runs this build — a
# container that can rebuild its own image can replace itself with a different one.
COPY toolchain.d/ /tmp/toolchain.d/
RUN set -eu; \
    pkgs="$(cat /tmp/toolchain.d/*.txt 2>/dev/null | grep -v '^\s*#' | grep -v '^\s*$' | sort -u | tr '\n' ' ')"; \
    if [ -n "$pkgs" ]; then \
      echo "toolchain.d requests: $pkgs"; \
      apt-get update && apt-get install -y --no-install-recommends $pkgs \
      && rm -rf /var/lib/apt/lists/*; \
    fi; \
    rm -rf /tmp/toolchain.d

# Same npm pin as the builder and test stages: `--omit=dev` still resolves the whole tree before
# pruning it, so the runtime install hits the identical arborist crash.
RUN npm install -g npm@12.0.2 --no-audit --no-fund

# Engine CLIs and ACP adapters, pinned (see doc/DECISIONS.md).
RUN npm install -g --no-audit --no-fund \
      @anthropic-ai/claude-code@2.1.219 \
      @openai/codex@0.145.0 \
      @agentclientprotocol/claude-agent-acp@0.62.0 \
      @agentclientprotocol/codex-acp@1.1.7

# node:22-slim already ships a uid 1000 user named "node"; rename it to app with
# home /home/app so the credential volumes mount where the design expects (RT-03).
RUN usermod -l app -d /home/app -m node \
    && groupmod -n app node
WORKDIR /opt/lightsout

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /build/dist/ ./dist/
COPY panel/ ./panel/
COPY scaffold/ ./scaffold/
COPY examples/ ./examples/
# The builtin library: never written to at runtime, so `docker pull` updates it without
# touching anything the user changed in the workspace (BA-01, TP-02, DESIGN §2).
COPY builtin/ ./builtin/

# The credential directories must exist in the image and belong to app: Docker
# initialises a named volume from the image path, so an absent path would be
# created as root and the engines could not write their tokens (RT-03, RT-04).
RUN mkdir -p /data /workspace /toolchains /home/app/.claude /home/app/.codex \
    && chown -R app:app /data /workspace /toolchains /opt/lightsout /home/app

USER app
# CLAUDE_CONFIG_DIR / CODEX_HOME point both engines entirely inside their mounted
# volumes. Claude Code otherwise keeps ~/.claude.json in the container layer, which
# a rebuild would discard together with the login state (RT-03).
ENV NODE_ENV=production \
    LO_BIND=0.0.0.0 \
    LO_DB=/data/lightsout.db \
    LO_WORKSPACE=/workspace \
    CLAUDE_CONFIG_DIR=/home/app/.claude \
    CODEX_HOME=/home/app/.codex

# 8484 panel/API/MCP, 1455 the engine OAuth callback the login forwarder serves (SU-04),
# 5170-5189 the preview pool (PV-01).
EXPOSE 8484 1455 5170-5189
ENTRYPOINT ["tini","--"]
CMD ["node","dist/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node","dist/healthcheck.js"]
