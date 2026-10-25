#!/usr/bin/env bash
# E2E (SD-02, п. 9–10; SD-07, п. 8; SD-08, п. 6): стенд compose (profile full — с витриной и
# кабинетом) с настройками compose.e2e.yaml → демо-данные в read-моделях → сценарии через gateway
# (Jest) → сценарии витрины и кабинета в браузере (Playwright) → логи при ошибке → стенд удаляется.
set -euo pipefail

cd "$(dirname "$0")/../.."
[[ -f .env ]] || { echo 'нет .env: cp .env.example .env' >&2; exit 1; }

COMPOSE='docker compose -f compose.yaml -f compose.e2e.yaml --profile full'
compose() { $COMPOSE "$@"; }
SERVICES=(gateway auth catalog order payment erp crm notification fake-psp storefront backoffice)

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
# crm-replay (профиль tools) запускает сценарий 9 CRM: без готового образа `compose run` собирал
# бы его посреди теста, и сценарий не укладывался в таймаут
compose --profile tools build "${SERVICES[@]}" crm-replay
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
# наличие демо-SKU на витрине — из stock.level-changed, которые выпустил sync-levels (SD-07, п. 6)
until_rows catalog_db 'SELECT count(*) FROM sku_stock WHERE in_stock' 4
echo '::endgroup::'

# вход тестовых пользователей — паролем из .env, которым их завёл seed auth: и в Jest, и в
# Playwright (кабинет входит под продавцами и админом)
export DEV_USER_PASSWORD="$(sed -n 's/^DEV_USER_PASSWORD=//p' .env)"
E2E_COMPOSE="$COMPOSE" pnpm exec jest --config apps/e2e/jest.e2e.config.cjs

# витрина и кабинет в браузере (SD-07, решение 11; SD-08, решение 9): тот же стенд, только
# Chromium. В CI браузер вместе с системными библиотеками ставит шаг workflow; здесь — только
# браузер, если его ещё нет.
# Playwright, в отличие от Jest, берёт @repo/contracts из dist: его собирает таргет e2e (dependsOn)
echo '::group::браузер Playwright'
pnpm --filter @repo/e2e exec playwright install chromium
echo '::endgroup::'
pnpm --filter @repo/e2e exec playwright test

# метрики сервисов прошли путь сервис → OpenTelemetry Collector → Prometheus (SD-09, п. 4):
# HTTP, saga оформления, обработка сообщений, outbox и lag групп из Kafka
echo '::group::метрики в Prometheus'
has_metric() {
  curl -fsS -G http://localhost:9090/api/v1/query --data-urlencode "query=$1" | grep -q '"value"'
}
for query in \
  'http_server_request_duration_seconds_count{job="gateway"}' \
  'checkout_saga_transitions_total' \
  'messaging_process_duration_seconds_count' \
  'outbox_publish_delay_seconds_count' \
  'kafka_consumer_group_lag'; do
  has_metric "$query" || { echo "нет метрики в Prometheus: $query" >&2; exit 1; }
  echo "есть: $query"
done
echo '::endgroup::'
