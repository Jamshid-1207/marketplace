import { Body, Controller, Get, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { PspStore } from './psp-store';
import { WebhookDispatcher } from './webhooks';

const Settings = z.object({ duplicateWebhooks: z.boolean().optional() });

/**
 * Управление для тестов (`PSP_TEST_API=true`): действия покупателя без браузера, режимы сбоев и
 * счётчики фактических списаний — e2e проверяет по ним, что деньги не списаны дважды.
 */
@Controller('test')
export class TestController {
  constructor(
    private readonly store: PspStore,
    private readonly webhooks: WebhookDispatcher,
  ) {}

  @Post('payments/:id/:action')
  act(
    @Param('id') id: string,
    @Param('action') action: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const actions = {
      authorize: () => this.store.authorize(id),
      decline: () => this.store.decline(id),
      expire: () => this.store.expire(id),
    } as const;
    if (!(action in actions)) throw new NotFoundException();
    const result = actions[action as keyof typeof actions]();
    res.status(result.status);
    return result.body;
  }

  /** Платёж целиком, со счётчиками `captures`, `voids`, `declines`. */
  @Get('payments/:id')
  payment(@Param('id') id: string) {
    const payment = this.store.get(id);
    if (!payment) throw new NotFoundException();
    return payment;
  }

  @Post('settings')
  settings(@Body() body: unknown) {
    const { duplicateWebhooks } = Settings.parse(body);
    if (duplicateWebhooks !== undefined) this.webhooks.options.duplicate = duplicateWebhooks;
    return { duplicateWebhooks: this.webhooks.options.duplicate };
  }

  @Get('webhooks')
  delivered() {
    return { delivered: this.webhooks.delivered };
  }
}
