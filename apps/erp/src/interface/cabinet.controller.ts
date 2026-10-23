import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentSeller, SellerScope, type SellerAccess } from '@repo/auth';
import { z } from 'zod';
import { CabinetService, ConflictError, NotFoundError } from '../application/cabinet.service';

const WarehouseBody = z.object({
  name: z.string().trim().min(1).max(100),
  priority: z.number().int().min(1).max(1_000),
});
const WarehouseChanges = WarehouseBody.extend({ active: z.boolean() }).partial();
const AdjustmentBody = z.object({
  warehouseId: z.uuid(),
  skuId: z.uuid(),
  delta: z
    .number()
    .int()
    .refine((d) => d !== 0, 'delta не может быть 0'),
  reason: z.string().trim().min(1).max(200),
});
const ThresholdBody = z.object({ threshold: z.number().int().min(1).max(1_000_000) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}

/** Ошибки use case'ов → HTTP: чужое — 404, противоречие состоянию — 409. */
async function http<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof NotFoundError) throw new NotFoundException(error.message);
    if (error instanceof ConflictError) throw new ConflictException(error.message);
    throw error;
  }
}

/** Склады и остатки в кабинете продавца (SD-03, п. 5.6). Право — `warehouse`. */
@Controller('seller')
export class CabinetController {
  constructor(private readonly cabinet: CabinetService) {}

  @Get('warehouses')
  @SellerScope('warehouse')
  warehouses(@CurrentSeller() seller: SellerAccess) {
    return this.cabinet.warehouses(seller);
  }

  @Post('warehouses')
  @SellerScope('warehouse')
  createWarehouse(@CurrentSeller() seller: SellerAccess, @Body() body: unknown) {
    return http(() => this.cabinet.createWarehouse(seller, parse(WarehouseBody, body)));
  }

  @Patch('warehouses/:id')
  @SellerScope('warehouse')
  updateWarehouse(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', new ParseUUIDPipe()) warehouseId: string,
    @Body() body: unknown,
  ) {
    return http(() =>
      this.cabinet.updateWarehouse(seller, warehouseId, parse(WarehouseChanges, body)),
    );
  }

  @Get('stock')
  @SellerScope('warehouse')
  stock(@CurrentSeller() seller: SellerAccess) {
    return this.cabinet.stockLevels(seller);
  }

  @Post('stock/adjustments')
  @SellerScope('warehouse')
  adjust(@CurrentSeller() seller: SellerAccess, @Body() body: unknown) {
    const { warehouseId, skuId, delta } = parse(AdjustmentBody, body);
    return http(() => this.cabinet.adjust(seller, { warehouseId, skuId, delta }));
  }

  @Put('stock/:skuId/threshold')
  @HttpCode(204)
  @SellerScope('warehouse')
  async setThreshold(
    @CurrentSeller() seller: SellerAccess,
    @Param('skuId', new ParseUUIDPipe()) skuId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { threshold } = parse(ThresholdBody, body);
    await http(() => this.cabinet.setThreshold(seller, skuId, threshold));
  }
}
