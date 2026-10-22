# System Design 01: Каркас (этап 1)

**Статус:** ✅ Утверждено · **Дата:** 2026-10-22 · **Ревизия:** 7

Этап 1 из ТЗ (раздел 8): монорепо, локальная инфраструктура, общие libs, шаблон сервиса, CI. Бизнес-логики на этом этапе нет: строим то, на чём будут стоять все 8 сервисов. Правила взяты из ADR-0001…0004, здесь только конкретика реализации.

## 1. Критерий готовности

| #   | Проверка                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm infra:up`, затем `pnpm infra:smoke`: все контейнеры `healthy`, `db-provision` и `kafka-init` завершились успешно, базы и топики соответствуют декларации, чужая база недоступна, UI открываются. Повторный запуск ничего не ломает |
| 2   | `pnpm nx run-many -t lint typecheck test build` проходит; граница модулей нарушается тестовым импортом → lint падает                                           |
| 3   | `pnpm nx g @repo/generators:service demo` создаёт сервис, который проходит lint/typecheck/test/test-integration/build (в CI) и в compose отвечает `/health/ready` = 200 (проверяем руками) |
| 4   | Интеграционные тесты libs на Testcontainers (настоящие Postgres и Kafka) зелёные                                                                              |
| 5   | CI в GitHub Actions зелёный: affected-задачи, интеграционные тесты, smoke-проверка генератора и infra                                                          |

## 2. Что входит и что нет

**Входит:** Nx-воркспейс; `infra/` (compose, provisioning Postgres, топики Kafka); `libs/contracts`, `kafka`, `outbox`, `idempotency`, `observability`; генератор сервиса; ESLint/Prettier; Jest; CI.

**Не входит:**
- `libs/auth`: появится на этапе 2 вместе с JWT-заглушкой. До этого в шаблоне сервиса нет проверки JWT и области доступа (ADR-0001, п. 8); на этапе 2 генератор дополняется ими.
- Настоящие сервисы: тоже с этапа 2.
- Фронтенды.
- Docker-образы в registry.

**Почему libs раньше сервисов.** Правило «lib — по факту» (ADR-0001, раздел «Этапы») относится к доменному и прикладному коду. `contracts`, `kafka`, `outbox`, `idempotency`, `observability` нужны каждому сервису по ADR-0002 и ADR-0004, их API уже описан в ADR. Риск придумать API без потребителя закрывает `demo`-сервис из генератора: он использует все libs и прогоняется в CI (п. 9). Формулировка в ADR-0001 уточнена.

## 3. Окружение

| Что                 | Версия                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Node.js             | 24 LTS, не ниже 24.11.1 (`engines`): с неё работают синхронные ESM-хуки для OpenTelemetry (п. 6.2). `.nvmrc`, CI читает его |
| pnpm                | 12.x, `packageManager` в `package.json`. Ставится через `npm i -g pnpm@<версия>`: corepack 0.34 из Node 24 не запускает нативный бинарник pnpm 12, а с Node 25 corepack не входит в поставку |
| Docker              | Docker Desktop + WSL2. Лимит WSL — 8 ГБ RAM в `%UserProfile%\.wslconfig` (из 16 ГБ машины)        |
| Nx, NestJS, Prisma  | Nx 23.3 (24.0.0 вышел за день до init — ждём патчей), NestJS 12 (текущий стабильный), Prisma 7.10 (8.x пока rc); точные версии — в lockfile |
| TypeScript          | 6.0: TypeScript 7 не поддерживается typescript-eslint (`<6.1`). Strict, `module: nodenext`, сервисы и libs — CommonJS |
| Модули              | NestJS 12 распространяется только в ESM. Наш код остаётся CommonJS: Node 24 загружает ESM-пакеты через `require(esm)`. Jest делает то же только с флагом `--experimental-vm-modules`; он задан для всех `test` в `nx.json` |
| Postgres / Kafka    | `postgres:16-alpine`, `apache/kafka:4.x` (тег фиксируется), `ghcr.io/kafbat/kafka-ui`, Jaeger v2  |

