import { z } from 'zod';
import { defineMessage } from '../../registry';

/**
 * Служебное событие для проверки шины: smoke-тесты libs и сервиса-образца из генератора.
 * Доменного смысла нет.
 */
export const SmokePingedV1 = defineMessage({
  type: 'smoke.pinged',
  version: 1,
  kind: 'event',
  topic: 'smoke.events',
  aggregateType: 'smoke',
  schema: z.object({
    pingId: z.uuid(),
    note: z.string().max(200).optional(),
  }),
  key: (payload) => payload.pingId,
});
