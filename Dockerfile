# LightsOut runtime image (RT-01, ST-05).
# Build context expects `dist/` to be built on the host or in a builder stage.

FROM node:22-slim AS builder
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src/ ./src/
RUN npx tsc -p tsconfig.json

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

RUN useradd -m -u 1000 app
WORKDIR /opt/lightsout

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /build/dist/ ./dist/
COPY panel/ ./panel/
COPY templates/ ./templates/
COPY examples/ ./examples/

RUN mkdir -p /data /workspace && chown -R app:app /data /workspace /opt/lightsout

USER app
ENV NODE_ENV=production \
    LO_BIND=0.0.0.0 \
    LO_DB=/data/lightsout.db \
    LO_WORKSPACE=/workspace

EXPOSE 8484
ENTRYPOINT ["tini","--"]
CMD ["node","dist/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node","dist/healthcheck.js"]
