#!/usr/bin/env bash
# E2E этапа 2 (SD-02, п. 9–10): стенд compose (profile core) с настройками compose.e2e.yaml →
# сценарии через gateway → логи при ошибке → стенд удаляется.
set -euo pipefail

cd "$(dirname "$0")/../.."
[[ -f .env ]] || { echo 'нет .env: cp .env.example .env' >&2; exit 1; }

compose() { docker compose -f compose.yaml -f compose.e2e.yaml --profile core "$@"; }
SERVICES=(gateway order payment erp fake-psp)

finish() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo '::group::логи стенда'
    compose logs --no-color --tail 400 || true
    echo '::endgroup::'
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap finish EXIT

echo '::group::сборка образов'
compose build "${SERVICES[@]}"
echo '::endgroup::'

echo '::group::инфраструктура и сервисы'
bash infra/up.sh
# `up --wait` считает ошибкой одноразовые шаги миграций, поэтому готовность ждём сами
compose up -d "${SERVICES[@]}"
for service in "${SERVICES[@]}"; do
  for _ in $(seq 1 90); do
    health="$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q "$service")" 2>/dev/null || true)"
    [[ "$health" == healthy ]] && break
    sleep 2
  done
  [[ "$health" == healthy ]] || { echo "$service не готов: $health" >&2; exit 1; }
  echo "$service готов"
done
echo '::endgroup::'

E2E_COMPOSE='docker compose -f compose.yaml -f compose.e2e.yaml --profile core' \
  pnpm exec jest --config apps/e2e/jest.e2e.config.cjs
