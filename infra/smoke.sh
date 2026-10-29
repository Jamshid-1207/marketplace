#!/usr/bin/env bash
# Проверка критерия 1 SD-01: инфраструктура поднята и настроена. Запуск после
# docker compose --profile infra up -d --wait (локально или в CI job infra-smoke).
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() { echo "ok: $*"; }

# 1. Долгоживущие контейнеры healthy, одноразовые завершились с кодом 0
for svc in postgres kafka kafbat-ui jaeger mailpit prometheus grafana; do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q "$svc")")"
  [[ "$health" == healthy ]] || fail "$svc: $health"
done
ok 'контейнеры healthy'

for svc in db-provision kafka-init; do
  code="$(docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq "$svc")")"
  [[ "$code" == 0 ]] || fail "$svc завершился с кодом $code"
done
ok 'db-provision и kafka-init завершились успешно'

# 2. Базы и владельцы по services.txt
psql_su() { docker compose exec -T postgres psql -U postgres -tAq "$@"; }

while read -r name; do
  for db in "${name}_db" "${name}_db_shadow"; do
    owner="$(psql_su -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$db'")"
    [[ "$owner" == "${name}_svc" ]] || fail "$db: владелец '$owner', ожидался ${name}_svc"
  done
done < <(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' infra/postgres/services.txt)
ok 'базы и владельцы соответствуют services.txt'

# 3. Изоляция: пользователь сервиса входит по паролю в свою базу и не может подключиться к чужой
psql_as() {
  local user=$1 pass=$2 db=$3
  docker compose exec -T -e PGPASSWORD="$pass" postgres \
    psql -h postgres -U "$user" -d "$db" -tAqc 'SELECT 1' 2>&1
}
[[ "$(psql_as order_svc "$ORDER_DB_PASSWORD" order_db)" == 1 ]] || fail 'order_svc не входит в order_db'
# psql здесь завершается с ошибкой — это и ожидается; вывод проверяем отдельно (pipefail)
foreign="$(psql_as order_svc "$ORDER_DB_PASSWORD" payment_db || true)"
[[ "$foreign" == *'permission denied for database'* ]] || fail "order_svc подключился к payment_db: $foreign"
ok 'пароль сервиса работает, чужая база недоступна (REVOKE CONNECT)'

# 4. Топики по topics.conf: существуют, число партиций совпадает
kafka() { docker compose exec -T kafka "/opt/kafka/bin/$1" --bootstrap-server kafka:29092 "${@:2}"; }

while read -r topic partitions _; do
  actual="$(kafka kafka-topics.sh --describe --topic "$topic" |
    sed -n 's/.*PartitionCount: *\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  [[ "$actual" == "$partitions" ]] || fail "$topic: партиций '$actual', ожидалось $partitions"
done < <(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' infra/kafka/topics.conf)
ok 'топики соответствуют topics.conf'

# 5. UI отвечают с хоста
for url in http://localhost:8080 http://localhost:16686 http://localhost:8025 http://localhost:3005; do
  curl -fsS -o /dev/null "$url" || fail "$url не отвечает"
done
ok 'Kafbat UI, Jaeger, Mailpit, Grafana отвечают'

# 6. Наблюдаемость (SD-09, п. 4): Collector жив, Grafana с источниками и дашбордами,
# метрики Kafka доходят до Prometheus, тестовый спан через Collector — до Jaeger
docker compose exec -T prometheus wget -qO- http://otel-collector:13133/ >/dev/null ||
  fail 'otel-collector не отвечает на health_check'
datasources="$(curl -fsS http://localhost:3005/api/datasources)"
[[ "$datasources" == *'"uid":"prometheus"'* && "$datasources" == *'"uid":"jaeger"'* ]] ||
  fail "Grafana: нет источников Prometheus и Jaeger: $datasources"
[[ "$(curl -fsS 'http://localhost:3005/api/search?query=')" == *'"folderTitle":"Marketplace"'* ]] ||
  fail 'Grafana: нет дашбордов в папке Marketplace'
# источник Jaeger в Grafana ходит в HTTP API v1: его нет в Jaeger 2.21+ (compose.yaml)
jaeger_health="$(curl -sS http://localhost:3005/api/datasources/uid/jaeger/health)"
[[ "$jaeger_health" == *'"status":"OK"'* ]] || fail "Grafana: источник Jaeger не работает: $jaeger_health"
ok 'Collector отвечает, у Grafana источники и дашборды из репозитория, Jaeger отвечает Grafana'

until_true() {
  local what=$1 check=$2
  for _ in $(seq 1 30); do
    eval "$check" && return
    sleep 2
  done
  fail "не дождались: $what"
}
until_true 'метрика kafka_brokers в Prometheus' \
  "curl -fsS 'http://localhost:9090/api/v1/query?query=kafka_brokers' | grep -q '\"value\"'"
ok 'метрики Kafka: Collector → Prometheus'

start="$(date +%s%N)"
trace_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
span='{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"infra-smoke"}}]},"scopeSpans":[{"spans":[{"traceId":"'"$trace_id"'","spanId":"eee19b7ec3c1b174","name":"smoke","kind":1,"startTimeUnixNano":"'"$start"'","endTimeUnixNano":"'"$((start + 1000000))"'"}]}]}]}'
curl -fsS -o /dev/null -H 'content-type: application/json' -d "$span" http://localhost:4318/v1/traces ||
  fail 'Collector не принял спан'
until_true 'спан infra-smoke в Jaeger' \
  "curl -fsS http://localhost:16686/api/v3/services | grep -q infra-smoke"
ok 'трейсы: Collector → Jaeger'

echo 'infra smoke: всё в порядке'
