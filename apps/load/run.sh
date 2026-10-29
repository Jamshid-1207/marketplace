#!/usr/bin/env bash
# Нагрузочный прогон (SD-09, п. 3): стенд compose (профиль full, без фронтов) с compose.load.yaml →
# демо-данные в read-моделях → k6: каталог, оформление с оплатой, кабинет; пороги — целевые
# показатели SD-09, п. 2 → проверки после нагрузки (п. 1, сценарии 4–5): задержка outbox,
# lag групп, журнал денег, сверка расчётов с реестром продаж → логи при ошибке → стенд удаляется.
set -euo pipefail

cd "$(dirname "$0")/../.."
[[ -f .env ]] || { echo 'нет .env: cp .env.example .env' >&2; exit 1; }

COMPOSE='docker compose -f compose.yaml -f compose.load.yaml --profile full'
compose() { $COMPOSE "$@"; }
SERVICES=(gateway auth catalog order payment erp crm notification fake-psp)
OUT=apps/load/test-output
GATEWAY=http://localhost:3000
PROMETHEUS=http://localhost:9090

finish() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo '::group::логи стенда'
    compose logs --no-color --tail 200 || true
    echo '::endgroup::'
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap finish EXIT

echo '::group::сборка образов'
compose build "${SERVICES[@]}"
compose --profile tools pull k6
echo '::endgroup::'

echo '::group::инфраструктура и сервисы'
bash infra/up.sh
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
until_rows catalog_db 'SELECT count(*) FROM sku_stock WHERE in_stock' 4
echo '::endgroup::'

echo '::group::данные k6'
mkdir -p "$OUT"
chmod 777 "$OUT" # k6 в контейнере — не root: отчёт пишет сюда
pnpm --filter @repo/load exec node scripts/data.cjs >"$OUT/data.json"
echo '::endgroup::'

