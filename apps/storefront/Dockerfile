# Образ витрины (SD-07, п. 8). Собирается из корня монорепо:
#   docker build -f apps/storefront/Dockerfile --target runtime .
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
RUN pnpm nx run @repo/storefront:build --output-style=static

# standalone-сборка от корня монорепо (ADR-0003, п. 6): server.js и только нужные ему
# node_modules; статику Next не кладёт в standalone сам — копируется отдельно
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/storefront/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/storefront/.next/static ./apps/storefront/.next/static
USER node
EXPOSE 3001
CMD ["node", "apps/storefront/server.js"]