Расхождение «PostgreSQL 15+» (ADR-0004) и «16» (ТЗ) закрываем: **16**.

## 4. Структура репозитория после этапа

```
marketplace/
├── apps/                        # пусто до этапа 2 (кроме временного demo в CI)
├── libs/
│   ├── contracts/               # zod: конверт, деньги, id, реестр сообщений
│   ├── kafka/                   # producer-адаптер, consumer runner, ретраи, DLQ, dlq-reprocess
│   ├── outbox/                  # запись в outbox, relay, очистка; sql/ — каноническая DDL
│   ├── idempotency/             # processed_events, обёртка обработчика, очистка; sql/
│   └── observability/           # pino, OpenTelemetry, контекст correlation/causation
├── tools/generators/service/    # локальный Nx-генератор шаблона сервиса
├── infra/
│   ├── postgres/services.txt    # список сервисов с базой: по строке на сервис
│   ├── postgres/provision.sh    # идемпотентное создание баз и пользователей
│   ├── kafka/topics.conf        # декларация топиков (ADR-0002, п. 3)
│   ├── kafka/create-topics.sh
│   ├── jaeger/config.yaml
│   ├── up.sh                    # pnpm infra:up
│   └── smoke.sh                 # pnpm infra:smoke, критерий 1
├── compose.yaml                 # infra + include: список apps/<name>/compose.yaml
├── .env.example
├── eslint.config.mjs  nx.json  pnpm-workspace.yaml  tsconfig.base.json
└── .github/workflows/ci.yml
```

## 5. Локальная инфраструктура (`compose.yaml`)

| Контейнер      | Порт хоста                   | Healthcheck                                          | Лимит памяти |
| -------------- | ---------------------------- | ---------------------------------------------------- | ------------ |
| `postgres`     | 5432                         | `pg_isready`                                         | 512 МБ       |
| `db-provision` | —                            | одноразовый, создаёт базы и пользователей             | —            |
| `kafka`        | 9092 (EXTERNAL)              | `/opt/kafka/bin/kafka-broker-api-versions.sh`        | 1 ГБ         |
| `kafka-init`   | —                            | одноразовый, создаёт топики и завершается             | —            |
| `kafbat-ui`    | 8080                         | HTTP                                                 | 512 МБ       |
| `jaeger`       | 16686 (UI), 4318 (OTLP HTTP) | HTTP                                                 | 256 МБ       |
| `mailpit`      | 8025 (UI), 1025 (SMTP)       | HTTP                                                 | 64 МБ        |

- **Профили.** Инфраструктурные контейнеры объявлены с `profiles: [infra, core, full]`. Compose не запускает зависимость из выключенного профиля, поэтому `docker compose --profile core up` без этого не поднял бы `postgres` для сервисов.
- **Kafka:** один узел KRaft (broker + controller), три listener'а: `INTERNAL://kafka:29092` для контейнеров, `EXTERNAL://localhost:9092` для сервисов, запущенных с хоста через `nx serve`, `CONTROLLER://:9093`. `auto.create.topics.enable=false`. `KAFKA_HEAP_OPTS=-Xms512m -Xmx512m`: без явного heap JVM ориентируется не на лимит контейнера, и его убивает OOM.
- **Запуск — `pnpm infra:up`** (`infra/up.sh`). `docker compose up --wait` считает ошибкой любой завершившийся контейнер, даже с кодом 0, поэтому скрипт сначала ждёт healthy у долгоживущих контейнеров, затем запускает `db-provision` и `kafka-init` и проверяет их код выхода.
- **Топики** описаны декларативно в `infra/kafka/topics.conf`: строка на топик — имя, партиции, retention. Не JSON: `kafka-init` работает на образе Kafka, где нет ни `jq`, ни `node`. `kafka-init` создаёт недостающие (`--if-not-exists`), приводит конфиг существующих (retention) к декларации через `kafka-configs --alter` и **падает**, если у существующего топика другое число партиций (ADR-0002, п. 3).
  - На этапе 1 в списке только служебный `smoke.events`. Kafka предупреждает о любом имени с `.` или `_`: в метриках они сливаются. Для нас это не проблема, пока в именах нет `_` — а его нет ни в одном топике.
  - **DLQ тоже декларируется.** Автосоздание выключено, поэтому без топика `<group>.dlq` отправка в DLQ падала бы, offset не коммитился бы, и партиция стояла бы вечно. Генератор добавляет `<name>-service.dlq` в `topics.conf`.
