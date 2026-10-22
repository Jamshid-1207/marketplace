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

  constructor(@Inject(CONFIG) config: Config) {
    const timeoutMs = config.UPSTREAM_TIMEOUT_MS;
    this.order = upstream({ target: config.ORDER_URL, timeoutMs, stripPrefix: '/api' });
    this.payment = upstream({ target: config.PAYMENT_URL, timeoutMs });
  }

  @All(['api/orders', 'api/orders/*path'])
  orders(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.order(req, res, next);
  }

  /** Без JWT и лимита: подлинность проверяет payment по подписи, провайдер повторяет сам. */
  @Public()
  @SkipThrottle()
  @Post('webhooks/psp')
  webhook(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction): void {
    void this.payment(req, res, next);
  }
}
