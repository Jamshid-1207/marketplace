# Marketplace (ERP + CRM)

Pet-проект: multi-vendor B2C маркетплейс на микросервисах. ERP и CRM взаимодействуют через события Kafka.

**Стек:** NestJS 12 · TypeScript 6 · PostgreSQL 16 · Prisma 7 · Kafka 4 (KRaft) · OpenTelemetry · Next.js · Nx 23 · pnpm 12 · Jest 30

## Быстрый старт

Нужны Node.js ≥ 24.11.1, pnpm 12 (`npm i -g pnpm@12.14.0`) и Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up      # Postgres, Kafka, Kafbat UI :8080, Jaeger :16686, Grafana :3005, Prometheus :9090, Mailpit :8025
pnpm infra:smoke   # проверка инфраструктуры

pnpm nx run-many -t lint typecheck test build   # проверки без Docker
pnpm nx affected -t test-integration            # интеграционные тесты (Testcontainers)
pnpm nx run @repo/load:load                     # нагрузочный прогон k6 на всём стенде (SD-09), ~15 минут

pnpm nx g @repo/generators:service <name>       # новый сервис по шаблону
docker compose --profile core up -d --build     # инфраструктура и сервисы
docker compose --profile full up -d --build     # и фронты: витрина http://localhost:3001 (SD-07), кабинет http://localhost:3002 (SD-08)
```

На витрине — демо-товары магазинов A и B (`SEED_SHOWCASE=true`). Тестовый покупатель — `buyer-1@marketplace.test` с паролем `DEV_USER_PASSWORD` из `.env`; можно и зарегистрироваться. Оплата — кнопкой «Оплатить» на странице `fake-psp` (порт 4000).

В кабинет входят тем же паролем: владелец магазина A — `seller-a@marketplace.test`, сотрудник магазина A только с правом заказов — `manager-a@marketplace.test`, админ платформы — `admin@marketplace.test`. Новый пользователь открывает свой магазин на странице «Открыть магазин»: кабинет доступен сразу, а товары попадут на витрину, когда админ одобрит магазин и сами товары.

## Документация
- [ТЗ](docs/TZ.md)
- [System Design: обзор](docs/system-design/00-overview.md)
- [System Design 01: каркас](docs/system-design/01-skeleton.md)
- [System Design 02: оформление без склада](docs/system-design/02-checkout-without-stock.md)
- [System Design 03: склад](docs/system-design/03-warehouse.md)
- [System Design 04: деньги](docs/system-design/04-money.md)
- [System Design 05: продавцы и каталог](docs/system-design/05-sellers-and-catalog.md)
- [System Design 06: CRM и уведомления](docs/system-design/06-crm-and-notifications.md)
- [System Design 07: витрина](docs/system-design/07-storefront.md)
- [System Design 08: кабинет продавца и админка](docs/system-design/08-backoffice.md)
- [System Design 09: hardening — нагрузка, метрики, RLS](docs/system-design/09-hardening.md)
- [ADR](docs/adr/): архитектурные решения
- [CHANGELOG](CHANGELOG.md): журнал всех изменений

## Процесс
Каждый этап: System Design док → согласование → код → Jest-тесты → запись в CHANGELOG.
