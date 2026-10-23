import { Injectable } from '@nestjs/common';
import { newId } from '@repo/contracts';
import type {
  CabinetRepository,
  SellerScope,
  StockView,
  ThresholdView,
  WarehouseView,
} from '../application/cabinet.service';
import { PrismaService } from './prisma.service';

const warehouseView = (row: WarehouseView): WarehouseView => ({
  warehouseId: row.warehouseId,
  name: row.name,
  priority: row.priority,
  active: row.active,
});

/** Кабинет продавца: каждый запрос — с `seller_id` из области доступа (ADR-0006, п. 5). */
@Injectable()
export class PrismaCabinetRepository implements CabinetRepository {
  constructor(private readonly prisma: PrismaService) {}

  async warehouses(scope: SellerScope): Promise<WarehouseView[]> {
    const rows = await this.prisma.warehouse.findMany({
      where: { sellerId: scope.sellerId },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    });
    return rows.map(warehouseView);
  }

  async createWarehouse(scope: SellerScope, warehouse: { name: string; priority: number }) {
    const row = await this.prisma.warehouse.create({
      data: { warehouseId: newId(), sellerId: scope.sellerId, ...warehouse },
    });
    return warehouseView(row);
  }

  async updateWarehouse(
    scope: SellerScope,
    warehouseId: string,
    changes: Partial<Omit<WarehouseView, 'warehouseId'>>,
  ): Promise<WarehouseView | null> {
    const { count } = await this.prisma.warehouse.updateMany({
      where: { warehouseId, sellerId: scope.sellerId },
      data: changes,
    });
    if (count === 0) return null;
    return warehouseView(await this.prisma.warehouse.findUniqueOrThrow({ where: { warehouseId } }));
  }

  async stock(scope: SellerScope): Promise<StockView[]> {
    const rows = await this.prisma.stock.findMany({
      where: { sellerId: scope.sellerId },
      orderBy: [{ skuId: 'asc' }, { warehouseId: 'asc' }],
    });
    return rows.map((row) => ({
      warehouseId: row.warehouseId,
      skuId: row.skuId,
      onHand: row.onHand,
      reserved: row.reserved,
      available: row.onHand - row.reserved,
    }));
  }

  async thresholds(scope: SellerScope): Promise<ThresholdView[]> {
    const rows = await this.prisma.stockThreshold.findMany({
      where: { sellerId: scope.sellerId },
      orderBy: { skuId: 'asc' },
    });
    return rows.map((row) => ({
      skuId: row.skuId,
      lowThreshold: row.lowThreshold,
      low: row.lowNotified,
    }));
  }

  async ownsWarehouse(scope: SellerScope, warehouseId: string): Promise<boolean> {
    return (
      (await this.prisma.warehouse.count({ where: { warehouseId, sellerId: scope.sellerId } })) > 0
    );
  }

  async ownsSku(scope: SellerScope, skuId: string): Promise<boolean> {
    return (await this.prisma.catalogSku.count({ where: { skuId, sellerId: scope.sellerId } })) > 0;
  }
}