- **Postgres: provisioning вместо init-скрипта.** `docker-entrypoint-initdb.d` выполняется только на пустом томе, поэтому добавить базу нового сервиса без пересоздания тома нельзя, а `demo` из генератора базы бы не получил. Вместо этого одноразовый контейнер `db-provision` при каждом `up` идемпотентно приводит Postgres к `infra/postgres/services.txt`: для каждого сервиса — роль `<name>_svc`, `<name>_db` и `<name>_db_shadow` с владельцем, `REVOKE CONNECT … FROM PUBLIC` (ADR-0004, п. 1). Пароль — из env `<NAME>_DB_PASSWORD`; если его нет, скрипт падает. Шаги `<name>-migrate` зависят от `db-provision: service_completed_successfully`. `max_connections=100`, бюджет — ADR-0004, п. 5.
- **Jaeger** — хранилище в памяти с `max_traces=50000`, иначе он упирается в лимит памяти.
- **Сервисы** подключаются через `include:` в корневом `compose.yaml`. `include` не поддерживает glob, поэтому строку `- apps/<name>/compose.yaml` в корневой файл дописывает генератор (п. 7). Пути внутри включённого файла считаются от его папки: `build.context` в `apps/<name>/compose.yaml` — `../..` (корень монорепо).
- `.env.example` коммитится, `.env` — в `.gitignore`. Для локальной разработки достаточно `cp .env.example .env`.

## 6. Общие библиотеки

Все libs — `platform:node`, кроме `contracts` (`platform:shared`); теги из ADR-0003, п. 4. Libs **не зависят от сгенерированного Prisma-клиента** конкретного сервиса. `outbox.add()` и `idempotent()` работают внутри транзакции use case через минимальный порт, которому структурно соответствует `Prisma.TransactionClient`:

```ts
// libs/outbox (и idempotency) — порт, а не зависимость от Prisma
export interface SqlTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
```

**Каноническая DDL.** Таблицы `outbox` и `processed_events` принадлежат базе сервиса, но описаны один раз: `libs/outbox/sql/` и `libs/idempotency/sql/`.
- Генератор копирует эти файлы в первую миграцию сервиса и добавляет модели `Outbox`, `ProcessedEvent` в `schema.prisma`.
- Интеграционные тесты libs накатывают те же файлы в Testcontainers.
- Тест генератора сравнивает миграцию шаблона с DDL из libs, чтобы они не разошлись.
- Libs пишут в эти таблицы сырым SQL (ADR-0004, п. 4).
- Частичный индекс `WHERE published_at IS NULL` из ADR-0002 Prisma-схемой не выражается без preview-функций. Если вписать его в миграцию руками, `prisma migrate dev` увидит расхождение со схемой и предложит удалить индекс. Поэтому индекс обычный, `(published_at, id)`: он обслуживает тот же запрос, а отправленные строки удаляются через 7 дней, так что индекс не разрастается.

### 6.1 `libs/contracts`

- `envelope.ts`: zod-схема конверта (ADR-0002, п. 5) и `createEnvelope()`, который заполняет `eventId` (UUID v7), `occurredAt` и `correlationId`/`causationId` из контекста.
- `money.ts`: см. решение по деньгам ниже.
- `ids.ts`: `newId()` — UUID v7.
- `registry.ts`: `defineMessage({ type, version, kind: 'event' | 'command', topic, aggregateType, key: (payload) => string, schema })`. Публикация и consumer runner работают через реестр: тип → схема → топик → ключ. Так ключ партиции нельзя выбрать «на глаз» в месте вызова (ADR-0002, п. 4).
- Upcasters (ADR-0003, п. 5): механизм `registerUpcaster(type, fromVersion, fn)` есть уже сейчас; первые реальные — когда появится v2.

