#!/usr/bin/env bash
# Поднимает инфраструктуру (SD-01, п. 5). `up --wait` считает ошибкой любой завершившийся
# контейнер, даже с кодом 0, поэтому долгоживущие и одноразовые запускаются раздельно.
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo 'нет .env: cp .env.example .env' >&2; exit 1; }

compose() { docker compose --profile infra "$@"; }

compose up -d --wait --wait-timeout 300 postgres kafka kafbat-ui jaeger mailpit
compose up -d db-provision kafka-init
compose wait db-provision kafka-init >/dev/null

for svc in db-provision kafka-init; do
  code="$(docker inspect -f '{{.State.ExitCode}}' "$(compose ps -aq "$svc")")"
  if [[ "$code" != 0 ]]; then
    compose logs --no-color "$svc" >&2
    echo "$svc завершился с кодом $code" >&2
    exit 1
  fi
done

echo 'infra готова'
