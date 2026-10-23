#!/usr/bin/env bash
# E2E (SD-02, п. 9–10): стенд compose (profile core) с настройками compose.e2e.yaml → демо-данные
# в read-моделях → сценарии через gateway → логи при ошибке → стенд удаляется.
set -euo pipefail

cd "$(dirname "$0")/../.."
[[ -f .env ]] || { echo 'нет .env: cp .env.example .env' >&2; exit 1; }

compose() { docker compose -f compose.yaml -f compose.e2e.yaml --profile core "$@"; }
SERVICES=(gateway auth catalog order payment erp crm notification fake-psp)

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

# демо-данные приходят событиями catalog (SD-05, п. 7): ждём, пока их применят read-модели
count() { compose exec -T postgres psql -U postgres -d "$1" -tAq -c "$2"; }
until_rows() {
  local db=$1 sql=$2 expected=$3 got=''
  for _ in $(seq 1 90); do
    got="$(count "$db" "$sql" 2>/dev/null || true)"
    [[ "$got" == "$expected" ]] && { echo "$db: $expected"; return; }
    sleep 2
  done
  echo "$db: ждали $expected, есть ${got:-?} ($sql)" >&2
  exit 1
}
until_rows auth_db "SELECT count(*) FROM memberships WHERE seller_status = 'active'" 3
until_rows order_db 'SELECT count(*) FROM catalog_skus' 5
until_rows erp_db 'SELECT count(*) FROM catalog_skus' 5
until_rows payment_db 'SELECT count(*) FROM categories' 4
# тестовые пользователи (6) и магазины (2) — адресаты писем и профили crm (SD-06, решение 7)
until_rows crm_db 'SELECT count(*) FROM customers WHERE email IS NOT NULL' 6
until_rows notification_db 'SELECT count(*) FROM recipients' 6
until_rows notification_db 'SELECT count(*) FROM shops' 2
echo '::endgroup::'

# вход тестовых пользователей — паролем из .env, которым их завёл seed auth
DEV_USER_PASSWORD="$(sed -n 's/^DEV_USER_PASSWORD=//p' .env)" \
E2E_COMPOSE='docker compose -f compose.yaml -f compose.e2e.yaml --profile core' \
  pnpm exec jest --config apps/e2e/jest.e2e.config.cjs