**Решение: деньги в TypeScript и JSON.** В базе — `bigint` (ТЗ, раздел 5). JSON не умеет `bigint`, а `BigInt` в JS неудобен: не сериализуется и не смешивается с `number`.
- В контрактах и коде деньги — `number`, проверенный `Number.isSafeInteger`. Это до 9·10¹⁵ тийинов ≈ 90 трлн сум, с запасом. Zod-схема: `z.number().int().refine(Number.isSafeInteger)`.
- `Money = { amountMinor: number; currency: 'UZS' }`. Операции `add`, `sub`, `mulBp`, `sum`. Каждая бросает ошибку при выходе за safe integer.
- `mulBp(amount, bp)` (комиссия, ADR-0007, п. 4) считает внутри через `BigInt`: `amount × bp` переполняет safe integer уже при суммах от ~9·10¹¹ тийинов. Принимает `amount ≥ 0` и `0 ≤ bp ≤ 10 000`; деление `BigInt` на неотрицательных числах и есть `floor`.
- Prisma отдаёт колонку `bigint` как `BigInt`, поэтому репозиторий переводит её через `toSafeNumber()`, который тоже бросает ошибку при переполнении. Голого `Number(big)` нет.

**Решение: идентификаторы.** Все id — UUID v7, тип в базе `uuid`. SQL-примеры в ADR с `text` — иллюстрации, при реализации используем `uuid`. Префиксов (`ord_…`) нет: их нельзя хранить в типе `uuid`, а тип сущности и так понятен по полю.

### 6.2 `libs/observability`

- `initTelemetry(serviceName)`: OpenTelemetry Node SDK, экспорт OTLP HTTP в Jaeger, автоинструментация HTTP, Express, pg и Nest.
  - Nest и всё, что он импортирует (express), загружаются как ESM, а инструментации OTel перехватывают только `require`. Поэтому `initTelemetry` сначала ставит синхронные ESM-хуки `import-in-the-middle` (`module.registerHooks`, Node ≥ 24.11.1) на инструментируемые пакеты.
  - Инструментация `nestjs-core` 0.71 поддерживает Nest < 12: спанов контроллеров пока нет. Трейс запроса строится по спанам HTTP и Express. SDK должен загрузиться раньше модулей, которые он инструментирует. В `main.ts` это не сработает: импорты выполняются до первой строки тела файла. Поэтому вызов лежит в отдельном `src/instrumentation.ts`, а сервис запускается как `node --require ./dist/instrumentation.js dist/main.js`.
- Контекст запроса на `AsyncLocalStorage`: `{ correlationId, causationId }`. Для HTTP его заполняет middleware (`X-Request-Id`), для Kafka — consumer runner из конверта.
- Логгер: pino (через `nestjs-pino`), JSON. В каждой записи `service`, `traceId`, `spanId`, `correlationId`. Локально — `pino-pretty`.
- Health: `/health/live` (процесс жив) и `/health/ready` (БД `SELECT 1`, Kafka — подключён ли producer) через `@nestjs/terminus`.

### 6.3 `libs/outbox`

```ts
// запись — внутри транзакции use case
await outbox.add(tx, OrderCreatedV1, payload, { aggregateId, aggregateVersion });
// реестр даёт topic, key и aggregateType; конверт и traceparent — из контекста
```

`aggregateId` и `aggregateVersion` передаются явно: версию знает только use case, а `aggregateId` не всегда совпадает с ключом партиции (ADR-0002, п. 4).

Таблица — ADR-0002, п. 6, плюс колонка `headers jsonb NOT NULL DEFAULT '{}'`. В неё при записи кладётся `traceparent` текущего спана; relay переносит её в заголовки Kafka. Так трейс продолжается от use case, а не от relay. Конверт хранится в `payload` целиком.

