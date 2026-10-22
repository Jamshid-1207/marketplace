#!/usr/bin/env bash
# generator-smoke (SD-01, п. 9; критерий 3): генерирует сервис demo и проверяет его целиком —
# задачи Nx, интеграционные тесты, совпадение схемы Prisma с миграциями, образ и запуск в compose
# с трейсами в Jaeger. Только для CI: генератор меняет рабочую копию.
set -euo pipefail

cd "$(dirname "$0")/../.."
if [[ "${CI:-}" != "true" ]]; then
  echo 'smoke.sh меняет рабочую копию и запускается только в CI (CI=true)' >&2
  exit 1
fi

step() { echo "::group::$*"; }
done_step() { echo '::endgroup::'; }

step 'генерация demo'
pnpm nx g @repo/generators:service demo --no-interactive
pnpm install --no-frozen-lockfile
done_step

step 'lint typecheck test build'
pnpm nx run-many -t lint typecheck test build -p @repo/demo --output-style=static
done_step

step 'интеграционные тесты demo (Testcontainers)'
pnpm nx run @repo/demo:test-integration --output-style=static
done_step

step 'инфраструктура'
cp .env.example .env
bash infra/up.sh
done_step

step 'схема Prisma совпадает с миграциями'
# иначе prisma migrate dev предложил бы миграцию, например удаление индекса из DDL libs
(
  cd apps/demo
  export DATABASE_URL="postgresql://demo_svc:demo_local@localhost:5432/demo_db"
  export SHADOW_DATABASE_URL="postgresql://demo_svc:demo_local@localhost:5432/demo_db_shadow"
  pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
)
done_step

step 'образ и запуск в compose'
docker compose --profile core up -d --build demo
for _ in $(seq 1 60); do
  curl -fsS http://localhost:3001/health/ready >/dev/null 2>&1 && break
  sleep 5
done
curl -fsS http://localhost:3001/health/ready
echo
done_step

step 'трейсы доходят до Jaeger, логи несут traceId'
# health-пробы не трейсятся, поэтому нужен обычный запрос; 404 тоже даёт спан HTTP
curl -s -o /dev/null http://localhost:3001/smoke || true
for _ in $(seq 1 30); do
  curl -fsS http://localhost:16686/api/services | grep -q '"demo"' && break
  sleep 2
done
curl -fsS http://localhost:16686/api/services | grep -q '"demo"'
docker compose logs demo | grep -q '"traceId"'
done_step

step 'служебная команда dlq-reprocess'
docker compose exec -T demo node dist/main.js dlq-reprocess
done_step

echo 'generator smoke: всё в порядке'
