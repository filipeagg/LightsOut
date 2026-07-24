# LightsOut runtime image (RT-01, ST-05).
# Build context expects `dist/` to be built on the host or in a builder stage.

FROM node:22-slim AS builder
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
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src/ ./src/
COPY test/ ./test/
COPY examples/ ./examples/
CMD ["npm", "test"]

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates tini python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

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
COPY templates/ ./templates/
COPY examples/ ./examples/

# The credential directories must exist in the image and belong to app: Docker
# initialises a named volume from the image path, so an absent path would be
# created as root and the engines could not write their tokens (RT-03, RT-04).
RUN mkdir -p /data /workspace /home/app/.claude /home/app/.codex \
    && chown -R app:app /data /workspace /opt/lightsout /home/app

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

EXPOSE 8484
ENTRYPOINT ["tini","--"]
CMD ["node","dist/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node","dist/healthcheck.js"]
