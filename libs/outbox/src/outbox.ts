import {
  createEnvelope,
  type AggregateRef,
  type AnyMessageDefinition,
  type Envelope,
  type PayloadOf,
} from '@repo/contracts';
import { currentTraceHeaders, requireContext } from '@repo/observability';

/**
 * Минимальный порт транзакции (SD-01, п. 6). Ему структурно соответствует
 * `Prisma.TransactionClient`, поэтому lib не зависит от сгенерированного клиента сервиса.
 */
export interface SqlTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/**
 * Запись события или команды в outbox — внутри транзакции use case, вместе с изменением
 * агрегата (ADR-0002, п. 6). Реестр даёт топик и ключ, контекст цепочки — correlation и
 * causation, а текущий спан — `traceparent`, чтобы трейс продолжился у потребителя.
 */
async function add<D extends AnyMessageDefinition>(
  tx: SqlTx,
  definition: D,
  payload: PayloadOf<D>,
  aggregate: AggregateRef,
): Promise<Envelope<PayloadOf<D>>> {
  const envelope = createEnvelope(definition, payload, aggregate, requireContext());
  const key = definition.key(envelope.payload);
  await tx.$executeRaw`
    INSERT INTO outbox (event_id, topic, message_key, payload, headers)
    VALUES (
      ${envelope.eventId}::uuid,
      ${definition.topic},
      ${key},
      ${JSON.stringify(envelope)}::jsonb,
      ${JSON.stringify(currentTraceHeaders())}::jsonb
    )`;
  return envelope;
}

export const outbox = { add };
