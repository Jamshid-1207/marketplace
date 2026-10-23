import { DEV_USERS, UserRegisteredV1 } from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import type { PasswordHasher } from '../application/ports';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * Тестовые пользователи стенда (решение 6 SD-05) с общим паролем. Владельцы магазинов получат
 * членство из `seller.registered` seed catalog; сотрудник заводится здесь, его статус магазина
 * обновит `seller.approved`. `user.registered` — через outbox, как при регистрации: по нему crm и
 * notification узнают email (решение 7 SD-06). Повторный запуск ничего не меняет и событий не повторяет.
 */
export async function seedDevUsers(
  prisma: PrismaClient,
  password: string,
  hasher: PasswordHasher,
): Promise<number> {
  const passwordHash = await hasher.hash(password);
  let created = 0;
  for (const user of DEV_USERS) {
    const inserted = await runInNewChain(() =>
      prisma.$transaction(async (tx) => {
        const rows = await tx.$executeRaw`
          INSERT INTO users (user_id, email, password_hash, is_admin)
          VALUES (${user.userId}::uuid, ${user.email}, ${passwordHash}, ${user.roles.includes('admin')})
          ON CONFLICT DO NOTHING`;
        if (rows > 0) {
          await outbox.add(
            tx,
            UserRegisteredV1,
            { userId: user.userId, email: user.email },
            { aggregateId: user.userId, aggregateVersion: 1 },
          );
        }
        return rows;
      }),
    );
    created += inserted;
    if (user.roles.includes('seller_manager') && user.sellerId) {
      await prisma.$executeRaw`
        INSERT INTO memberships (user_id, seller_id, role, scopes, seller_status)
        VALUES (${user.userId}::uuid, ${user.sellerId}::uuid, 'seller_manager', ${user.scopes}::text[],
                COALESCE((SELECT seller_status FROM memberships
                          WHERE seller_id = ${user.sellerId}::uuid AND role = 'seller'), 'pending'))
        ON CONFLICT DO NOTHING`;
    }
  }
  return created;
}
