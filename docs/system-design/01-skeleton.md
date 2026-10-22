# System Design 01: Каркас (этап 1)

**Статус:** 🟡 На согласовании · **Дата:** 2026-10-22 · **Ревизия:** 1

Этап 1 из ТЗ (раздел 8): монорепо, локальная инфраструктура, общие libs, шаблон сервиса, CI. Бизнес-логики на этом этапе нет: строим то, на чём будут стоять все 8 сервисов. Правила взяты из ADR-0001…0004, здесь только конкретика реализации.

## 1. Критерий готовности

| #   | Проверка                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `docker compose --profile infra up -d`: все контейнеры `healthy`, созданы 7 баз с пользователями, Kafbat UI и Jaeger открываются              |
| 2   | `pnpm nx run-many -t lint typecheck test build` проходит; граница модулей нарушается тестовым импортом → lint падает                           |
| 3   | `pnpm nx g @repo/generators:service demo` создаёт сервис, который проходит lint/typecheck/test/build и в compose отвечает `/health/ready` = 200 |
| 4   | Интеграционные тесты libs на Testcontainers (настоящие Postgres и Kafka) зелёные                                                              |
| 5   | CI в GitHub Actions зелёный: affected-задачи, интеграционные тесты, smoke-проверка генератора                                                  |

## 2. Что входит и что нет

**Входит:** Nx-воркспейс; `infra/` (compose, init-скрипты Postgres и Kafka); `libs/contracts`, `kafka`, `outbox`, `idempotency`, `observability`; генератор сервиса; ESLint/Prettier; Jest; CI.

**Не входит:**
- `libs/auth`: появится на этапе 2 вместе с JWT-заглушкой, по правилу «lib — по факту» (ADR-0001, п. 5).
- Настоящие сервисы: тоже с этапа 2.
- Фронтенды.
- Docker-образы в registry.

## 3. Окружение

| Что                 | Версия                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Node.js             | 24 LTS (на машине уже 24.11), фиксируется в `.nvmrc` и `engines`                                  |
| pnpm                | через `corepack` (`packageManager` в `package.json`)                                              |
| Docker              | Docker Desktop + WSL2. Лимит WSL — 8 ГБ RAM в `%UserProfile%\.wslconfig` (из 16 ГБ машины)        |
| Nx, NestJS, Prisma  | актуальные стабильные мажоры на момент init: NestJS 11, Prisma 7; точные версии — в lockfile      |
| TypeScript          | strict, `module: nodenext` для сервисов и libs                                                    |
| Postgres / Kafka    | `postgres:16-alpine`, `apache/kafka:4.x` (тег фиксируется), `ghcr.io/kafbat/kafka-ui`, Jaeger v2  |

Расхождение «PostgreSQL 15+» (ADR-0004) и «16» (ТЗ) закрываем: **16**.

## 4. Структура репозитория после этапа

```
marketplace/
├── apps/                        # пусто до этапа 2 (кроме временного demo в CI)
├── libs/
│   ├── contracts/               # zod: конверт, деньги, id, реестр сообщений
│   ├── kafka/                   # producer-адаптер, consumer runner, ретраи, DLQ, dlq-reprocess
│   ├── outbox/                  # запись в outbox, relay, очистка
│   ├── idempotency/             # processed_events, обёртка обработчика, очистка
│   └── observability/           # pino, OpenTelemetry, контекст correlation/causation
├── tools/generators/service/    # локальный Nx-генератор шаблона сервиса
├── infra/
│   ├── postgres/init/01-databases.sh
│   ├── kafka/topics.json        # декларация топиков (ADR-0002, п. 3)
│   └── kafka/create-topics.sh
├── compose.yaml                 # infra + include: apps/*/compose.yaml
├── .env.example
├── eslint.config.mjs  nx.json  pnpm-workspace.yaml  tsconfig.base.json
└── .github/workflows/ci.yml
```

## 5. Локальная инфраструктура (`compose.yaml`, профиль `infra`)

| Контейнер     | Порт хоста          | Healthcheck                             | Лимит памяти |
| ------------- | ------------------- | --------------------------------------- | ------------ |
| `postgres`    | 5432                | `pg_isready`                            | 512 МБ       |
| `kafka`       | 9092 (EXTERNAL)     | `kafka-broker-api-versions.sh`          | 1 ГБ         |
| `kafka-init`  | —                   | одноразовый, создаёт топики и завершается | —          |
| `kafbat-ui`   | 8080                | HTTP                                    | 512 МБ       |
| `jaeger`      | 16686 (UI), 4318 (OTLP HTTP) | HTTP                           | 256 МБ       |
| `mailpit`     | 8025 (UI), 1025 (SMTP) | HTTP                                 | 64 МБ        |

