import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CurrentClaims,
  CurrentSeller,
  SellerScope,
  type Claims,
  type SellerAccess,
} from '@repo/auth';
import { RegisterShopRequest, type ShopView } from '@repo/contracts';
import { SellersService } from '../application/sellers.service';
import { http, parse } from './http';

/** Регистрация магазина и его статус в кабинете (SD-05, п. 6.2). */
@Controller()
export class SellersController {
  constructor(private readonly sellers: SellersService) {}

  /** Любой вошедший пользователь без магазина. Роль `seller` появится после обновления токена. */
  @Post('sellers')
  register(@CurrentClaims() claims: Claims, @Body() body: unknown): Promise<ShopView> {
    return http(() => this.sellers.register(claims, parse(RegisterShopRequest, body).name));
  }

  @Get('seller/shop')
  @SellerScope('catalog')
  shop(@CurrentSeller() seller: SellerAccess): Promise<ShopView> {
    return http(() => this.sellers.shop(seller.sellerId));
  }
}
