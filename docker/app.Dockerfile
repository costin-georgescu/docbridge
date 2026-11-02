FROM node:24
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /workspace
RUN chown node:node /workspace

# Dependency manifests only — keeps `pnpm install` cached across src edits.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/auth/package.json apps/auth/
COPY --chown=node:node apps/platform/package.json apps/platform/
COPY --chown=node:node apps/dispatcher/package.json apps/dispatcher/
COPY --chown=node:node apps/worker/package.json apps/worker/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/auth-core/package.json packages/auth-core/
COPY --chown=node:node packages/config/package.json packages/config/
COPY --chown=node:node packages/contracts/package.json packages/contracts/
COPY --chown=node:node packages/db-auth/package.json packages/db-auth/
COPY --chown=node:node packages/db-docbridge/package.json packages/db-docbridge/
COPY --chown=node:node packages/db-platform/package.json packages/db-platform/
COPY --chown=node:node packages/storage/package.json packages/storage/
COPY --chown=node:node packages/rate-limit/package.json packages/rate-limit/
COPY --chown=node:node infra/package.json infra/

# Install and codegen as the runtime user so node_modules, generated Prisma
# clients and the pnpm store stay writable/readable without a chown layer.
USER node
RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .
RUN pnpm db:generate

# Set after install so devDependencies (tsx, prisma CLI) are still installed.
ENV NODE_ENV=production

# Production entrypoint; a compiled slim image is a later optimisation.
# docker-compose overrides this with `pnpm --filter @docbridge/<app> dev`.
# ENV (not bare ARG) so the shell CMD expands @docbridge/${APP} at runtime.
ARG APP
ENV APP=${APP}
CMD pnpm --filter @docbridge/${APP} start