- **Kafka:** один узел KRaft (broker + controller), два listener'а: `INTERNAL://kafka:29092` для контейнеров и `EXTERNAL://localhost:9092` для сервисов, запущенных с хоста через `nx serve`. `auto.create.topics.enable=false`.
- **Топики** описаны декларативно в `infra/kafka/topics.json`: имя, партиции, retention. `kafka-init` создаёт недостающие (`--if-not-exists`) и **падает**, если у существующего топика другое число партиций (ADR-0002, п. 3). На этапе 1 список пуст, кроме служебного `_smoke.events`. Топики появляются вместе с потребителями.
- **Postgres:** `01-databases.sh` создаёт сразу все 7 баз, shadow-базы и пользователей из ADR-0004, п. 1. Пароли берутся из env (`<SERVICE>_DB_PASSWORD`). Создаём все базы сразу, потому что init выполняется только на пустом томе: так не придётся пересоздавать том на каждом этапе. `max_connections=100`, бюджет — ADR-0004, п. 5.
- **Сервисы** подключаются через `include:` в корневом `compose.yaml`. Каждый `apps/<name>/compose.yaml` создаёт генератор (п. 7), поэтому корневой файл не правится руками на каждый сервис.
- `.env.example` коммитится, `.env` — в `.gitignore`. Для локальной разработки достаточно `cp .env.example .env`.

## 6. Общие библиотеки

Все libs — `platform:node`, кроме `contracts` (`platform:shared`); теги из ADR-0003, п. 4. Libs **не зависят от сгенерированного Prisma-клиента** конкретного сервиса. Им нужен минимальный интерфейс транзакции, которому структурно соответствует `Prisma.TransactionClient`:

```ts
// libs/outbox (и idempotency) — порт, а не зависимость от Prisma
export interface SqlTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
```

Таблицы `outbox` и `processed_events` попадают в `schema.prisma` каждого сервиса из шаблона генератора, миграцией сервиса. Libs пишут в них сырым SQL (ADR-0004, п. 4).

### 6.1 `libs/contracts`

- `envelope.ts`: zod-схема конверта (ADR-0002, п. 5) и `createEnvelope()`, который заполняет `eventId` (UUID v7), `occurredAt` и `correlationId`/`causationId` из контекста.
- `money.ts`: см. решение по деньгам ниже.
- `ids.ts`: `newId()` — UUID v7.
- `registry.ts`: `defineMessage({ type, version, kind: 'event' | 'command', topic, key: (payload) => string, schema })`. Публикация и consumer runner работают через реестр: тип → схема → топик → ключ. Так ключ партиции нельзя выбрать «на глаз» в месте вызова (ADR-0002, п. 4).
- Upcasters (ADR-0003, п. 5): механизм `registerUpcaster(type, fromVersion, fn)` есть уже сейчас; первые реальные — когда появится v2.

**Решение: деньги в TypeScript и JSON.** В базе — `bigint` (ТЗ, раздел 5). JSON не умеет `bigint`, а `BigInt` в JS неудобен: не сериализуется и не смешивается с `number`.
- В контрактах и коде деньги — `number`, проверенный `Number.isSafeInteger`. Это до 9·10¹⁵ тийинов ≈ 90 трлн сум, с запасом.
- `Money = { amountMinor: number; currency: 'UZS' }`. Операции `add`, `sub`, `mulBp` (комиссия с `floor`, ADR-0007, п. 4), `sum`. Каждая бросает ошибку при выходе за safe integer.
- Prisma отдаёт колонку `bigint` как `BigInt`, поэтому репозиторий переводит её через `toSafeNumber()`, который тоже бросает ошибку при переполнении. Голого `Number(big)` нет.

**Решение: идентификаторы.** Все id — UUID v7, тип в базе `uuid`. SQL-примеры в ADR с `text` — иллюстрации, при реализации используем `uuid`. Префиксов (`ord_…`) нет: их нельзя хранить в типе `uuid`, а тип сущности и так понятен по полю.

### 6.2 `libs/observability`

