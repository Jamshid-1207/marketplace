import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentSeller, SellerScope, type SellerAccess } from '@repo/auth';
import {
  SellerSubOrdersQuery,
  type SellerSubOrderList,
  type SellerSubOrderView,
  type SubOrderActionResponse,
} from '@repo/contracts';
import { z } from 'zod';
import type { SellerSubOrderReader } from '../application/ports';
import {
  SubOrderConflictError,
  SubOrderNotFoundError,
  SubOrderService,
} from '../application/sub-order.service';
import type { SubOrderAction } from '../domain/sub-order';

export const SELLER_SUB_ORDER_READER = Symbol('SELLER_SUB_ORDER_READER');

/** Ошибки действий → HTTP: чужое — 404, недопустимый переход — 409 (ADR-0005, п. 9). */
export async function subOrderHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SubOrderNotFoundError) throw new NotFoundException();
    if (error instanceof SubOrderConflictError) throw new ConflictException(error.message);
    throw error;
  }
}

/** Под-заказы в кабинете продавца (SD-03, п. 6.3). Право — `orders`. */
@Controller('seller/sub-orders')
export class SellerSubOrdersController {
  constructor(
    private readonly subOrders: SubOrderService,
    @Inject(SELLER_SUB_ORDER_READER) private readonly reader: SellerSubOrderReader,
  ) {}

  @Get()
  @SellerScope('orders')
  async list(
    @CurrentSeller() seller: SellerAccess,
    @Query() query: unknown,
  ): Promise<SellerSubOrderList> {
    const parsed = SellerSubOrdersQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    const { status, cursor, limit } = parsed.data;
    const items = await this.reader.list(seller, { status, after: cursor ?? null, limit });
    return {
      items,
      nextCursor: items.length === limit ? (items.at(-1)?.subOrderId ?? null) : null,
    };
  }

  @Get(':id')
  @SellerScope('orders')
  async get(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SellerSubOrderView> {
    const subOrder = await this.reader.get(seller, id);
    if (!subOrder) throw new NotFoundException();
    return subOrder;
  }

  @Post(':id/ship')
  @HttpCode(200)
  @SellerScope('orders')
  ship(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SubOrderActionResponse> {
    return this.act(seller, id, 'ship');
  }

  @Post(':id/deliver')
  @HttpCode(200)
  @SellerScope('orders')
  deliver(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SubOrderActionResponse> {
    return this.act(seller, id, 'deliver');
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @SellerScope('orders')
  cancel(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SubOrderActionResponse> {
    return this.act(seller, id, 'cancel');
  }

  private act(seller: SellerAccess, subOrderId: string, action: SubOrderAction) {
    return subOrderHttp(() =>
      this.subOrders.act({ kind: 'seller', sellerId: seller.sellerId }, subOrderId, action),
    );
  }
}
