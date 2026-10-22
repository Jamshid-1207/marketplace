import { z } from 'zod';
import { newId } from './ids';
import type { AnyMessageDefinition, PayloadOf } from './registry';

/** Конверт события или команды (ADR-0002, п. 5). */
export const EnvelopeSchema = z.object({
  eventId: z.uuid(), // UUID v7, ключ идемпотентности
  type: z.string().min(1),
  version: z.number().int().positive(), // версия схемы payload
  aggregateType: z.string().min(1),
  aggregateId: z.uuid(),
  aggregateVersion: z.number().int().positive(), // порядковый номер события агрегата
  occurredAt: z.iso.datetime({ offset: true }),
  correlationId: z.string().min(1).max(128), // один на всю цепочку, начиная с HTTP-запроса
  causationId: z.uuid().nullable(), // eventId сообщения, вызвавшего это; null у первого
  payload: z.unknown(),
});

export type Envelope<TPayload = unknown> = Omit<z.infer<typeof EnvelopeSchema>, 'payload'> & {
  payload: TPayload;
};

/** Контекст цепочки. Хранится в `libs/observability`; сюда передаётся явно: contracts не знает про Node. */
export interface MessageContext {
  correlationId: string;
  causationId: string | null;
}

/** Агрегат, к которому относится сообщение. Версию знает только use case (SD-01, п. 6.3). */
export interface AggregateRef {
  aggregateId: string;
  aggregateVersion: number;
}

export function createEnvelope<D extends AnyMessageDefinition>(
  definition: D,
  payload: PayloadOf<D>,
  aggregate: AggregateRef,
  context: MessageContext,
  now: Date = new Date(),
): Envelope<PayloadOf<D>> {
  const envelope = EnvelopeSchema.parse({
    eventId: newId(),
    type: definition.type,
    version: definition.version,
    aggregateType: definition.aggregateType,
    aggregateId: aggregate.aggregateId,
    aggregateVersion: aggregate.aggregateVersion,
    occurredAt: now.toISOString(),
    correlationId: context.correlationId,
    causationId: context.causationId,
    payload: definition.schema.parse(payload),
  });
  return envelope as Envelope<PayloadOf<D>>;
}