- `initTelemetry(serviceName)`: OpenTelemetry Node SDK, экспорт OTLP HTTP в Jaeger, автоинструментация HTTP, pg и Nest. Вызывается **первой строкой** `main.ts`, до импорта Nest.
- Контекст запроса на `AsyncLocalStorage`: `{ correlationId, causationId }`. Для HTTP его заполняет middleware (`X-Request-Id`), для Kafka — consumer runner из конверта.
- Логгер: pino (через `nestjs-pino`), JSON. В каждой записи `service`, `traceId`, `spanId`, `correlationId`. Локально — `pino-pretty`.
- Health: `/health/live` (процесс жив) и `/health/ready` (БД `SELECT 1`, Kafka — подключён ли producer) через `@nestjs/terminus`.

### 6.3 `libs/outbox`

```ts
// запись — внутри транзакции use case
await outbox.add(tx, OrderCreatedV1, payload);   // реестр даёт topic и key, конверт — из контекста
```

**Relay** (`OutboxRelay`, запускается в процессе сервиса):
1. Берёт `pg_try_advisory_lock(hash('outbox:<service>'))` на **выделенном соединении**: session-level lock (ADR-0004, п. 5). Не получилось — значит, этот инстанс не лидер и пробует снова через 5 с.
2. Цикл: `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT 100` → `producer.sendBatch` (сообщения в порядке `id`) → `UPDATE … SET published_at = now() WHERE id = ANY($ids)`.
3. Пауза: 0 мс, если батч был полным; 200 мс, если пустым. LISTEN/NOTIFY не используем: polling проще, а задержки в 200 мс достаточно.
4. Если отправка не удалась, строки не помечаются, следующая итерация повторяет их после backoff. Порядок при этом сохраняется: producer `idempotent`, `maxInFlightRequests: 1` (ADR-0002, п. 6).
5. Если relay упал между отправкой и пометкой, будет дубль. Это допустимо, потребители идемпотентны.

Очистка: отправленные записи старше 7 дней удаляются раз в час.

Конверт хранится в `payload` целиком. В заголовки Kafka relay кладёт `traceparent`, сохранённый при записи в outbox: тогда трейс продолжается от use case, а не от relay.

### 6.4 `libs/idempotency`

```ts
await idempotent(tx, 'crm.ltv', envelope.eventId, async () => {
  /* изменения данных в той же транзакции */
});
// INSERT INTO processed_events … ON CONFLICT DO NOTHING; 0 строк → fn не вызывается
```

Очистка строк старше 30 дней (ADR-0002, п. 7).

### 6.5 `libs/kafka`

- **Producer-адаптер** поверх kafkajs. Используется только relay'ем, сервисы его напрямую не вызывают (ADR-0002, п. 2).
- **Consumer runner:**
  ```ts
  consumer.on(OrderConfirmedV1, 'crm.ltv', async (msg) => { … });   // обработчик сам открывает транзакцию и вызывает idempotent()
  ```
  Конвейер на каждое сообщение:
  1. Разбор конверта.
  2. Upcast до последней версии.
  3. Валидация zod.
  4. Восстановление контекста (correlation, trace).
  5. Вызов обработчиков этого типа по очереди.
  6. Commit offset.
- **Классификация ошибок:** `PermanentError` (невалидный payload, неизвестный тип или версия, `ZodError`) сразу уходит в DLQ. Всё остальное — временная ошибка: 5 попыток с паузой 1, 2, 4, 8, 16 с и `heartbeat()` между ними, затем DLQ (ADR-0002, п. 8).
- **DLQ:** `<consumer-group>.dlq` с заголовками `x-original-*`, `x-handler`, `x-error`, `x-attempts`. Команда `dlq-reprocess` — CLI сервиса (`node dist/main.js dlq-reprocess`).
- `eachMessage`, `partitionsConsumedConcurrently` берётся из env (по умолчанию 3). Параллельной обработки внутри партиции нет.
- Неизвестный для этого сервиса `type` в топике: пропустить, записать в лог на уровне debug и закоммитить offset. Это не ошибка: в топике контекста лежат и события, которые нужны другим сервисам.

## 7. Шаблон сервиса (генератор)

`pnpm nx g @repo/generators:service <name> [--thin]` (`--thin` даёт тонкую схему из SD-00, п. 8):

