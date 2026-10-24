import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BuyerScope, type AccessScope } from '@repo/auth';
import {
  MergeCartRequest,
  SetCartLineRequest,
  type CartView,
  type MergeCartResponse,
} from '@repo/contracts';
import { z } from 'zod';
import { CartService } from '../application/cart.service';
import { CartLimitError, UnavailableSkusError } from '../application/ports';

type Buyer = AccessScope & { kind: 'buyer' };

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}

/** Снятый с продажи SKU и 51-я строка — `422`, как у `POST /orders`. */
async function cartHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnavailableSkusError) {
      throw new UnprocessableEntityException({
        message: error.message,
        unavailable: error.skuIds,
      });
    }
    if (error instanceof CartLimitError) throw new UnprocessableEntityException(error.message);
    throw error;
  }
}

/** Корзина покупателя (SD-07, п. 5.2). Покупатель — только из проверенного токена. */
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  view(@BuyerScope() buyer: Buyer): Promise<CartView> {
    return this.cart.view(buyer);
  }

  @Put('lines/:skuId')
  setLine(
    @BuyerScope() buyer: Buyer,
    @Param('skuId', new ParseUUIDPipe()) skuId: string,
    @Body() body: unknown,
  ): Promise<CartView> {
    const { qty } = parse(SetCartLineRequest, body);
    return cartHttp(() => this.cart.setLine(buyer, { skuId, qty }));
  }

  @Delete('lines/:skuId')
  @HttpCode(204)
  async removeLine(
    @BuyerScope() buyer: Buyer,
    @Param('skuId', new ParseUUIDPipe()) skuId: string,
  ): Promise<void> {
    await this.cart.removeLine(buyer, skuId);
  }

  @Post('merge')
  @HttpCode(200)
  merge(@BuyerScope() buyer: Buyer, @Body() body: unknown): Promise<MergeCartResponse> {
    return this.cart.merge(buyer, parse(MergeCartRequest, body));
  }
}
