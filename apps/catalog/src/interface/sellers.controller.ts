import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CurrentClaims,
  CurrentSeller,
  SellerScope,
  type Claims,
  type SellerAccess,
} from '@repo/auth';
import { z } from 'zod';
import { SellersService } from '../application/sellers.service';
import { http, parse } from './http';

const RegisterBody = z.object({ name: z.string().trim().min(2).max(200) });

/** Регистрация магазина и его статус в кабинете (SD-05, п. 6.2). */
@Controller()
export class SellersController {
  constructor(private readonly sellers: SellersService) {}

  /** Любой вошедший пользователь без магазина. Роль `seller` появится после обновления токена. */
  @Post('sellers')
  register(@CurrentClaims() claims: Claims, @Body() body: unknown) {
    return http(() => this.sellers.register(claims, parse(RegisterBody, body).name));
  }

  @Get('seller/shop')
  @SellerScope('catalog')
  shop(@CurrentSeller() seller: SellerAccess) {
    return http(() => this.sellers.shop(seller.sellerId));
  }
}
