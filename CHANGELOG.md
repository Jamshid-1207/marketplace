# Changelog

Все изменения проекта. Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по этапам.
Типы: **Added**, **Changed**, **Fixed**, **Removed**, **Decided** (архитектурные решения).

## [Unreleased] · Этап 1: каркас
### Added
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
