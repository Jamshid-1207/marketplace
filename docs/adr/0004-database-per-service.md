# ADR-0004: Database per service

**Статус:** Принято · **Дата:** 2026-10-22 · **Ревизия:** 5

## Контекст

Если у сервисов общая БД, между ними появляется скрытая связность: один сервис читает или меняет таблицы другого, и схему уже нельзя изменить, не сломав соседей. Смысл микросервисов теряется.

ADR-0001 (п. 2) определяет, кто какими данными владеет. Этот ADR описывает, как это обеспечивается технически.

Стек: PostgreSQL 15+, Prisma ORM 7. Локально — один контейнер Postgres (ADR-0001).

## Рассмотренные варианты

| Вариант                               | Плюсы                                                                                                                                                      | Минусы                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Общая база, общие таблицы             | Просто; JOIN и одна транзакция на всё                                                                                                                      | Скрытая связность; изменение схемы ломает соседей; противоречит ADR-0001              |
| Схема Postgres на сервис в одной базе | Одна точка подключения; изоляция грантами                                                                                                                  | JOIN между схемами доступен одним грантом — барьер держится на дисциплине             |
| **База на сервис в одном инстансе**   | Postgres не умеет JOIN между базами без расширений — физический барьер. Отдельный бэкап на сервис. Переезд на отдельный инстанс = смена строки подключения | Больше баз и пользователей в init-скрипте; общий лимит соединений и ресурсов инстанса |
| Инстанс Postgres на сервис            | Полная изоляция, в том числе по ресурсам                                                                                                                   | Тяжело для ноутбука: 7 контейнеров Postgres                                           |

Выбрано: **база на сервис в одном инстансе** локально. В проде — инстанс на сервис или на группу сервисов, без изменений в коде (п. 7).

## Решение

### 1. Базы и пользователи

| Сервис       | База              | Пользователь       |
| ------------ | ----------------- | ------------------ |
| auth         | `auth_db`         | `auth_svc`         |
| catalog      | `catalog_db`      | `catalog_svc`      |
| order        | `order_db`        | `order_svc`        |
| payment      | `payment_db`      | `payment_svc`      |
| erp          | `erp_db`          | `erp_svc`          |
| crm          | `crm_db`          | `crm_svc`          |
| notification | `notification_db` | `notification_svc` |

У gateway базы нет.

- Пользователь сервиса — владелец своей базы (`OWNER`). Прав на чужие базы нет.
- `CONNECT` на все базы отозван у `PUBLIC`: по умолчанию Postgres разрешает подключаться к любой базе любому пользователю.
- С PostgreSQL 15 схема `public` принадлежит владельцу базы, поэтому пользователь сервиса создаёт в ней таблицы без дополнительных грантов.
- Для разработки у каждого сервиса есть shadow-база `<service>_db_shadow` (п. 4).
- Суперпользователь `postgres` используется только init-скриптом и для ручного администрирования, сервисы под ним не подключаются.

Базы и пользователи создаёт одноразовый контейнер `db-provision` (`infra/postgres/provision.sh`) при каждом `docker compose up`. Он идемпотентен и приводит Postgres к списку `infra/postgres/services.txt`, поэтому новый сервис получает базу без пересоздания тома (init-скрипт образа выполняется только на пустом томе, SD-01, п. 5). Пароли берутся из env; ниже SQL для одного сервиса (в скрипте — с проверками существования):

```sql
CREATE ROLE order_svc LOGIN PASSWORD '...';
CREATE DATABASE order_db        OWNER order_svc;
CREATE DATABASE order_db_shadow OWNER order_svc;   -- только для prisma migrate dev
REVOKE CONNECT ON DATABASE order_db        FROM PUBLIC;
REVOKE CONNECT ON DATABASE order_db_shadow FROM PUBLIC;
```

### 2. Доступ к чужим данным

- **Изменение** чужих данных — только событиями или шагом saga (ADR-0005).
- **Данные разных продавцов** внутри базы сервиса разделяет `seller_id` и область доступа в каждом запросе (ADR-0006).
- **Чтение** — по умолчанию из своей read-model, построенной по событиям. Синхронный запрос к API владельца — исключение по правилам ADR-0001 (п. 3).
- **Запрещено:** подключение к чужой базе, `dblink`, `postgres_fdw`, чтение чужих таблиц любым другим способом.

### 3. Read-models

Read-model — локальная копия нужных сервису полей чужих данных. Пример: crm хранит статистику клиента `customer_stats`, собранную из событий auth и order, и список заказов клиента `customer_orders`.

Правила:

