import { z } from 'zod';
import { defineMessage } from '../../registry';

/** Учётная запись создана (SD-05, п. 4). Читает notification — письмо о регистрации (этап 6). */
export const UserRegisteredV1 = defineMessage({
  kind: 'event',
  topic: 'auth.events',
  aggregateType: 'user',
  type: 'user.registered',
  version: 1,
  key: (p: { userId: string }) => p.userId,
  schema: z.object({ userId: z.uuid(), email: z.email() }),
});
