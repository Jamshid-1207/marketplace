# Changelog

Все изменения проекта. Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по этапам.
Типы: **Added**, **Changed**, **Fixed**, **Removed**, **Decided** (архитектурные решения).

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
