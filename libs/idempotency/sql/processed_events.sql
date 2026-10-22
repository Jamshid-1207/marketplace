-- Каноническая DDL processed_events (ADR-0002, п. 7; SD-01, п. 6).
-- Генератор копирует файл в первую миграцию сервиса; тест генератора сверяет копию с этим файлом.
CREATE TABLE processed_events (
  handler      text        NOT NULL,
  event_id     uuid        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  -- handler в ключе: у одного события в сервисе может быть несколько обработчиков
  PRIMARY KEY (handler, event_id)
);

-- для очистки строк старше 30 дней
CREATE INDEX processed_events_processed_at ON processed_events (processed_at);
