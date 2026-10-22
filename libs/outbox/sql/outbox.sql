-- Каноническая DDL outbox (ADR-0002, п. 6; SD-01, п. 6, 6.3).
-- Генератор копирует файл в первую миграцию сервиса; тест генератора сверяет копию с этим файлом.
CREATE TABLE outbox (
  id           bigserial   PRIMARY KEY,
  event_id     uuid        NOT NULL UNIQUE,
  topic        text        NOT NULL,
  message_key  text        NOT NULL,
  payload      jsonb       NOT NULL,              -- конверт целиком
  headers      jsonb       NOT NULL DEFAULT '{}', -- traceparent для заголовков Kafka
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

-- не частичный: Prisma-схема частичный индекс не выражает (SD-01, п. 6)
CREATE INDEX outbox_unpublished ON outbox (published_at, id);
