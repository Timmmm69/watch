FROM node:24.18.0-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.20.0
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# Generation requires a URL, but does not connect to a database.
RUN DATABASE_URL=postgresql://unused:unused@localhost/watch pnpm db:generate
RUN pnpm build:packages && pnpm --filter @watch/api build

FROM build AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @watch/web build

FROM base AS production-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM production-deps AS api
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/prisma/migrations packages/db/prisma/migrations
COPY --chmod=755 ops/docker/runtime-secrets.sh /usr/local/bin/runtime-secrets
ENV NODE_ENV=production
USER node
ENTRYPOINT ["runtime-secrets"]
CMD ["node", "apps/api/dist/server.js"]

# The one-shot image keeps Prisma/tsx for explicit operator commands; services
# never execute migrations or initialization on their own startup.
FROM build AS migrate
COPY --chmod=755 ops/docker/runtime-secrets.sh /usr/local/bin/runtime-secrets
COPY --chmod=755 ops/docker/migrate.sh /usr/local/bin/watch-migrate
ENV NODE_ENV=production
USER node
ENTRYPOINT ["runtime-secrets"]
CMD ["watch-migrate"]

FROM production-deps AS web
COPY --from=web-build --chown=node:node /app/apps/web/.next apps/web/.next
COPY --from=web-build /app/apps/web/next.config.ts apps/web/next.config.ts
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
USER node
WORKDIR /app/apps/web
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
