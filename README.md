# Marketplace (ERP + CRM)

Pet-проект: multi-vendor B2C маркетплейс на микросервисах. ERP и CRM взаимодействуют через события Kafka.

**Стек:** NestJS 12 · TypeScript 6 · PostgreSQL 16 · Prisma 7 · Kafka 4 (KRaft) · OpenTelemetry · Next.js · Nx 23 · pnpm 12 · Jest 30

## Быстрый старт

Нужны Node.js ≥ 24.11.1, pnpm 12 (`npm i -g pnpm@12.14.0`) и Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up      # Postgres, Kafka, Kafbat UI :8080, Jaeger :16686, Mailpit :8025
pnpm infra:smoke   # проверка инфраструктуры

pnpm nx run-many -t lint typecheck test build   # проверки без Docker
pnpm nx affected -t test-integration            # интеграционные тесты (Testcontainers)

pnpm nx g @repo/generators:service <name>       # новый сервис по шаблону
docker compose --profile core up -d --build     # инфраструктура и сервисы
```

## Документация
- [ТЗ](docs/TZ.md)
- [System Design: обзор](docs/system-design/00-overview.md)
- [System Design 01: каркас](docs/system-design/01-skeleton.md)
- [System Design 02: оформление без склада](docs/system-design/02-checkout-without-stock.md)
- [ADR](docs/adr/): архитектурные решения
- [CHANGELOG](CHANGELOG.md): журнал всех изменений

## Процесс
Каждый этап: System Design док → согласование → код → Jest-тесты → запись в CHANGELOG.
