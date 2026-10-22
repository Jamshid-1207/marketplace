# Changelog

Все изменения проекта. Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по этапам.
Типы: **Added**, **Changed**, **Fixed**, **Removed**, **Decided** (архитектурные решения).

## [Unreleased] · Этап 2: оформление без склада
### Added
- **Шаг 7: `apps/e2e` и CI job `e2e`** (SD-02, п. 9–10).
  - Сценарии 1–3 и 5–12 критерия готовности через gateway на compose-стенде; оплата — тестовым API fake-psp, остановка и «убийство» сервисов — `docker compose stop/kill/start`. Сценарий 2 передаёт свой `traceparent` в `POST /orders` и ищет трейс через API Jaeger: в нём должны быть gateway, order, payment и fake-psp. Сценарии 5 и 6 ждут один общий дедлайн.
  - `compose.e2e.yaml`: дедлайн оплаты 75 с (хватает на перезапуск сервиса посреди оплаты), списания 20 с, тик 1 с; лимит gateway 10 000 в минуту.
  - `apps/e2e/run.sh`: сборка образов → инфраструктура → сервисы до `healthy` → сценарии → логи при ошибке → стенд удаляется. Таргет `e2e` зависит от gateway, order, payment и fake-psp (`implicitDependencies`), поэтому `nx affected` запускает его при их изменении.
  - Тег `type:e2e`: из кода — только `libs/contracts`.
- **Шаг 6: `apps/gateway`** (генератор `--bare --port 3000`, SD-02, п. 3.1).
  - `/api/orders/**` → order (без префикса `/api`), `POST /webhooks/psp` → payment без JWT; тело — потоком, без разбора, поэтому подпись webhook сохраняется байт в байт. `X-Request-Id` и `traceparent` уходят в сервис.
  - JWT на `/api/**` (глобальный `AuthGuard`), лимит `RATE_LIMIT_PER_MINUTE` (100) на пользователя, на анонима — на IP; `429` сверх лимита.
  - Заглушка входа: эфемерный ключ Ed25519, `/.well-known/jwks.json`, `POST /dev/login { user }` при `DEV_AUTH=true` (в compose — по умолчанию).
  - Сервис недоступен — `502`, таймаут — `504`.
  - 11 тестов на настоящих HTTP-серверах вместо order и payment.
- `libs/auth`: `JwtVerifier` и `AuthModule` принимают JWKS из памяти (`{ jwks }`) — gateway проверяет свои токены без запроса к себе.
- Локальный `serve`: order на 3101, payment на 3102 — как ждёт gateway.
- **Шаг 5: `apps/order`** (полный шаблон генератора, SD-02, п. 5).
  - Данные: `catalog_skus` (read-model каталога), `orders`, `order_lines` (снимок цены и названия), `sub_orders`, `checkout_sagas` (с `correlation_id` и `trace_headers`), `idempotency_keys`; CHECK на состояния.
  - Seed каталога из `libs/contracts/src/dev` (`dist/seed.js`, идемпотентный upsert) — в шаге `order-migrate` при `SEED_CATALOG=true`.
  - Домен: `priceOrder` — цены из каталога, группировка по продавцам, суммы; `transition` — машина состояний этапа 2 чистой функцией, по тесту на каждую строку таблицы SD-02, п. 5.2.
  - `POST /orders` (`202`, `Idempotency-Key` в транзакции заказа: повтор — тот же заказ, другое тело — `422`, недоступный SKU — `422` со списком), `GET /orders/:id` (чужой — `404`), `GET /orders` (курсор). Покупатель — только из JWT (`libs/auth`, JWKS gateway).
  - Обработчики `payment.*`: блокировка saga → `processed_events` → `transition` → состояние, под-заказы, outbox.
  - Планировщик дедлайнов раз в `CHECKOUT_TICK_MS`: каждая просроченная saga в своей транзакции (`SKIP LOCKED`) и в цепочке и трейсе своего `POST /orders`; очистка ключей идемпотентности старше суток.
  - Тесты: 30 unit, интеграционные на Testcontainers — HTTP с настоящим JWT, конкурентный `Idempotency-Key`, полный путь через Kafka до `CONFIRMED`, дубль события, одновременные `payment.authorized` и дедлайн, список с курсором.
  - compose: `JWKS_URL` gateway, дедлайны из env (`PAYMENT_DEADLINE_MS`, `CAPTURE_DEADLINE_MS`, `CHECKOUT_TICK_MS`) — e2e задаст секунды.
