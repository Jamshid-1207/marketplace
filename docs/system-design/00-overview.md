# System Design 00: Общая архитектура

**Статус:** 🟡 Черновик

## 1. Контекст (C4 L1)
```mermaid
flowchart LR
  Buyer([Покупатель]) --> SF[Storefront<br/>Next.js]
  Seller([Продавец / Менеджер]) --> BO[Backoffice<br/>Next.js]
  Admin([Админ]) --> BO
  SF --> GW[API Gateway]
  BO --> GW
  GW --> Platform[[Marketplace Platform]]
  Platform --> Mail[(Email / Telegram)]
```

## 2. Контейнеры (C4 L2)
```mermaid
flowchart TB
  GW[api-gateway]
  subgraph Services
    AUTH[auth]
    CAT[catalog]
    ORD[order<br/>Saga orchestrator]
    PAY[payment]
    ERP[erp]
    CRM[crm]
    NOTIF[notification]
  end
  K{{Kafka}}
  R[(Redis)]
  GW -->|REST| AUTH & CAT & ORD & ERP & CRM
  CAT --- R
  ORD --- R
  AUTH & CAT & ORD & PAY & ERP & CRM & NOTIF <-->|events| K
  AUTH --- DB1[(auth_db)]
  CAT --- DB2[(catalog_db)]
  ORD --- DB3[(order_db)]
  PAY --- DB4[(payment_db)]
  ERP --- DB5[(erp_db)]
  CRM --- DB6[(crm_db)]
  NOTIF --- DB7[(notif_db)]
```

## 3. Checkout Saga (happy path + компенсации)
```mermaid
sequenceDiagram
  participant O as order (orchestrator)
  participant E as erp
  participant P as payment
  participant C as crm
  O->>E: order.created
  E-->>O: stock.reserved
  E-->>C: (stock.reserved → timeline)
  O->>P: payment.requested
  alt оплата прошла
    P-->>O: payment.succeeded
    P-->>E: payment.succeeded → продажа, счёт, баланс
    P-->>C: payment.succeeded → LTV, сегмент
    O->>O: confirmed
  else отказ / таймаут
    P-->>O: payment.failed
    O->>E: stock.release (компенсация)
    O->>O: cancelled
  end
```

## 4. Надёжная публикация событий
```mermaid
flowchart LR
  UC[Use case] -->|1 транзакция| T[(business tables + outbox)]
  Relay[Outbox relay<br/>poll / CDC] --> T
  Relay -->|publish| K{{Kafka}}
  K --> Cons[Consumer]
  Cons -->|check processed_events| DB[(service db)]
```
- **Outbox:** нет «двойной записи». Если упадём между commit в БД и publish в Kafka, событие не потеряется.
- **Idempotency:** `processed_events(event_id PK)`, повторная доставка игнорируется.
- **Ключ партиции:** `aggregateId` (orderId, sku), чтобы события одного агрегата шли по порядку.

## 5. Конверт события (libs/contracts)
```ts
interface EventEnvelope<T> {
  eventId: string;        // uuid v7
  type: string;           // 'order.created'
  version: number;        // schema version
  occurredAt: string;     // ISO
  aggregateId: string;
  correlationId: string;
  payload: T;
}
```

## 6. Слои внутри сервиса (Clean / Hexagonal)
```
src/
  domain/          # entities, value objects, domain services: чистый TS, 100% unit-тесты
  application/     # use cases, ports (interfaces)
  infrastructure/  # prisma repos, kafka adapters, outbox relay
  interface/       # controllers, consumers, DTO
```
Jest unit-тесты пишем на `domain` и `application`, порты подменяем моками.

## 7. Топики Kafka (первая версия)
`auth.events`, `catalog.events`, `order.events`, `payment.events`, `erp.events`, `crm.events`, у каждого DLQ `*.dlq`.
Один топик на bounded context, тип события лежит в `type`.
