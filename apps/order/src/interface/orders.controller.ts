import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BuyerScope, type AccessScope } from '@repo/auth';
import {
  CreateOrderRequest,
  type CreateOrderResponse,
  type OrderListResponse,
  type OrderView,
} from '@repo/contracts';
import { z } from 'zod';
import { CheckoutService } from '../application/checkout.service';
import { InvalidCursorError, OrderQueries } from '../application/order.queries';
import { IdempotencyKeyReusedError, UnavailableSkusError } from '../application/ports';

type Buyer = AccessScope & { kind: 'buyer' };

const ListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Заказы покупателя (SD-02, п. 5.3). Покупатель — только из проверенного токена. */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly queries: OrderQueries,
  ) {}

  @Post()
  @HttpCode(202)
  async create(
    @BuyerScope() buyer: Buyer,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateOrderResponse> {
    if (!key || !z.uuid().safeParse(key).success) {
      throw new BadRequestException('нужен заголовок Idempotency-Key (UUID)');
    }
    const request = CreateOrderRequest.safeParse(body);
    if (!request.success) throw new BadRequestException(z.prettifyError(request.error));
    try {
      return await this.checkout.createOrder(buyer, key.toLowerCase(), request.data);
    } catch (error) {
      if (error instanceof UnavailableSkusError) {
        throw new UnprocessableEntityException({
          message: error.message,
          unavailable: error.skuIds,
        });
      }
      if (error instanceof IdempotencyKeyReusedError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  @Get()
  async list(@BuyerScope() buyer: Buyer, @Query() query: unknown): Promise<OrderListResponse> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    try {
      return await this.queries.list(buyer, parsed.data.cursor, parsed.data.limit);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get(':id')
  async get(
    @BuyerScope() buyer: Buyer,
    @Param('id', new ParseUUIDPipe()) orderId: string,
  ): Promise<OrderView> {
    const order = await this.queries.get(buyer, orderId);
    // чужой заказ — 404, а не 403: его существование не раскрывается (ADR-0006)
    if (!order) throw new NotFoundException();
    return order;
  }
}