- `libs/observability`: `/health/*` помечены публичными (`PUBLIC_ROUTE`); `@Public()` из `libs/auth` ставит ту же метку — глобальный `AuthGuard` не закрывает health-пробы.
- **Шаг 4: `apps/payment`** (полный шаблон генератора, SD-02, п. 6).
  - Платёж: таблица `payments` (один на заказ, статус с CHECK, `correlation_id` и `trace_headers` оформления), статусы `CREATING` → `AWAITING_AUTHORIZATION` → `AUTHORIZED` → `CAPTURING` → `CAPTURED`, ветки `CAPTURE_FAILED`, `FAILED`, `CANCELLING` → `CANCELLED`. Решения по командам и webhook — чистые функции `domain/payment.ts`.
  - Команды `CreatePayment`, `CapturePayment`, `CancelPayment` в три шага: транзакция 1 — промежуточный статус, вызов провайдера с `Idempotency-Key = <paymentId>:<операция>`, транзакция 2 — итог и событие в outbox. Повторная доставка после сбоя повторяет вызов с тем же ключом: провайдер не выполняет операцию второй раз. Повтор уже выполненной команды публикует итоговое событие ещё раз.
  - `POST /webhooks/psp`: подпись HMAC с допуском 5 минут (иначе `401`), поиск по `merchantReference`, обработка в цепочке и трейсе оформления, `processed_events`; платёж ещё создаётся или база недоступна — `503`.
  - Клиент провайдера на `fetch`: 5xx, 429, сеть и таймаут — временная ошибка, 4xx — окончательный отказ.
  - Тесты: 41 unit (переходы, use case'ы на двойнике провайдера по HTTP, подпись, клиент), интеграционные на Testcontainers — полный поток через Kafka, сбой между списанием и транзакцией 2 (сценарий 4: одно списание), дубль webhook, webhook раньше `payment.created`, отмена.
  - compose: `PSP_API_URL=http://fake-psp:3000`, общий `PSP_WEBHOOK_SECRET`.
- `libs/observability`: инструментация `fetch` (undici) — вызовы провайдера в трейсе; `runInStoredTrace` — продолжить сохранённый трейс из webhook или планировщика, связав его ссылками с входящим спаном.
- Генератор: `tsconfig.spec.json` включает `src/testing/**/*.ts` — помощники тестов сервиса.
- **Шаг 3: `apps/fake-psp`** — заглушка провайдера (генератор `--bare`, порт 4000).
  - Платёж в два шага: `requires_action` → `authorized` → `captured`, отмена `voided`, истечение неоплаченного `expired` (`PSP_PAYMENT_TTL_MS`, по умолчанию 30 мин). Отказ банка не завершает платёж.
  - API `/v1/payments` (создание, списание, отмена — только с `Idempotency-Key`: повтор возвращает сохранённый ответ и ничего не выполняет, другой запрос с тем же ключом — `422`), страница оплаты `/pay/:id`.
  - Webhook `payment.authorized` и `payment.expired` с подписью `X-PSP-Signature: t=…,v1=HMAC-SHA256`, повторы 1, 2, 4… до 60 с в течение `PSP_WEBHOOK_RETRY_FOR_MS`.
  - Тестовое API (`PSP_TEST_API`): оплата, отказ и истечение без браузера, режим дублей webhook, счётчики фактических списаний и отмен.
  - 24 теста: модель, доставка webhook, HTTP-поток целиком с настоящим получателем webhook.
  - compose: `PSP_WEBHOOK_URL` через gateway, общий с payment `PSP_WEBHOOK_SECRET` в `.env.example`.
- **Шаг 2: контракты оформления** (`libs/contracts`).
  - Команды `payment.commands` (ключ `orderId`, `aggregateType: order`): `CreatePayment`, `CapturePayment` (сразу с разбивкой по под-заказам и категориям для этапа 4), `CancelPayment`.
  - События `payment.*` (ключ `paymentId`, каждое несёт `orderId`): `created`, `authorized`, `failed`, `cancelled`, `captured`, `capture-failed`. События `order.*` (ключ `orderId`): `created`, `confirmed` (под-заказы целиком для наблюдателей), `cancelled`.
  - Общие схемы `CheckoutState`, `CancelReason`, `SubOrderStatus` — сразу со значениями этапа 3, чтобы не версионировать enum. `PositiveMoneySchema`.
  - API order: `CreateOrderRequest` (без цен: они из каталога), `OrderView`, `OrderListResponse`.
  - `dev/fixtures`: тестовые пользователи и seed-каталог двух продавцов до этапа 5.
  - 12 контракт-фикстур; топики `order.events`, `payment.events`, `payment.commands` в `topics.conf`. Тестов contracts — 68.
- **Шаг 1 (SD-02, п. 12).**
  - Генератор: `--bare` — сервис без базы и Kafka (шаблоны данных вынесены в `files/data`); дефис в имени допустим только у bare-сервиса; порт хоста публикуется только по `--port` (ADR-0001, п. 1), `generator-smoke` передаёт `--port 3001`. Тестов генератора — 14. Обе разновидности проверены настоящей генерацией: lint, typecheck, test, build; bare-сервис отвечает `/health/ready` = 200.
  - `libs/auth`: `JwtVerifier` (jose, удалённый JWKS с кэшем, EdDSA, `iss`/`aud`/`exp`, claims по схеме ADR-0006), глобальный `AuthGuard` и `@Public()`, `@CurrentClaims()`, `@BuyerScope()` → `AccessScope`, `DevTokenIssuer` для заглушки входа в gateway (до этапа 5). 11 тестов через настоящий HTTP JWKS: просрочка, чужой ключ, чужие `iss`/`aud` при верной подписи, подмена claims, `401`/`403`, игнор `X-User-Id`.
- `docs/system-design/02-checkout-without-stock.md`: дизайн этапа 2 — gateway, order, payment, fake-psp, `libs/auth`, 12 сценариев готовности, машина состояний этапа 2, вызовы провайдера без потерь и дублей, один трейс на оформление, job `e2e`.
### Decided
- SD-02, ревизия 4 — реализация gateway: прокси в обработчиках контроллера ради guard'ов, тело без разбора, `http-proxy-middleware` 3.x (4.x только ESM), webhook без лимита, ключи JWT из памяти до этапа 5.
- SD-02, ревизия 3 — уточнения order: дедлайны в env с суффиксом `_MS`; seed — `src/seed.ts`, собранный с сервисом, а не `prisma/seed.ts`; `title` в `order_lines`; под-заказы `CANCELLED` при отмене заказа; планировщик — транзакция на каждую saga.
- SD-02, ревизия 2 — уточнения payment по ходу реализации: отмена из `CAPTURE_FAILED` снимает авторизацию; отмена из `CREATING` повторяет создание тем же ключом и снимает платёж; webhook раньше `payment.created` — `503`; колонка `failure_reason`; id события провайдера в `processed_events` — UUID v8 из SHA-256.
- SD-02 утверждён: корзина — на этапе 7 со storefront; ключи JWT до этапа 5 — по JWKS из gateway (эфемерный ключ); сбой payment между списанием у провайдера и записью результата проверяется интеграционным тестом без точек отказа в рабочем коде; тестовые пользователи и seed-каталог временно в `libs/contracts/src/dev/`.

## [0.2.0] - 2026-10-22 · Этап 1: каркас ✅
Критерии SD-01 выполнены, все четыре job'а CI зелёные: `check`, `integration`, `infra-smoke`, `generator-smoke`.

### Added
- **Шаг 7: генератор сервиса** `pnpm nx g @repo/generators:service <name> [--thin] [--port]`.
  - Шаблон: Nest 12 со своей конфигурацией на zod и режимами `server`/`cli`, `PrismaService` на adapter-pg, Kafka, producer, outbox relay, consumer runner с запуском и остановкой, очистка `processed_events`, проверки готовности, `instrumentation.ts`, команда `dlq-reprocess`, Dockerfile (`pnpm deploy`), первая миграция из DDL libs, unit- и интеграционный тест.
  - Генератор дописывает базу в `services.txt`, DLQ в `topics.conf`, пароль в `.env.example`, сервисы `<name>-migrate` и `<name>` в корневой `compose.yaml`, ссылку в `tsconfig.json`. Версии берёт из libs.
  - 10 unit-тестов генератора.
  - CI job `generator-smoke` (`tools/generators/smoke.sh`): генерация `demo` → задачи Nx → интеграционные тесты → `prisma migrate diff` без расхождений → образ и compose до `/health/ready` = 200 → сервис в Jaeger и `traceId` в логах → `dlq-reprocess`.
- `libs/testing`: Testcontainers (`apache/kafka`, `postgres`) и помощники тестов для libs и сервисов.
- `@repo/observability/telemetry`: отдельный подпуть, чтобы `instrumentation.ts` не загружал Nest раньше ESM-хуков.
- Правило ESLint для слоя `domain` (SD-00, п. 8); тег `type:tooling`.
- README: быстрый старт.
### Fixed
- `correlationId` из логов kafkajs (номер запроса протокола) затирал `correlationId` цепочки — теперь `kafkaCorrelationId`.
- `dlq-reprocess`: повтор `retriable`-ошибок kafkajs admin (NOT_COORDINATOR у новой группы).
- `ConsumerRunner` без обработчиков не запускает consumer.
### Decided
- SD-01, ревизия 8 (✅ Реализовано): сервисы — прямо в корневом `compose.yaml` вместо `include`; образ — `pnpm deploy --prod` вместо `nx prune` (ADR-0003, п. 6); обвязка сервиса в обеих схемах слоёв — `src/infrastructure/`; pnpm разрешены install-скрипты Prisma.
### Known
- kafkajs 2.2.4 на Node 24 печатает `TimeoutNegativeWarning`: безвредно, известная особенность kafkajs. Замена клиента — ADR-0002, «Потом».
- Инструментация OTel `nestjs-core` пока не поддерживает Nest 12: трейс запроса строится по спанам HTTP и Express.

## Этап 1, шаги 1–6
### Added
- **Шаг 6: шина.**
  - `libs/idempotency`: `idempotent(tx, handler, eventId, fn)`, очистка `processed_events` порциями, каноническая DDL `sql/processed_events.sql`.
  - `libs/outbox`: `outbox.add(tx, definition, payload, { aggregateId, aggregateVersion })` с `traceparent` в `headers`, каноническая DDL `sql/outbox.sql`.
    - `OutboxRelay`: лидерство через advisory lock; публикация в порядке `id`; пометка только после отправки; backoff; потеря соединения означает переизбрание; очистка отправленных раз в час силами лидера; быстрый `stop()`.
    - `PgRelayStore` работает на выделенном `pg.Client`.
  - `libs/kafka`:
    - `createKafka` (логи kafkajs идут через логгер сервиса) и `KafkaPublisher` (idempotent, `maxInFlightRequests: 1`, без автосоздания топиков) с `KafkaReadinessCheck`.
    - `ConsumerRunner`: разбор и upcast через реестр, контекст цепочки (`causationId = eventId`) и `traceparent`. Ретраи по каждому обработчику отдельно, паузы кусками с heartbeat, перебалансировка или остановка — без DLQ. DLQ напрямую с заголовками ADR-0002; если DLQ недоступен, offset не коммитится.
    - `reprocessDlq()`: читает DLQ до конца, запомненного при старте; повторная ошибка — обратно в DLQ с `x-attempts + 1`.
  - Тесты: unit — idempotency 5, outbox 14, kafka 29. Интеграционные на Testcontainers — 9: порядок по агрегатам, единственный лидер, смена лидера после обрыва соединения, дубль после падения обработан один раз, ретраи, DLQ с заголовками, нет DLQ-топика — offset стоит, `dlq-reprocess`, сквозной `traceparent`. CI job `integration` прошёл два прогона подряд.
- **Шаг 5: `libs/observability`** (`type:infra`, `platform:node`).
  - `ObservabilityModule.forRoot({ serviceName, readinessChecks, imports })`: логгер, контекст цепочки, health.
  - Контекст цепочки на `AsyncLocalStorage`: `runWithContext`, `runInNewChain`, `requireContext`. `CorrelationMiddleware` берёт `X-Request-Id` (небезопасный заменяет новым id) и возвращает его в ответе.
  - pino через nestjs-pino: в каждой записи `service`, `correlationId`, `traceId`, `spanId`; health-пробы в лог не пишутся.
  - `/health/live` и `/health/ready` на terminus: проверки готовности подключаются извне, у каждой таймаут 2 с, упавшая даёт 503 с причиной.
  - `initTelemetry` (OTLP HTTP; HTTP, Express, pg, Nest) и `currentTraceHeaders`/`runWithTraceHeaders` для передачи `traceparent` через outbox и Kafka.
  - Тесты: 18 (контекст, трейс на in-memory провайдере, модуль через supertest). Рантайм в настоящем Node проверен вручную: Nest 12 из CommonJS, ESM-хуки, поля логов.
- **Шаг 4: `libs/contracts`** (`type:contracts`, `platform:shared`; зависит только от `zod`).
  - **Конверт:** `EnvelopeSchema` и `createEnvelope(definition, payload, { aggregateId, aggregateVersion }, { correlationId, causationId })`. Контекст передаётся явно: в contracts нет Node API.
  - **Реестр:** `defineMessage` проверяет имя по соглашению ADR-0002 и запрещает команду в топике событий (и наоборот). `MessageRegistry` запрещает менять топик или агрегат между версиями и даёт `verify()` (версии без пропусков, upcaster на каждую старую). `decode()`: конверт → схема своей версии → upcast → схема последней версии; нарушения — `ContractError`, неизвестный тип — `unknown-type`.
  - **Деньги:** `Money`, `add`/`sub`/`sum`/`mulBp` (через `BigInt`, floor)/`toSafeNumber`, при выходе за safe integer — `MoneyError`.
  - **Id:** `newId()` — UUID v7 без зависимостей, монотонный внутри процесса (RFC 9562, метод 1).
  - Служебное событие `smoke.pinged` v1 (топик `smoke.events`) и контракт-тесты по `fixtures/`.
  - Тесты: 42 (unit, property-based на fast-check, контрактные); покрытие 98% строк и 100% веток при пороге 80%.
- **Шаг 3: локальная инфраструктура.**
  - `compose.yaml`: postgres 16.15, kafka 4.3.2 (KRaft, три listener'а, явный heap), kafbat-ui v1.5.0, jaeger 2.22.0 (память, `max_traces: 50000`), mailpit v1.31.6. Инфраструктура в профилях `infra`/`core`/`full`, у каждого контейнера лимит памяти.
  - `infra/postgres/provision.sh`: идемпотентно создаёт роли и базы по `services.txt` (7 сервисов из ADR-0004), выравнивает пароли по `.env`, делает `REVOKE CONNECT … FROM PUBLIC`.
  - `infra/kafka/create-topics.sh`: создаёт топики из `topics.conf`, выравнивает retention у существующих, падает при расхождении числа партиций.
  - `pnpm infra:up` / `infra:smoke` / `infra:down`, `.env.example`.
  - CI job `infra-smoke`: два прогона подряд, оба зелёные. Это критерий 1: базы и владельцы, вход по паролю, чужая база недоступна, топики, UI.
- **Шаг 2: GitHub и CI.** Приватный репозиторий `Jamshid-1207/marketplace`, ветка `main`. `.github/workflows/ci.yml`, job `check`: `format:check`, `nx sync:check`, `nx affected -t lint typecheck test build`. Node — из `.nvmrc`, pnpm — из `packageManager`. Права: `contents: read`, `actions: read` (без него `nx-set-shas` не находит базовый коммит). Остальные job'ы добавляются вместе со своими шагами.
- **Шаг 1 (SD-01, п. 10): Nx-воркспейс.** pnpm 12 workspaces (`apps/*`, `libs/*`, `tools/*`) и TypeScript project references с условием экспорта `@repo/source`; inferred-таргеты `typecheck`, `build`, `lint`, `test` через плагины Nx; ESLint 10 flat config с границами модулей из ADR-0003, п. 4; Prettier; Jest 30 на `@swc/jest` с декораторами Nest; `.nvmrc`, `.editorconfig`, LF через `.gitattributes`. Проверено на временных libs (не закоммичены): `lint typecheck test build` зелёные, сборка даёт CommonJS, импорт node-lib из `platform:web`/`type:ui` валит lint.
- `docs/system-design/01-skeleton.md`: дизайн этапа 1 (на согласовании) — compose `infra`, API libs, генератор сервиса, тесты, CI.
### Decided
- PostgreSQL 16; деньги в TS/JSON — safe-integer `number`, в базе `bigint`; id — UUID v7 в колонках `uuid`; `libs/auth` переносится на этап 2; outbox relay на polling.
### Decided
- **NestJS 12.** Распространяется только в ESM; наш код остаётся CommonJS и грузит Nest через `require(esm)` из Node 24. Jest — с `--experimental-vm-modules` (`targetDefaults.test` в `nx.json`). OpenTelemetry — через синхронные ESM-хуки `import-in-the-middle`, отсюда `engines.node >= 24.11.1`. Инструментация `nestjs-core` пока не поддерживает Nest 12 (SD-01, ревизия 6).
- SD-01, ревизия 5: служебное событие названо `smoke.pinged`, а не `smoke.ping`: имя события — действие в прошедшем времени (ADR-0002, п. 5).
- SD-01, ревизия 4: декларация топиков — `topics.conf`, а не `topics.json` (в образе Kafka нечем разбирать JSON); запуск через `infra/up.sh`, потому что `up --wait` считает ошибкой завершившиеся одноразовые контейнеры.
- SD-01 утверждён (ревизия 3). Версии на момент init: Nx 23.3, TypeScript 6.0 (7.x не поддерживает typescript-eslint), NestJS 12, Prisma 7.10 (8.x в rc), pnpm 12 через `npm i -g` вместо corepack.
### Changed (ревью SD-01, ревизия 2)
- **Postgres:** init-скрипт заменён одноразовым идемпотентным `db-provision` по списку `infra/postgres/services.txt`: новый сервис (и `demo`) получает базу без пересоздания тома (SD-01, п. 5; ADR-0004, п. 1, 6).
- **Relay outbox** работает на выделенном `pg.Client`: session-level advisory lock нельзя удержать через пул; +1 соединение на инстанс в бюджете (SD-01, п. 6.3; ADR-0004, п. 5).
- **`outbox.headers jsonb`** для `traceparent`; индекс `(published_at, id)` вместо частичного, которого не выражает Prisma-схема (ADR-0002, п. 6).
- **`outbox.add()`** принимает `aggregateId` и `aggregateVersion` явно; реестр сообщений знает `aggregateType`.
- **Каноническая DDL** `outbox`/`processed_events` в `libs/*/sql/`; генератор копирует её в миграцию, тест сверяет.
- ADR-0001: исключение из правила «lib — по факту» для технических libs этапа 1.
### Fixed (ревью SD-01)
- **Compose:** `include` не поддерживает glob — строку дописывает генератор; `build.context: ../..` во включённых файлах; инфраструктура в профилях `infra`/`core`/`full`, иначе `--profile core` не поднимает Postgres.
- **DLQ-топики** декларируются (автосоздание выключено, иначе партиция встаёт навсегда); в DLQ пишет producer напрямую, мимо outbox (ADR-0002, п. 8).
- **Перебалансировка во время ретраев** прерывает ретраи без отправки в DLQ.
- **`mulBp`** считает через `BigInt`: `amount × bp` переполнял safe integer на суммах от ~9·10¹¹ тийинов.
- **OpenTelemetry** грузится через `--require instrumentation.js`: вызов в первой строке `main.ts` срабатывает после импортов.
- Консумер валидирует payload схемой его версии до upcast; ретраи и DLQ — по каждому обработчику отдельно.
- `dlq-reprocess`: отдельный application context, чтение до запомненного конца, повторная ошибка → обратно в DLQ с `x-attempts + 1`.
- Kafka: listener `CONTROLLER`, явный heap; `kafka-init` выравнивает retention; служебный топик `smoke.events` без `_`. Jaeger с `max_traces`.
- CI: Node из `.nvmrc`; `generator-smoke` через affected-таргет; CI настраивается вторым шагом, а не в конце.

## [0.1.0] - 2026-10-22 · Этап 0: ТЗ утверждено
### Changed
- **ТЗ 0.1.0:** требования разделены на MVP и «после MVP»; финансы продавца входят в MVP; таблица ERP ↔ CRM переписана под saga; оплата в два шага (авторизация и списание); Redis убран; суммы хранятся в `bigint`; этапы перестроены в сквозные сценарии; закрыты открытые вопросы v0.0.1 (доставка — только статусы, комиссия по категориям, чата нет, телефон после MVP). Статус: ✅ утверждено.
- **SD-00:** уровни C4 разведены; добавлены каталог сообщений, разделы про деньги, изоляцию продавцов, слои сервиса и стратегию тестирования.
- **ADR-0001:** драйверы решения, владение данными, правила синхронных вызовов, профили compose, шаблон сервиса; `admin` переименован в `backoffice`.
- **ADR-0002:** свой адаптер поверх kafkajs, топики `<context>.events` и `<context>.commands`, retention, outbox, конверт с `causationId`, DLQ на consumer group, процедура replay.
- **ADR-0003:** статус «Принято»; pnpm, project references, контракты на zod, теги границ модулей, upcasters и контракт-тесты; `libs/common` убран.
- **ADR-0004:** пользователи БД и `REVOKE CONNECT`, правила read-model, Prisma 7, бюджет соединений, миграции отдельным шагом, бэкапы.
### Decided
- ADR-0005: checkout saga — оркестрация в order, резерв до оплаты, оплата в два шага, под-заказы по продавцам.
- ADR-0006: изоляция продавцов — общие таблицы с `seller_id`, область доступа в каждом репозитории, тесты изоляции, RLS на этапе hardening.
- ADR-0007: деньги — журнал проводок по двойной записи в payment, комиссия по категориям, удержание, выплаты.
### Fixed (по итогам ревью)
- **Гонка `aggregateVersion` заказа:** действия с под-заказом блокируют сначала строку заказа, потом строку под-заказа; добавлено `checkout_sagas.version` и интеграционный тест (ADR-0005, п. 1, 5, 7, 11).
- **`sku` → глобальный `skuId`** в командах, событиях, ключах партиций и таблицах; `skuCode` остаётся артикулом продавца (ADR-0002, 0005, 0006, 0007, SD-00).
- **`RefundPayment` без суммы:** payment берёт сумму из `settlements` (ADR-0005, п. 5 и 8).
- **Триггер баланса проводки** ловит проводку без записей и с одной записью (ADR-0007, п. 7).
- Исключение для `seller_id NULL` у платформенных счетов (ADR-0006, п. 5).
- Read-model категорий в payment для проверки ставок комиссии; событие `category.*` в каталоге сообщений (ADR-0007, п. 4; SD-00).
- Конкурентный `Idempotency-Key`: после `unique_violation` результат читается в новой транзакции (ADR-0005, п. 9).
- Политика очистки `processed_events` — 30 дней (ADR-0002, п. 7).
- Seed-товары несут `skuId`, `sellerId`, `categoryPath` (ТЗ, раздел 8).
- Горячие строки `cash:psp` и `commission:deferred` зафиксированы как известное ограничение (ADR-0007).
### Removed
- Блоки «Ревизия N» в начале ADR и SD-00: история изменений теперь ведётся только здесь, а в шапке документа остаётся номер ревизии.

## [0.0.1] - 2026-10-22 · Этап 0: ТЗ и архитектура (черновик)
### Added
- `docs/TZ.md`: черновик технического задания (роли, сервисы, события ERP ↔ CRM, НФТ, этапы).
- `docs/system-design/00-overview.md`: общая архитектура (C4, Checkout Saga, Outbox, конверт события, слои сервиса).
- `README.md`: описание проекта и навигация по докам.
### Decided
- ADR-0001: микросервисы.
- ADR-0002: Kafka (KRaft).
- ADR-0003: Nx monorepo (предложено).
- ADR-0004: database per service.