# подбор ёмкости (SD-09, ревизия 3): LOAD_SWEEP="1 2 3" — k6 на каждом потоке заказов по 2 минуты
# при тех же каталоге и кабинете, таблица p95 в мс; пороги и проверки — только в обычном прогоне
if [[ -n "${LOAD_SWEEP:-}" ]]; then
  echo '::group::подбор ёмкости'
  printf 'заказ/с\tкаталог\tкабинет\tзаказ\tCONFIRMED\tзависших\tпропущено\n'
  for rate in $LOAD_SWEEP; do
    compose --profile tools run --rm -e CHECKOUT_RATE="$rate" -e RAMP=30s -e HOLD=2m k6 run \
      --summary-export="/out/sweep-$rate.json" marketplace.k6.js >"$OUT/sweep-$rate.log" 2>&1 || true
    jq -r --arg rate "$rate" '.metrics as $m | [$rate,
        ($m["http_req_duration{scenario:catalog}"]["p(95)"] | floor),
        ($m["http_req_duration{scenario:cabinet}"]["p(95)"] | floor),
        ($m["http_req_duration{scenario:checkout,step:order}"]["p(95)"] | floor),
        (($m.checkout_confirm_duration["p(95)"] // 0) | floor),
        ($m.checkout_unconfirmed.count // 0),
        ($m.dropped_iterations.count // 0)] | @tsv' "$OUT/sweep-$rate.json"
    sleep 60 # очередь saga прошлой ступени не должна мешать следующей
  done
  echo '::endgroup::'
  exit 0
fi

started="$(date +%s)"
# CPU и память контейнеров во время нагрузки: где узкое место стенда
(while sleep 20; do
  echo "--- $(date +%T)"
  docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
done) >"$OUT/docker-stats.txt" 2>&1 &
stats_pid=$!
k6_status=0
compose --profile tools run --rm k6 run --summary-export=/out/summary.json marketplace.k6.js ||
  k6_status=$?
kill "$stats_pid" 2>/dev/null || true

# проверки после нагрузки (SD-09, п. 1, сценарии 4–5)
failures=0
problem() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}
prom() {
  curl -fsS -G "$PROMETHEUS/api/v1/query" --data-urlencode "query=$1" |
    jq -r '.data.result[0].value[1] // "0"'
}
# все ряды запроса: «метки = значение»
prom_table() {
  curl -fsS -G "$PROMETHEUS/api/v1/query" --data-urlencode "query=$1" |
    jq -r '.data.result[] | "\(.metric | to_entries | map(.value) | join(" ")) = \(.value[1])"' |
    sort
}
window="$(($(date +%s) - started))s"

echo '::group::диагностика нагрузки'
echo '# средняя загрузка CPU по контейнерам за прогон, %'
awk '$2 ~ /%$/ { gsub("%", "", $2); sum[$1] += $2; n[$1]++ }
  END { for (c in sum) printf "%7.1f  %s\n", sum[c] / n[c], c }' "$OUT/docker-stats.txt" | sort -rn
echo '# p95 ответа по сервисам, с'
prom_table "histogram_quantile(0.95, sum by (job, le) (rate(http_server_request_duration_seconds_bucket[$window])))"
echo '# p95 обработки сообщения по обработчикам, с'
prom_table "histogram_quantile(0.95, sum by (handler, le) (rate(messaging_process_duration_seconds_bucket[$window])))"
echo '# повторы обработчиков'
prom_table "sum by (handler) (increase(messaging_process_retries_total[$window])) > 0"
echo '# максимальный lag по группам'
prom_table "max by (group) (max_over_time({__name__=~\"kafka_consumer_group_lag(_ratio)?\"}[$window]))"
echo '# переходы saga за прогон'
prom_table "sum by (to) (increase(checkout_saga_transitions_total[$window]))"
echo '::endgroup::'

outbox_max="$(prom "max(max_over_time(outbox_oldest_unpublished_age_seconds[$window]))")"
echo "outbox: самая старая неотправленная запись под нагрузкой — ${outbox_max} с (цель < 10)"
awk -v v="$outbox_max" 'BEGIN { exit !(v < 10) }' || problem "задержка outbox ${outbox_max} с"

# у lag единица «1»: перевод в Prometheus добавляет суффикс _ratio
lag=''
for _ in $(seq 1 24); do
  lag="$(prom 'sum({__name__=~"kafka_consumer_group_lag(_ratio)?"})')"
  [[ "$lag" == 0 ]] && break
  sleep 5
done
echo "lag групп потребителей после нагрузки: $lag (цель 0)"
[[ "$lag" == 0 ]] || problem "lag групп не дошёл до нуля: $lag"

password="$(sed -n 's/^DEV_USER_PASSWORD=//p' .env)"
token() {
  curl -fsS "$GATEWAY/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$password\"}" | jq -r .accessToken
}
get() { curl -fsS "$GATEWAY$2" -H "authorization: Bearer $1"; }

check="$(get "$(token "$(jq -r .admin "$OUT/data.json")")" /api/admin/ledger/check)"
echo "сверка журнала: $check"
[[ "$(jq -r .ok <<<"$check")" == true ]] || problem "журнал денег: $check"

# расчёты payment сходятся с реестром продаж erp у каждого продавца (SD-04, п. 7)
for email in $(jq -r '.sellers[].email' "$OUT/data.json"); do
  seller="$(token "$email")"
  finance="$(get "$seller" /api/seller/finance/summary | jq -c '{grossMinor, subOrders}')"
  sales="$(get "$seller" /api/seller/sales/summary | jq -c '{grossMinor, subOrders}')"
  echo "$email: расчёты $finance, реестр продаж $sales"
  [[ "$finance" == "$sales" ]] || problem "$email: расчёты $finance ≠ реестр $sales"
done

if [[ $k6_status -ne 0 ]]; then
  echo "k6 завершился с кодом $k6_status: порог SD-09, п. 2 не выполнен" >&2
  exit "$k6_status"
fi
[[ $failures -eq 0 ]] || exit 1
echo 'нагрузочный прогон: целевые показатели выполнены'