**Relay** (`OutboxRelay`, запускается в процессе сервиса):
1. Работает на **собственном выделенном соединении** `pg.Client`, а не через пул Prisma: session-level advisory lock живёт, пока живо соединение, и через пул его не удержать. Это +1 соединение на инстанс в бюджете ADR-0004, п. 5.
2. Берёт `pg_try_advisory_lock(hashtext('outbox'))`. Advisory locks в Postgres привязаны к базе, а у каждого сервиса своя база, поэтому имени сервиса в ключе не нужно. Не получилось — этот инстанс не лидер и пробует снова через 5 с.
3. Цикл на том же соединении: `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT 100` → `producer.sendBatch` (сообщения в порядке `id`) → `UPDATE … SET published_at = now() WHERE id = ANY($ids)`.
4. Пауза: 0 мс, если батч был полным; 200 мс, если пустым. LISTEN/NOTIFY не используем: polling проще, а задержки в 200 мс достаточно.
5. Если отправка не удалась, строки не помечаются, следующая итерация повторяет их после backoff. Порядок при этом сохраняется: producer `idempotent`, `maxInFlightRequests: 1` (ADR-0002, п. 6).
6. Если соединение оборвалось, лидерство потеряно вместе с ним: запросы того же цикла падают, relay создаёт новое соединение и заново участвует в выборах. Пока старый лидер не понял, что потерял блокировку, возможны дубли от двух relay; порядок по ключу сохраняется, дубли отсекают потребители.
7. Если relay упал между отправкой и пометкой, будет дубль. Это допустимо, потребители идемпотентны.

Очистка: отправленные записи старше 7 дней удаляются раз в час порциями по 1000 строк, чтобы не держать долгую транзакцию.

### 6.4 `libs/idempotency`

```ts
await idempotent(tx, 'crm.ltv', envelope.eventId, async () => {
  /* изменения данных в той же транзакции */
});
// INSERT INTO processed_events … ON CONFLICT DO NOTHING; 0 строк → fn не вызывается
```

Очистка строк старше 30 дней (ADR-0002, п. 7), тоже порциями.

### 6.5 `libs/kafka`

- **Producer-адаптер** `KafkaPublisher` поверх kafkajs. Использует его только инфраструктура: relay, отправка в DLQ и `dlq-reprocess`. Сервисы его напрямую не вызывают (ADR-0002, п. 2).
  - Relay зависит не от kafkajs, а от порта `OutboxPublisher` из `libs/outbox`. `KafkaPublisher` реализует этот порт, поэтому зависимость идёт в одну сторону: `kafka` → `outbox`.
  - Партиционер — `DefaultPartitioner` (murmur2, как у Java-клиента).
- **Consumer runner:**
  ```ts
  consumer.on(OrderConfirmedV1, 'crm.ltv', async (msg) => { … });   // обработчик сам открывает транзакцию и вызывает idempotent()
  ```
  Конвейер на каждое сообщение:
  1. Разбор конверта.
  2. Валидация payload схемой **его** версии: upcaster должен получать проверенные данные.
  3. Upcast до последней версии.
  4. Восстановление контекста (correlation, trace).
  5. Вызов обработчиков этого типа по очереди. Каждый обработчик ретраится и уходит в DLQ отдельно, с заголовком `x-handler`: успешный соседний обработчик повторно не вызывается.
  6. Commit offset.
