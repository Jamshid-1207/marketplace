import type { createKafka } from '@repo/kafka';
import type { PrismaClient } from '../generated/prisma/client';

/** Топики событий, из которых строятся проекции crm: их группа читает с начала (SD-06, п. 3). */
export const PROJECTION_TOPICS = ['auth.events', 'order.events', 'payment.events'];

/**
 * Replay проекций crm (ADR-0002, п. 9; SD-06, п. 5.4, решение 6). Сервис должен быть остановлен:
 * Kafka не сбрасывает offset группы, у которой есть участники. Проекции очищаются, offset группы
 * ставится на начало; после запуска crm перечитывает события и строит ту же картину —
 * обработчики детерминированы.
 */
export async function replay(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  kafka: ReturnType<typeof createKafka>,
  groupId: string,
): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const { groups } = await admin.describeGroups([groupId]);
    const members = groups[0]?.members.length ?? 0;
    if (members > 0) {
      throw new Error(`в группе ${groupId} ${members} участников: остановите crm перед replay`);
    }
    await prisma.$executeRaw`
      TRUNCATE customers, customer_orders, timeline, refunds, processed_events`;
    for (const topic of PROJECTION_TOPICS) {
      await admin.resetOffsets({ groupId, topic, earliest: true });
    }
  } finally {
    await admin.disconnect();
  }
}
