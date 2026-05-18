FROM node:22-bookworm-slim AS base
WORKDIR /app

# Build tooling for native deps. better-sqlite3 is transitively required by
# @cyggie/db (used by desktop, not gateway runtime) — pnpm needs to be able
# to download its prebuild or compile from source as a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (bundled with Node 22). Pin to the exact version we use
# locally so cloud builds are reproducible.
ENV PNPM_VERSION=11.1.3
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy every workspace's package.json so pnpm sees the full monorepo layout.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY api-gateway/package.json ./api-gateway/
COPY packages/db/package.json ./packages/db/
COPY packages/services/package.json ./packages/services/
COPY packages/shared/package.json ./packages/shared/
COPY mobile/package.json ./mobile/

# --ignore-scripts skips root postinstall (electron-builder install-app-deps),
# which only matters for the desktop build, not the gateway.
# --frozen-lockfile asserts the lockfile is in sync with package manifests —
# fails the build if someone edits a package.json without updating the lock.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy sources. api-gateway is the runtime entry; packages/* is required because
# @cyggie/db re-exports schema imported by api-gateway/src.
COPY api-gateway ./api-gateway
COPY packages ./packages
# Root tsconfig — api-gateway/tsconfig.json extends ../tsconfig.node.json which
# carries the @cyggie/* path mappings tsx uses to resolve workspace packages
# at runtime. Without it: ERR_MODULE_NOT_FOUND for @cyggie/db.
COPY tsconfig.json tsconfig.node.json ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8443
# tsx loader runs TS source directly without a build step. Phase 0.6 stays on
# tsx for parity with `pnpm dev`; an esbuild bundle can land later if image
# size becomes a constraint.

EXPOSE 8443
WORKDIR /app/api-gateway

# tsx reads api-gateway/tsconfig.json → extends ../tsconfig.node.json →
# resolves @cyggie/db via its `paths` mapping to ./packages/db/src. No
# special NODE_PATH or pnpm runtime needed.
CMD ["node", "--import", "tsx/esm", "src/server.ts"]
