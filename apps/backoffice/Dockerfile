# Образ кабинета продавца и админки (SD-08, п. 3.4). Собирается из корня монорепо:
#   docker build -f apps/backoffice/Dockerfile --target runtime .
ARG NODE_IMAGE=node:24.11.1-alpine

FROM ${NODE_IMAGE} AS base
RUN npm install -g pnpm@12.14.0 && npm cache clean --force
WORKDIR /repo
ENV NX_DAEMON=false NX_NO_CLOUD=true CI=true NEXT_TELEMETRY_DISABLED=1

# зависимости ставятся по lockfile до копирования исходников: слой переиспользуется
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile

FROM deps AS build
RUN pnpm nx run @repo/backoffice:build --output-style=static

# standalone-сборка от корня монорепо (ADR-0003, п. 6), как у витрины
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3002 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/backoffice/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/backoffice/.next/static ./apps/backoffice/.next/static
USER node
EXPOSE 3002
CMD ["node", "apps/backoffice/server.js"]
