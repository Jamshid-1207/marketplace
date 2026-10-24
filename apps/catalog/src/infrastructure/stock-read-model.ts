import { Injectable } from '@nestjs/common';
import type { PayloadOf, StockLevelChangedV1 } from '@repo/contracts';
import { PrismaService } from './prisma.service';

/**
 * Наличие SKU на витрине по `stock.level-changed` (SD-07, п. 6). Событие не новее сохранённой
 * версии — повтор или опоздавшее из DLQ, оно ничего не меняет (ADR-0004, п. 3, правило 5).
 * Строки нет — товара нет: erp ещё не сообщал о его остатке.
 */
@Injectable()
export class StockReadModel {
  constructor(private readonly prisma: PrismaService) {}

  /** `false` — событие устарело и ничего не изменило. */
  async levelChanged(version: number, p: PayloadOf<typeof StockLevelChangedV1>): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      INSERT INTO sku_stock (sku_id, in_stock, version)
      VALUES (${p.skuId}::uuid, ${p.inStock}, ${version}::int)
      ON CONFLICT (sku_id) DO UPDATE SET in_stock = EXCLUDED.in_stock, version = EXCLUDED.version
        WHERE sku_stock.version < EXCLUDED.version
      RETURNING sku_id`;
    return rows.length > 0;
  }
}