1. **Только нужные поля**, а не копия чужой таблицы целиком.
2. **Пишут только обработчики событий.** API сервиса read-model не меняет, и сервис не публикует события об этих данных — это делает только владелец.
3. **Пересобирается через replay** (ADR-0002, п. 9), поэтому обработчики идемпотентны и детерминированы.
4. **Результат не зависит от порядка событий из разных топиков.** Между топиками, как и между партициями, порядка нет: crm может получить `order.confirmed` раньше `user.registered`. Каждое событие делает upsert и заполняет только свои поля. Строка может какое-то время быть неполной, запросы это учитывают.
5. **Устаревшие события агрегата отбрасываются** по `aggregateVersion` (ADR-0002): строка хранит последнюю применённую версию. Внутри одного топика события агрегата идут по порядку, но событие, повторно обработанное из DLQ (ADR-0002, п. 8), приходит позже более новых.
6. **По возможности событие несёт достаточно данных** (event-carried state transfer), чтобы read-model не приходилось собирать из нескольких топиков. Например, `customerId` и сумма в `order.confirmed`.
7. **Наблюдатели строят read-models по итоговым событиям,** а не по промежуточным шагам saga (ADR-0005, п. 2): заказ с успешной оплатой ещё может быть отменён.

Пример 1 — два топика, порядок не важен:

```sql
CREATE TABLE customer_stats (
  customer_id   text        PRIMARY KEY,
  email         text,                          -- NULL, пока не пришло user.registered
  registered_at timestamptz,
  orders_count  int         NOT NULL DEFAULT 0,
  ltv_minor     bigint      NOT NULL DEFAULT 0
);

-- user.registered (auth.events): заполняет только свои поля
INSERT INTO customer_stats (customer_id, email, registered_at)
VALUES ($1, $2, $3)
ON CONFLICT (customer_id) DO UPDATE
  SET email = EXCLUDED.email, registered_at = EXCLUDED.registered_at;

-- order.confirmed (order.events): может прийти раньше user.registered
INSERT INTO customer_stats (customer_id, orders_count, ltv_minor)
VALUES ($1, 1, $2)
ON CONFLICT (customer_id) DO UPDATE
  SET orders_count = customer_stats.orders_count + 1,
      ltv_minor    = customer_stats.ltv_minor + EXCLUDED.ltv_minor;
```

Инкременты не зависят от порядка, а от двойного применения защищает `processed_events` в той же транзакции (ADR-0002, п. 7).

Пример 2 — поле перезаписывается, устаревшие версии отбрасываются:

```sql
CREATE TABLE customer_orders (
  order_id      text   PRIMARY KEY,
  customer_id   text   NOT NULL,
  total_minor   bigint NOT NULL,
  order_status  text   NOT NULL,
  order_version int    NOT NULL   -- последняя применённая версия заказа
);

-- order.*: каждое событие несёт customerId и сумму (правило 6)
INSERT INTO customer_orders (order_id, customer_id, total_minor, order_status, order_version)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (order_id) DO UPDATE
  SET order_status  = EXCLUDED.order_status,
      order_version = EXCLUDED.order_version
  WHERE customer_orders.order_version < EXCLUDED.order_version;
```

Такие обработчики пишутся через `$executeRaw`: атомарный `INSERT … ON CONFLICT` и условие по версии должны быть видны в SQL явно.

### 4. Prisma 7

- У каждого сервиса свои `prisma/schema.prisma` и `prisma.config.ts` в папке сервиса. Строка подключения задаётся в `prisma.config.ts` из env.
- Генератор `prisma-client`, `output` — внутри сервиса: `apps/order/src/generated/prisma`. У каждого сервиса свой клиент, конфликтов между ними нет. Сгенерированный код — в `.gitignore`.
- `moduleFormat` задаётся явно под модульную систему сервисов (`cjs` для CommonJS). Не полагаемся на автоопределение: в версиях до 7.10 оно ошибалось для CommonJS-проектов с `module: nodenext`.
- Клиент создаётся с `@prisma/adapter-pg`. Размер пула — из env (п. 5).
- `shadowDatabaseUrl` указывает на `<service>_db_shadow`, поэтому `prisma migrate dev` не требует права создавать базы. Shadow-база нужна только в разработке.
- Изменение агрегата, запись в `outbox` и в `processed_events` — одна интерактивная транзакция `prisma.$transaction(async (tx) => …)`.
- `$executeRaw` допустим для того, что Prisma не выражает: условный upsert, `ON CONFLICT DO NOTHING` с проверкой числа затронутых строк, advisory lock relay.

Генерация клиента — Nx-задача, от которой зависят остальные (`apps/order/project.json`):

```json
{
  "targets": {
    "prisma-generate": {
      "command": "prisma generate",
      "options": { "cwd": "apps/order" },
      "inputs": ["{projectRoot}/prisma/**/*"],
      "outputs": ["{projectRoot}/src/generated/prisma"],
      "cache": true
    },
    "build": { "dependsOn": ["prisma-generate", "^build"] },
    "typecheck": { "dependsOn": ["prisma-generate"] },
    "test": { "dependsOn": ["prisma-generate"] }
  }
}
```

### 5. Бюджет соединений

