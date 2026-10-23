import { Injectable } from '@nestjs/common';
import type { CategoryCreatedV1, PayloadOf } from '@repo/contracts';
import { PrismaService } from './prisma.service';

/**
 * Read-model категорий по `category.created | updated` (SD-05, п. 7): по ним админ задаёт ставки
 * комиссии. Событие несёт категорию целиком; не новее сохранённой версии — повтор, пропускается.
 */
@Injectable()
export class CategoryReadModel {
  constructor(private readonly prisma: PrismaService) {}

  /** `false` — событие устарело и ничего не изменило. */
  async apply(version: number, c: PayloadOf<typeof CategoryCreatedV1>): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      INSERT INTO categories (category_id, parent_id, name, version)
      VALUES (${c.categoryId}::uuid, ${c.parentId}::uuid, ${c.name}, ${version}::int)
      ON CONFLICT (category_id) DO UPDATE
        SET parent_id = EXCLUDED.parent_id, name = EXCLUDED.name, version = EXCLUDED.version
        WHERE categories.version < EXCLUDED.version`;
    return changed > 0;
  }
}
