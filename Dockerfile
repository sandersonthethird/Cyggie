FROM node:22-bookworm-slim AS base
WORKDIR /app

# Build tooling for native deps. better-sqlite3 is transitively required by
# @cyggie/db (used by desktop, not gateway runtime) — npm ci needs to be able
# to download its prebuild or compile from source as a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy every workspace's package.json so npm ci sees the full monorepo layout.
# Required for the workspace resolver to wire @cyggie/db → packages/db on disk.
COPY package.json package-lock.json ./
COPY api-gateway/package.json ./api-gateway/
COPY packages/db/package.json ./packages/db/
COPY packages/services/package.json ./packages/services/
COPY packages/shared/package.json ./packages/shared/
COPY mobile/package.json ./mobile/

# --ignore-scripts skips root postinstall (electron-builder install-app-deps),
# which only matters for the desktop build, not the gateway.
RUN npm ci --include-workspace-root --ignore-scripts

# Copy sources. api-gateway is the runtime entry; packages/* is required because
# @cyggie/db re-exports schema imported by api-gateway/src.
COPY api-gateway ./api-gateway
COPY packages ./packages

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8443
# tsx loader runs TS source directly without a build step. Phase 0.6 stays on
# tsx for parity with `npm run dev`; an esbuild bundle can land later if image
# size becomes a constraint.

EXPOSE 8443
WORKDIR /app/api-gateway

CMD ["node", "--import", "tsx/esm", "src/server.ts"]
