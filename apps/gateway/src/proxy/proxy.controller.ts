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
  private readonly paymentApi: RequestHandler;
  private readonly auth: RequestHandler;
  private readonly catalog: RequestHandler;

  constructor(@Inject(CONFIG) config: Config) {
    const timeoutMs = config.UPSTREAM_TIMEOUT_MS;
    this.order = upstream({ target: config.ORDER_URL, timeoutMs, stripPrefix: '/api' });
    this.payment = upstream({ target: config.PAYMENT_URL, timeoutMs });
    this.erp = upstream({ target: config.ERP_URL, timeoutMs, stripPrefix: '/api' });
    this.paymentApi = upstream({ target: config.PAYMENT_URL, timeoutMs, stripPrefix: '/api' });
    this.auth = upstream({ target: config.AUTH_URL, timeoutMs, stripPrefix: '/api' });
    this.catalog = upstream({ target: config.CATALOG_URL, timeoutMs, stripPrefix: '/api' });
  }

  /**
   * Вход, регистрация и обновление токена — в auth (SD-05, п. 5.3): без JWT, лимит — на IP.
   * `/auth/me` auth проверяет сам.
   */
  @Public()
  @All('api/auth/*path')
  accounts(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.auth(req, res, next);
  }

  /** Сотрудники магазина — в auth (SD-05, п. 5.3). */
  @All(['api/seller/staff', 'api/seller/staff/*path'])
  staff(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.auth(req, res, next);
  }

  /** Витрина каталога — публична (SD-05, п. 6.4). */
  @Public()
  @All('api/catalog/*path')
  storefront(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.catalog(req, res, next);
  }

  /**
   * Магазины, товары в кабинете и модерация — в catalog (SD-05, п. 6). Объявлен раньше админки
   * денег: Express выбирает первый подходящий маршрут, а `api/admin/*path` шире.
   */
  @All([
    'api/sellers',
    'api/seller/shop',
    'api/seller/products',
    'api/seller/products/*path',
    'api/admin/sellers',
    'api/admin/sellers/*path',
    'api/admin/products',
    'api/admin/products/*path',
    'api/admin/categories',
    'api/admin/categories/*path',
  ])
  products(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.catalog(req, res, next);
  }

  /** Заказы покупателя и под-заказы в кабинете продавца — в order (SD-03, п. 6.3). */
  @All(['api/orders', 'api/orders/*path', 'api/seller/sub-orders', 'api/seller/sub-orders/*path'])
  orders(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.order(req, res, next);
  }

  /** Склады, остатки и реестр продаж в кабинете продавца — в erp (SD-03, п. 5.6; SD-04, п. 7). */
  @All([
    'api/seller/warehouses',
    'api/seller/warehouses/*path',
    'api/seller/stock',
    'api/seller/stock/*path',
    'api/seller/sales/*path',
  ])
  warehouse(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.erp(req, res, next);
  }

  /** Финансы и выплаты продавца, админка денег — в payment (SD-04, п. 4, 8). */
  @All([
    'api/seller/finance/*path',
    'api/seller/payouts',
    'api/seller/payouts/*path',
    'api/admin/*path',
  ])
  money(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.paymentApi(req, res, next);
  }

  /** Без JWT и лимита: подлинность проверяет payment по подписи, провайдер повторяет сам. */
  @Public()
  @SkipThrottle()
  @Post('webhooks/psp')
  webhook(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.payment(req, res, next);
  }
}
