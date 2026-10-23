import { Injectable } from '@nestjs/common';
import { newId } from '@repo/contracts';
import type { Prisma } from '../generated/prisma/client';
import { dedupKey, type Planned } from '../handlers/plan';
import { PrismaService } from '../infrastructure/prisma.service';
import type { Template, TemplateData } from '../templates/templates';

type Tx = Prisma.TransactionClient;

export interface DueNotification {
  id: string;
  template: Template;
  data: TemplateData[Template];
  attempts: number;
  /** `null` — адресат ещё неизвестен: событие с его email не дошло. */
  email: string | null;
}

export type Outcome = { sent: true } | { sent: false; error: string; retryAt: Date | null };

/** Read-модели адресатов и очередь писем (SD-06, п. 6.1–6.2). */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Изменения read-моделей и письма события — одной транзакцией. Повтор события ничего
   * не удваивает: read-модели — upsert, письма — по уникальному `dedup_key`.
   */
  record(eventId: string, update: (tx: Tx) => Promise<void>, mails: Planned[]): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await update(tx);
      for (const m of mails) {
        await tx.$executeRaw`
          INSERT INTO notifications (id, dedup_key, template, recipient_kind, recipient_id, data)
          VALUES (${newId()}::uuid, ${dedupKey(eventId, m)}, ${m.template}, ${m.recipientKind},
                  ${m.recipientId}::uuid, ${JSON.stringify(m.data)}::jsonb)
          ON CONFLICT (dedup_key) DO NOTHING`;
      }
    });
  }

  async recipient(tx: Tx, userId: string, email: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO recipients (user_id, email) VALUES (${userId}::uuid, ${email.toLowerCase()})
      ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email`;
  }

  async shop(tx: Tx, sellerId: string, ownerUserId: string, name: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO shops (seller_id, owner_user_id, name)
      VALUES (${sellerId}::uuid, ${ownerUserId}::uuid, ${name})
      ON CONFLICT (seller_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, name = EXCLUDED.name`;
  }

  async order(tx: Tx, orderId: string, buyerId: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO orders (order_id, buyer_id) VALUES (${orderId}::uuid, ${buyerId}::uuid)
      ON CONFLICT DO NOTHING`;
  }

  /**
   * Одно письмо, которому пора уйти: строка заблокирована до конца `deliver`, другой экземпляр
   * сервиса её пропустит (`SKIP LOCKED`). `false` — писем к отправке нет.
   */
  deliverNext(now: Date, deliver: (n: DueNotification) => Promise<Outcome>): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<
          {
            id: string;
            template: Template;
            data: TemplateData[Template];
            attempts: number;
            email: string | null;
          }[]
        >`
          SELECT n.id, n.template, n.data, n.attempts,
                 CASE n.recipient_kind
                   WHEN 'user' THEN
                     (SELECT r.email FROM recipients r WHERE r.user_id = n.recipient_id)
                   WHEN 'seller_owner' THEN
                     (SELECT r.email FROM shops s JOIN recipients r ON r.user_id = s.owner_user_id
                      WHERE s.seller_id = n.recipient_id)
                   WHEN 'order_buyer' THEN
                     (SELECT r.email FROM orders o JOIN recipients r ON r.user_id = o.buyer_id
                      WHERE o.order_id = n.recipient_id)
                 END AS email
          FROM notifications n
          WHERE n.status = 'pending' AND n.next_attempt_at <= ${now}
          ORDER BY n.next_attempt_at
          LIMIT 1
          FOR UPDATE OF n SKIP LOCKED`;
        if (!row) return false;
        const outcome = await deliver(row);
        if (outcome.sent) {
          await tx.$executeRaw`
            UPDATE notifications SET status = 'sent', sent_at = ${now}, attempts = attempts + 1
            WHERE id = ${row.id}::uuid`;
        } else {
          await tx.$executeRaw`
            UPDATE notifications
            SET attempts = attempts + 1, last_error = ${outcome.error},
                status = ${outcome.retryAt ? 'pending' : 'failed'},
                next_attempt_at = COALESCE(${outcome.retryAt}::timestamptz, next_attempt_at)
            WHERE id = ${row.id}::uuid`;
        }
        return true;
      },
      // SMTP может отвечать дольше таймаута транзакции Prisma по умолчанию (5 с)
      { timeout: 60_000 },
    );
  }
}