| Что создаётся                     | Содержание                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/<name>/src/main.ts`         | `initTelemetry` → Nest app → relay и consumer runner                                        |
| слои `domain/ application/ infrastructure/ interface/` | пустые, с правилом `no-restricted-imports` для `domain` (SD-00, п. 8)  |
| `prisma/schema.prisma`, `prisma.config.ts` | модели `Outbox`, `ProcessedEvent`; output `src/generated/prisma`; adapter-pg, пул из `DB_POOL_MAX` (ADR-0004, п. 4–5) |
| первая миграция                   | таблицы `outbox`, `processed_events`                                                        |
| `project.json`                    | теги `type:app`, `platform:node`; таргеты `prisma-generate`, `serve`, `build`, `test`, `test-integration`, `migrate` |
| `Dockerfile`                      | multi-stage: `deps` → `build` → `migrate` (Prisma CLI) → `runtime` (`nx prune`, ADR-0003, п. 6) |
| `compose.yaml`                    | `<name>-migrate` (одноразовый) и `<name>` с `depends_on: service_completed_successfully`, профили `core`/`full` |
| `.env` ключи                      | дописываются в `.env.example`                                                               |
| тесты                             | unit-пример, интеграционный тест «outbox → Kafka → собственный consumer → processed_events» |

Генератор должен оставаться рабочим, поэтому CI создаёт из него временный `demo`-сервис, прогоняет все его задачи и выбрасывает (п. 9).

## 8. Тестирование этапа

| Уровень                       | Что                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (Jest)                   | конверт: валидация, `createEnvelope` из контекста; `money`: операции, `floor` в `mulBp`, переполнение → ошибка, `toSafeNumber`; реестр: ключ партиции из payload; upcaster-цепочка; классификация ошибок и расписание ретраев; построение DLQ-заголовков; конвейер consumer runner на фейковом транспорте; цикл relay на фейковых store/producer (порядок, пометка только после успешной отправки, backoff) |
| Property-based (fast-check)   | `money`: `add`/`sub` обратимы, `sum` не зависит от порядка, `mulBp` ≤ исходной суммы                                                                                                 |
| Интеграционные (Testcontainers) | relay публикует в порядке `id`; «упал между send и mark» → дубль, но потребитель обработал один раз; два relay — публикует только лидер; временная ошибка → ретраи → успех; постоянная → DLQ с заголовками; `dlq-reprocess` повторяет обработку; `traceparent` проходит outbox → Kafka → consumer |
| Контрактные                   | JSON-фикстура `_smoke.ping.v1` проходит схему (механизм для будущих контрактов)                                                                                                      |

- Раннер — Jest с `@swc/jest`: быстрее, чем ts-jest, а типы и так проверяет отдельная задача `typecheck`.
- Unit-тесты — таргет `test`, интеграционные — `test-integration` (файлы `*.int-spec.ts`), чтобы `test` работал без Docker.
- Порог покрытия 80% для `libs/contracts` и чистой логики `libs/kafka`/`outbox`. Это страховка, а не цель (SD-00, п. 9).

## 9. CI (`.github/workflows/ci.yml`)

| Job                | Что делает                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `check`            | `nx affected -t lint typecheck test build` (ADR-0003, п. 7)                                     |
| `integration`      | `nx affected -t test-integration`. Docker на `ubuntu-latest` уже есть, Testcontainers работает |
| `generator-smoke`  | генерирует `demo`, запускает его `lint typecheck test test-integration build`, ничего не коммитит |
| `infra-smoke`      | `docker compose --profile infra up -d --wait` и проверка баз и пользователей                      |

Репозиторий — приватный `marketplace` на GitHub (бесплатных минут Actions на приватный репо хватает с запасом).

## 10. Порядок работ

1. Nx + pnpm воркспейс, TS-конфиг, ESLint (границы модулей) + Prettier, Jest. Первый коммит каркаса.
2. `infra/`: compose `infra`, init Postgres, декларация топиков. Проверка: критерий 1.
3. `libs/contracts`: unit и property-based тесты.
4. `libs/observability`.
5. `libs/outbox`, `libs/idempotency`, `libs/kafka`: unit, затем интеграционные тесты.
6. Генератор сервиса; проверка на `demo` (критерий 3).
7. GitHub-репозиторий, CI (критерий 5).
8. CHANGELOG, SD-01 → «Реализовано», ТЗ: этап 1 ✅.

## Открытые вопросы

- Ничего блокирующего. Решения, принятые здесь: Postgres 16, деньги в TS как safe-integer `number`, id — UUID v7 в колонках `uuid` без префиксов, `libs/auth` переносится на этап 2, relay на polling без LISTEN/NOTIFY.