- В Prisma 7 с адаптером `pg` пул по умолчанию — 10 соединений. У Postgres по умолчанию `max_connections = 100`. 7 сервисов × 10 = 70 уже при одном инстансе, при двух — 140, и Postgres начинает отказывать в подключениях.
- Правило: `Σ (инстансы сервиса × размер пула) + запас на миграции и администрирование ≤ max_connections`.
- Локально `DB_POOL_MAX=5` для каждого сервиса, плюс соединение relay: 42 соединения при одном инстансе, 84 при двух.
- Relay outbox работает в процессе сервиса, но на **отдельном выделенном соединении**: session-level advisory lock через пул не удержать (SD-01, п. 6.3). Это +1 соединение на инстанс сверх пула.
- При росте — PgBouncer. Миграции и relay (session-level advisory lock) подключаются к Postgres напрямую: transaction mode PgBouncer ломает advisory locks.

### 6. Миграции

- Каждый сервис мигрирует только свою базу и только своим пользователем.
- Разработка: `prisma migrate dev` создаёт миграцию, проверяя её на shadow-базе.
- Запуск: отдельный одноразовый сервис в compose выполняет `prisma migrate deploy` и завершается. Сервис стартует только после его успешного завершения. Миграции при старте самого сервиса не выполняются: при двух инстансах и при падении миграции посреди старта это источник проблем.

```yaml
order-migrate:
  build: { context: ../.., dockerfile: apps/order/Dockerfile, target: migrate } # файл apps/order/compose.yaml, пути — от его папки
  command: prisma migrate deploy
  environment:
    DATABASE_URL: postgresql://order_svc:${ORDER_DB_PASSWORD}@postgres:5432/order_db
  depends_on:
    db-provision: { condition: service_completed_successfully }
  profiles: ["core", "full"]

order:
  depends_on:
    order-migrate: { condition: service_completed_successfully }
```

- Миграции обратно совместимы с работающей версией сервиса (expand → migrate → contract): сначала добавляем новую колонку, потом код начинает её использовать, и только потом удаляем старую.

### 7. Переносимость и бэкапы

- Строка подключения — только из env (`DATABASE_URL`). Хосты и имена баз в коде не появляются.
- Поэтому перенос базы на отдельный инстанс — изменение конфигурации, а не кода.
- Бэкап — `pg_dump` каждой базы отдельно.
- **Ограничение:** бэкапы разных баз не согласованы по времени. После восстановления одной базы соседи могут ссылаться на записи, которых в ней уже нет. Восстановление сопровождается сверкой: повторной публикацией событий из outbox или replay в read-models соседей.

### 8. Отчёты

- Отчёт внутри домена — read-model в сервисе этого домена.
- Кросс-доменные отчёты для админки — открытый вопрос (см. ниже).

## Последствия

**Плюсы**

- Физическая изоляция данных: JOIN между сервисами невозможен, чужие таблицы недоступны.
- Схему базы можно менять, не согласовывая с другими сервисами.
- Перенос на отдельные инстансы без изменений в коде.

**Минусы и цена**

- Eventual consistency между сервисами, обеспечивается через outbox (ADR-0002) и saga (ADR-0005).
- Дублирование данных в read-models и код обработчиков для их поддержки.
- Обработчики read-model сложнее наивных: upsert, проверка версий, независимость от порядка.
- Общий инстанс локально: лимит соединений и ресурсы делятся между всеми сервисами.

**Правила для code review**

- обращение к чужой базе в любом виде;
- обработчик read-model, результат которого зависит от порядка событий из разных топиков;
- запись в read-model из чего-либо, кроме обработчиков событий;
- миграция, ломающая работающую версию сервиса;
- `PrismaClient` без явного размера пула;
- миграция в коде старта сервиса.

## Открытые вопросы

- Где живут кросс-доменные отчёты админки (например, выручка по сегментам клиентов): read-model в одном из сервисов, отдельный reporting-сервис или аналитическая БД, наполняемая событиями.

## Связанные решения

- ADR-0001: микросервисная архитектура (владение данными, синхронные вызовы).
- ADR-0002: Kafka, outbox, `processed_events`, `aggregateVersion`, replay.
- ADR-0003: Nx monorepo.
- ADR-0005: checkout saga (`checkout_sagas`, `sub_orders`, `idempotency_keys` в `order_db`).
- ADR-0006: `seller_id` в таблицах продавцов; Row-Level Security на этапе hardening.
- ADR-0007: журнал проводок в `payment_db`.

## Ссылки

- [Prisma: Upgrade to v7](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-to-prisma-7)
- [Prisma: Generators (prisma-client, moduleFormat)](https://www.prisma.io/docs/concepts/components/prisma-schema/generators)
- [Prisma v7: About the shadow database](https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/shadow-database)
- [Prisma v7: Connection pool](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool)
- [NestJS: Prisma](https://docs.nestjs.com/data/prisma)
