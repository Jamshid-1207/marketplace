import { All, Controller, Inject, Next, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Public } from '@repo/auth';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CONFIG, type Config } from '../config';
import { upstream } from './upstream';

/**
 * Маршруты во внутренние сервисы (SD-02, п. 3.1). JWT на `/api/**` проверяет глобальный
 * `AuthGuard`, затем лимит запросов; сервисы проверяют токен ещё раз сами (ADR-0006, п. 4).
 */
@Controller()
@UseGuards(ThrottlerGuard)
export class ProxyController {
  private readonly order: RequestHandler;
  private readonly payment: RequestHandler;
  private readonly erp: RequestHandler;

  constructor(@Inject(CONFIG) config: Config) {
    const timeoutMs = config.UPSTREAM_TIMEOUT_MS;
    this.order = upstream({ target: config.ORDER_URL, timeoutMs, stripPrefix: '/api' });
    this.payment = upstream({ target: config.PAYMENT_URL, timeoutMs });
    this.erp = upstream({ target: config.ERP_URL, timeoutMs, stripPrefix: '/api' });
  }

  /** Заказы покупателя и под-заказы в кабинете продавца — в order (SD-03, п. 6.3). */
  @All(['api/orders', 'api/orders/*path', 'api/seller/sub-orders', 'api/seller/sub-orders/*path'])
  orders(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.order(req, res, next);
  }

  /** Склады и остатки в кабинете продавца — в erp (SD-03, п. 5.6). */
  @All([
    'api/seller/warehouses',
    'api/seller/warehouses/*path',
    'api/seller/stock',
    'api/seller/stock/*path',
  ])
  warehouse(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.erp(req, res, next);
  }

  /** Без JWT и лимита: подлинность проверяет payment по подписи, провайдер повторяет сам. */
  @Public()
  @SkipThrottle()
  @Post('webhooks/psp')
  webhook(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.payment(req, res, next);
  }
}
