# Техническое задание: Marketplace (ERP + CRM)

**Статус:** 🟡 Черновик (ждёт утверждения)
**Версия:** 0.0.1 · **Дата:** 2026-10-22

---

## 1. Цель проекта
Pet-проект: multi-vendor B2C маркетплейс (по типу Uzum/Ozon). Много продавцов, много покупателей.
Главная фишка проекта в том, что **ERP** (склад, остатки, продажи, финансы продавца) и **CRM** (клиенты, сегменты, поддержка, лояльность) работают вместе через события в Kafka.

Учебные цели: практика System Design (микросервисы, event-driven, Saga, Outbox), чистая архитектура на NestJS, unit-тесты на Jest.

## 2. Роли
| Роль | Что может |
|---|---|
| Покупатель | Каталог, поиск, корзина, заказ, оплата, отзывы, тикеты в поддержку, подписка «сообщить о поступлении» |
| Продавец (seller) | Свой магазин, товары, цены, склады и остатки, поставки, продажи, баланс/выплаты, его клиенты в CRM |
| Менеджер продавца | Склад (ERP) и/или поддержка (CRM), права выдаёт продавец |
| Админ платформы | Модерация продавцов и товаров, категории, глобальная аналитика, споры и возвраты |

## 3. Функциональные требования

### 3.1 Auth
- Регистрация и логин (email + пароль), JWT access (15 мин) и refresh (7 дней, ротация).
- RBAC: `buyer`, `seller`, `seller_manager`, `admin`.

### 3.2 Catalog
- Магазины продавцов, дерево категорий, товары с вариантами (SKU), цены, изображения.
- Поиск через PostgreSQL Full-Text Search, фильтры, пагинация.
- Модерация товаров (статусы `draft → on_review → published / rejected`).

### 3.3 Order + Payment
- Корзина (Redis), checkout.
- State machine заказа: `pending → stock_reserved → paid → confirmed → shipped → delivered`, плюс `cancelled` и `returned`.
- Saga checkout: резерв остатков → оплата → подтверждение, с компенсациями (снять резерв, сделать refund).
- Mock-платёжка: успех, отказ, таймаут.
- Заказ с товарами нескольких продавцов делится на под-заказы по продавцам.

### 3.4 ERP
- Склады продавца, остатки по SKU и складу (`on_hand`, `reserved`, `available`).
- Резервирование с TTL (если заказ не оплачен за 15 мин, резерв снимается).
- Поставки (purchase orders): создать, принять на склад.
- Продажи и счета (invoice), сторно при возврате.
- Финансы продавца: баланс, комиссия платформы, выплаты.
- Порог низкого остатка → событие `stock.low`.

### 3.5 CRM
- Профиль клиента 360°: заказы, платежи, тикеты, отзывы, timeline всех событий.
- Метрики: LTV, средний чек, частота покупок.
- Автосегменты: `new`, `regular`, `vip`, `sleeping` (правила настраиваемые).
- Тикеты поддержки (статусы, SLA), одобрение возврата.
- Отзывы и NPS после доставки.
- Подписки «товар снова в наличии».

### 3.6 Notification
- Email (SMTP/Mailpit локально) и Telegram-бот.
- Шаблоны, которые срабатывают по событиям.

## 4. Взаимодействие ERP ↔ CRM (через Kafka)
| Событие | Producer | Consumers → реакция |
|---|---|---|
| `order.created` | order | ERP: резервирует остаток · CRM: пишет в timeline |
| `stock.reserved` / `stock.reservation_failed` | erp | order: продолжает Saga / отменяет · CRM: фиксирует «потерянную продажу» |
| `payment.succeeded` | payment | ERP: создаёт продажу и счёт, начисляет баланс · CRM: пересчитывает LTV и сегмент |
| `order.delivered` | order | ERP: списывает резерв · CRM: просит отзыв/NPS |
| `crm.ticket.refund_approved` | crm | ERP: возврат на склад + сторно · payment: refund |
| `stock.low` | erp | notification: предупреждает продавца · ERP: черновик поставки |
| `crm.segment.changed` | crm | order: персональная скидка для VIP |
| `erp.product.restocked` | erp | CRM: уведомляет подписанных клиентов |

## 5. Нефункциональные требования
- **Архитектура:** микросервисы, у каждого своя БД, между сервисами асинхронные события.
- **Надёжность:** Transactional Outbox, идемпотентные consumers, at-least-once доставка.
- **Безопасность:** bcrypt/argon2 для паролей, JWT, валидация DTO (class-validator), rate limit на gateway.
- **Наблюдаемость:** correlation-id сквозь HTTP и Kafka, структурированные логи (pino). На этапе 10: OpenTelemetry + Grafana.
- **Тесты:** Jest unit для доменной логики, покрытие домена не ниже 80%.
- **Локальный запуск:** `docker compose up`.
- **Локаль:** валюта UZS (суммы храним в тийинах, integer), i18n ru/uz закладываем.

## 6. Стек
| Слой | Технология |
|---|---|
| Backend | NestJS, TypeScript, Prisma |
| БД | PostgreSQL 16 (одна инстанция, отдельная БД на сервис) |
| Брокер | Kafka (KRaft) + Kafka UI |
| Кеш | Redis |
| Frontend | Next.js (App Router), TypeScript, Tailwind, shadcn/ui |
| Monorepo | Nx |
| Тесты | Jest |
| CI | GitHub Actions (lint + test) |

## 7. Вне MVP
Реальная платёжка, Elasticsearch, Kubernetes, мобильное приложение, рекомендательная система.

## 8. Этапы
Каждый этап идёт так: **System Design док → согласование → код → Jest → запись в CHANGELOG**.

| # | Этап | Статус |
|---|---|---|
| 0 | ТЗ + общая архитектура | 🟡 в работе |
| 1 | Monorepo, docker-compose, libs (contracts, kafka outbox/idempotency, common), CI | ⚪ |
| 2 | auth-service + api-gateway | ⚪ |
| 3 | catalog-service | ⚪ |
| 4 | erp-service: склады, остатки, резервы | ⚪ |
| 5 | order + payment + Saga checkout | ⚪ |
| 6 | crm-service + интеграция с ERP | ⚪ |
| 7 | notification-service | ⚪ |
| 8 | storefront (Next.js) | ⚪ |
| 9 | backoffice (Next.js): seller, ERP, CRM, admin | ⚪ |
| 10 | Observability, нагрузка, hardening | ⚪ |

## 9. Открытые вопросы
1. Доставка: только статусы (mock) или отдельный delivery-service?
2. Комиссия платформы: фиксированный % или по категориям?
3. Нужен ли чат покупатель ↔ продавец (в CRM)?
4. Логин по телефону и SMS (актуально для UZ) или достаточно email?
