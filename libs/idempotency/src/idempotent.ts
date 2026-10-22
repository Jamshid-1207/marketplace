/**
 * Минимальный порт транзакции (SD-01, п. 6). Ему структурно соответствует
 * `Prisma.TransactionClient`, поэтому lib не зависит от сгенерированного клиента сервиса.
 */
export interface SqlTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/**
 * Выполняет `fn` один раз на пару (обработчик, событие): доставка at-least-once (ADR-0002, п. 7).
 * Вызывается внутри транзакции обработчика: отметка и изменения данных фиксируются вместе.
 *
 * Если та же пара обрабатывается параллельно (перебалансировка группы), второй INSERT ждёт
 * коммита первого и получает 0 строк. Возвращает `false`, если событие уже обработано.
 */
export async function idempotent(
  tx: SqlTx,
  handler: string,
  eventId: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const inserted = await tx.$executeRaw`
    INSERT INTO processed_events (handler, event_id)
    VALUES (${handler}, ${eventId}::uuid)
    ON CONFLICT DO NOTHING`;
  if (inserted === 0) return false;
  await fn();
  return true;
}

export const PROCESSED_EVENTS_RETENTION_DAYS = 30;

/**
 * Удаляет отметки старше срока порциями: одна большая DELETE держала бы долгую транзакцию.
 * Дубли приходят в пределах минут; старые повторы ловит проверка `aggregateVersion` (ADR-0002, п. 7).
 * Возвращает число удалённых строк.
 */
export async function cleanupProcessedEvents(
  sql: SqlTx,
  { olderThanDays = PROCESSED_EVENTS_RETENTION_DAYS, batchSize = 1_000 } = {},
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await sql.$executeRaw`
      DELETE FROM processed_events
      WHERE ctid IN (
        SELECT ctid FROM processed_events
        WHERE processed_at < now() - make_interval(days => ${olderThanDays}::int)
        LIMIT ${batchSize}::int
      )`;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
