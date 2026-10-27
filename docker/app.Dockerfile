FROM node:24
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /workspace

# Dependency manifests only — keeps `pnpm install` cached across src edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/auth/package.json apps/auth/
COPY apps/platform/package.json apps/platform/
COPY apps/dispatcher/package.json apps/dispatcher/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/auth-core/package.json packages/auth-core/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db-auth/package.json packages/db-auth/
COPY packages/db-docbridge/package.json packages/db-docbridge/
COPY packages/db-platform/package.json packages/db-platform/
COPY packages/storage/package.json packages/storage/
COPY infra/package.json infra/
RUN pnpm install --frozen-lockfile

COPY . .
