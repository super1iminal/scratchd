# One image: the Fastify API plus the built web app it serves.
FROM node:26-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/

FROM base AS web
RUN --mount=type=cache,target=/root/.cache pnpm install --frozen-lockfile --store-dir /root/.cache/pnpm-store --filter @scratchd/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN --mount=type=cache,target=/root/.cache pnpm --filter @scratchd/web build

FROM base
ENV NODE_ENV=production
# pnpm itself, its metadata and its package store stay in a build cache, out of the image (~370 MB).
RUN --mount=type=cache,target=/root/.cache pnpm install --frozen-lockfile --store-dir /root/.cache/pnpm-store --prod --filter @scratchd/server...
COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
COPY --from=web /app/apps/web/dist apps/web/dist
USER node
EXPOSE 3000
# Node runs the TypeScript directly (type stripping), so there's no server build step.
CMD ["node", "apps/server/src/main.ts"]