- **Классификация ошибок:** `PermanentError` (невалидный payload, неизвестный тип или версия, `ZodError`) сразу уходит в DLQ. Всё остальное — временная ошибка: 5 попыток с паузой 1, 2, 4, 8, 16 с и `heartbeat()` между ними, затем DLQ (ADR-0002, п. 8).
- **Перебалансировка во время ретраев.** Если `heartbeat()` сообщил о перебалансировке или consumer останавливается, ретраи прерываются **без** отправки в DLQ: партиция уходит другому инстансу, и тот получит сообщение заново. Иначе обычный rebalance отправлял бы в DLQ исправные сообщения.
- **DLQ:** `<consumer-group>.dlq` с заголовками `x-original-*`, `x-handler`, `x-error`, `x-attempts`. В DLQ пишет producer напрямую, мимо outbox: это не доменное событие, и изменения в БД, с которым его нужно связать атомарно, нет. Если отправка в DLQ не удалась, обработка сообщения падает целиком, offset не коммитится, и сообщение придёт снова.
- **`dlq-reprocess`** — CLI сервиса (`node dist/main.js dlq-reprocess`). Поднимает Nest application context без HTTP, relay и основных consumer'ов. Читает DLQ группой `<consumer-group>.dlq-reprocess` до offset'ов конца, запомненных при старте, и завершается. Вызывает только обработчик из `x-handler`. Если обработка снова не удалась, сообщение уходит в тот же DLQ с `x-attempts + 1`; в текущем запуске оно уже не прочитается, потому что лежит после запомненного конца.
- `eachMessage`, `partitionsConsumedConcurrently` берётся из env (по умолчанию 3). Параллельной обработки внутри партиции нет.
- Неизвестный для этого сервиса `type` в топике: пропустить, записать в лог на уровне debug и закоммитить offset. Это не ошибка: в топике контекста лежат и события, которые нужны другим сервисам.

## 7. Шаблон сервиса (генератор)

`pnpm nx g @repo/generators:service <name> [--thin]` (`--thin` даёт тонкую схему из SD-00, п. 8):

