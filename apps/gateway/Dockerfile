# Образ сервиса gateway (SD-01, п. 7). Собирается из корня монорепо:
#   docker build -f apps/gateway/Dockerfile --target runtime .
ARG NODE_IMAGE=node:24.11.1-alpine

FROM ${NODE_IMAGE} AS base
RUN npm install -g pnpm@12.14.0 && npm cache clean --force
WORKDIR /repo
ENV NX_DAEMON=false NX_NO_CLOUD=true CI=true

# зависимости ставятся по lockfile до копирования исходников: слой переиспользуется
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile

FROM deps AS build
RUN pnpm nx run @repo/gateway:build --output-style=static
# только production-зависимости сервиса и нужные ему workspace-пакеты
RUN pnpm --filter @repo/gateway deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 3000
# instrumentation грузится до main.js: OpenTelemetry должен подменить модули до их импорта
CMD ["node", "--require", "./dist/instrumentation.js", "dist/main.js"]
