import type { StockRepository } from './ports';
import { syncLevels } from './stock-levels';
import type { StockService } from './stock.service';

/** Область продавца из токена (ADR-0006, п. 5): каждый запрос кабинета ограничен ею. */
export interface SellerScope {
  sellerId: string;
}

export interface WarehouseView {
  warehouseId: string;
  name: string;
  priority: number;
  active: boolean;
}

export interface StockView {
  warehouseId: string;
  skuId: string;
  onHand: number;
  reserved: number;
  available: number;
}

export interface ThresholdView {
  skuId: string;
  lowThreshold: number;
  low: boolean;
}

/** Чтение и простые записи кабинета. Каждый метод фильтрует по `seller_id` из области. */
export interface CabinetRepository {
  warehouses(scope: SellerScope): Promise<WarehouseView[]>;
  createWarehouse(
    scope: SellerScope,
    warehouse: { name: string; priority: number },
  ): Promise<WarehouseView>;
  stock(scope: SellerScope): Promise<StockView[]>;
  thresholds(scope: SellerScope): Promise<ThresholdView[]>;
  ownsWarehouse(scope: SellerScope, warehouseId: string): Promise<boolean>;
  ownsSku(scope: SellerScope, skuId: string): Promise<boolean>;
}

/** Чужой или несуществующий ресурс — `404`: ответ не подтверждает, что он есть (ADR-0006, п. 5). */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} не найден`);
    this.name = 'NotFoundError';
  }
}

/** Изменение противоречит состоянию: например, остаток ниже резерва — `409`. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Склады и остатки в кабинете продавца (SD-03, п. 5.6). */
export class CabinetService {
  constructor(
    private readonly cabinet: CabinetRepository,
    private readonly stock: StockRepository,
    private readonly stockService: StockService,
  ) {}

  warehouses(scope: SellerScope) {
    return this.cabinet.warehouses(scope);
  }

  async createWarehouse(scope: SellerScope, warehouse: { name: string; priority: number }) {
    const existing = await this.cabinet.warehouses(scope);
    if (existing.some((w) => w.name === warehouse.name)) {
      throw new ConflictError(`склад «${warehouse.name}» уже есть`);
    }
    return this.cabinet.createWarehouse(scope, warehouse);
  }

  /**
   * Включение и выключение склада меняет, что можно зарезервировать: наличие его SKU
   * пересчитывается в той же транзакции (SD-07, п. 6).
   */
  async updateWarehouse(
    scope: SellerScope,
    warehouseId: string,
    changes: Partial<Omit<WarehouseView, 'warehouseId'>>,
  ): Promise<WarehouseView> {
    const updated = await this.stock.transaction(async (tx) => {
      const warehouse = await tx.updateWarehouse(scope.sellerId, warehouseId, changes);
      if (warehouse && changes.active !== undefined) {
        await syncLevels(tx, await tx.warehouseSkus(warehouseId));
      }
      return warehouse;
    });
    if (!updated) throw new NotFoundError('склад');
    return updated;
  }

  async stockLevels(scope: SellerScope) {
    const [stock, thresholds] = await Promise.all([
      this.cabinet.stock(scope),
      this.cabinet.thresholds(scope),
    ]);
    return { stock, thresholds };
  }

  /** Приход или списание на складе. Ниже уже зарезервированного — нельзя. */
  async adjust(
    scope: SellerScope,
    adjustment: { warehouseId: string; skuId: string; delta: number },
  ): Promise<StockView> {
    await this.requireOwn(scope, adjustment.warehouseId, adjustment.skuId);
    return this.stock.transaction(async (tx) => {
      const rows = await tx.lockStock([adjustment.skuId]);
      const row = rows.find((r) => r.warehouseId === adjustment.warehouseId);
      const onHand = (row?.onHand ?? 0) + adjustment.delta;
      const reserved = row?.reserved ?? 0;
      if (onHand < reserved) {
        throw new ConflictError(`остаток ${onHand} меньше зарезервированного ${reserved}`);
      }
      await tx.setOnHand(scope.sellerId, adjustment.warehouseId, adjustment.skuId, onHand);
      await this.stockService.stockChanged(tx, [adjustment.skuId]);
      return {
        warehouseId: adjustment.warehouseId,
        skuId: adjustment.skuId,
        onHand,
        reserved,
        available: onHand - reserved,
      };
    });
  }

  async setThreshold(scope: SellerScope, skuId: string, lowThreshold: number): Promise<void> {
    if (!(await this.cabinet.ownsSku(scope, skuId))) throw new NotFoundError('SKU');
    await this.stock.transaction(async (tx) => {
      const current = await tx.lockThreshold(skuId);
      await tx.saveThreshold({
        skuId,
        sellerId: scope.sellerId,
        lowThreshold,
        lowNotified: current?.lowNotified ?? false,
        version: current?.version ?? 0,
      });
      await this.stockService.checkLow(tx, [skuId]);
    });
  }

  private async requireOwn(scope: SellerScope, warehouseId: string, skuId: string) {
    if (!(await this.cabinet.ownsWarehouse(scope, warehouseId))) throw new NotFoundError('склад');
    if (!(await this.cabinet.ownsSku(scope, skuId))) throw new NotFoundError('SKU');
  }
}