| Что создаётся или меняется        | Содержание                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/<name>/src/instrumentation.ts`, `main.ts` | `initTelemetry`; Nest app → relay и consumer runner                           |
| слои `domain/ application/ infrastructure/ interface/` | пустые, с правилом `no-restricted-imports` для `domain` (SD-00, п. 8)  |
| `prisma/schema.prisma`, `prisma.config.ts` | модели `Outbox`, `ProcessedEvent`; output `src/generated/prisma`, `moduleFormat = "cjs"`; adapter-pg, пул из `DB_POOL_MAX` (ADR-0004, п. 4–5) |
| первая миграция                   | DDL `outbox` и `processed_events` из `libs/*/sql/` (п. 6)                                    |
| `project.json`                    | теги `type:app`, `platform:node`; таргеты `prisma-generate`, `serve`, `build`, `test`, `test-integration`, `migrate` |
| `Dockerfile`                      | multi-stage: `deps` → `build` → `migrate` (Prisma CLI) → `runtime` (`nx prune`, ADR-0003, п. 6) |
| `apps/<name>/compose.yaml`        | `<name>-migrate` (одноразовый, после `db-provision`) и `<name>` с `depends_on: service_completed_successfully`, профили `core`/`full`, `build.context: ../..` |
| корневой `compose.yaml`           | строка в `include:`                                                                         |
| `infra/postgres/services.txt`     | строка `<name>`                                                                             |
| `infra/kafka/topics.conf`         | топик `<name>-service.dlq`                                                                  |
| `.env.example`                    | `<NAME>_DB_PASSWORD`, `DB_POOL_MAX` и прочие ключи сервиса                                  |
| тесты                             | unit-пример, интеграционный тест «outbox → Kafka → собственный consumer → processed_events» |

Генератор должен оставаться рабочим, поэтому CI создаёт из него временный `demo`-сервис, прогоняет все его задачи и выбрасывает (п. 9).

## 8. Тестирование этапа

| Уровень                       | Что                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (Jest)                   | конверт: валидация, `createEnvelope` из контекста; `money`: операции, `floor` в `mulBp`, `mulBp` на больших суммах без потери точности, переполнение → ошибка, `toSafeNumber`; реестр: ключ партиции из payload; upcaster-цепочка; классификация ошибок и расписание ретраев; построение DLQ-заголовков; конвейер consumer runner на фейковом транспорте (в том числе: перебалансировка во время ретраев → без DLQ; второй обработчик упал → первый не вызывается повторно); цикл relay на фейковых store/producer (порядок, пометка только после успешной отправки, backoff); генератор: миграция совпадает с DDL из libs |
| Property-based (fast-check)   | `money`: `add`/`sub` обратимы, `sum` не зависит от порядка, `mulBp` ≤ исходной суммы при `bp ≤ 10 000`                                                                               |
| Интеграционные (Testcontainers) | relay публикует в порядке `id`; «упал между send и mark» → дубль, но потребитель обработал один раз; два relay — публикует только лидер; обрыв соединения лидера → лидерство переходит; временная ошибка → ретраи → успех; постоянная → DLQ с заголовками; DLQ-топика нет → offset не закоммичен; `dlq-reprocess` повторяет обработку и завершается; `traceparent` проходит outbox → Kafka → consumer |
| Контрактные                   | на каждую версию каждого сообщения есть `fixtures/<type>.v<N>.json`, она проходит свою схему и приводится к последней версии; фикстура без определения — ошибка. Первая — `smoke.pinged.v1` |
| Infra (CI)                    | `db-provision`, запущенный дважды, не падает и не меняет результат                                                                                                                    |

- Раннер — Jest с `@swc/jest`: быстрее, чем ts-jest, а типы и так проверяет отдельная задача `typecheck`. В конфиге swc включены `legacyDecorator` и `decoratorMetadata`, иначе DI Nest в тестах не работает.
- Unit-тесты — таргет `test`, интеграционные — `test-integration` (файлы `*.int-spec.ts`), чтобы `test` работал без Docker.
- Интеграционные тесты шины (outbox → Kafka → consumer → `processed_events`) живут в `libs/kafka`: это единственная lib, которая видит все три части. Postgres и Kafka поднимаются один раз на прогон (`globalSetup`); у каждого теста свои топики и группы. Kafka — `apache/kafka`, как в compose. Модуль Testcontainers для Kafka умеет только образы Confluent, поэтому контейнер настраивается через `GenericContainer`.
- Порог покрытия 80% для `libs/contracts` и чистой логики `libs/kafka`/`outbox`. Это страховка, а не цель (SD-00, п. 9).

## 9. CI (`.github/workflows/ci.yml`)

| Job                | Что делает                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `check`            | `nx affected -t lint typecheck test build` (ADR-0003, п. 7)                                     |
| `integration`      | `nx affected -t test-integration`. Docker на `ubuntu-latest` уже есть, Testcontainers работает |
| `generator-smoke`  | `nx affected -t smoke`: таргет `smoke` у проекта генератора генерирует `demo`, запускает его `lint typecheck test test-integration build` и ничего не коммитит. Генератор зависит от libs, поэтому smoke срабатывает и при их изменении |
| `infra-smoke`      | `cp .env.example .env`, `infra/up.sh`, `infra/smoke.sh`; затем ещё раз `up.sh` и `smoke.sh` — проверка идемпотентности |

Node берётся из `.nvmrc` (`node-version-file`), а не `lts/*` из примера в ADR-0003. Репозиторий — приватный `marketplace` на GitHub (бесплатных минут Actions на приватный репо хватает с запасом).

## 10. Порядок работ

1. Nx + pnpm воркспейс, TS-конфиг, ESLint (границы модулей) + Prettier, Jest. Первый коммит каркаса.
2. GitHub-репозиторий и CI с job `check`: всё дальнейшее сразу проверяется в CI. Остальные job'ы добавляются вместе со своими шагами.
3. `infra/`: compose, provisioning Postgres, декларация топиков, job `infra-smoke`. Проверка: критерий 1.
4. `libs/contracts`: unit и property-based тесты.
5. `libs/observability`.
6. `libs/outbox`, `libs/idempotency`, `libs/kafka`: unit, затем интеграционные тесты и job `integration`.
7. Генератор сервиса и job `generator-smoke`; проверка на `demo` (критерий 3).
8. CHANGELOG, SD-01 → «Реализовано», ТЗ: этап 1 ✅.

## Открытые вопросы

- Ничего блокирующего. Решения, принятые здесь: Postgres 16, деньги в TS как safe-integer `number` (`mulBp` через `BigInt`), id — UUID v7 в колонках `uuid` без префиксов, `libs/auth` переносится на этап 2, relay на polling без LISTEN/NOTIFY и на выделенном соединении, provisioning баз вместо init-скрипта, каноническая DDL `outbox`/`processed_events` в libs.
