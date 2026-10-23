import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { PspStore, view, type PspResponse } from './psp-store';

const RefundBody = z.object({
  amountMinor: z.number().int().positive().refine(Number.isSafeInteger),
});

const CreatePaymentBody = z.object({
  merchantReference: z.string().min(1).max(100),
  amountMinor: z.number().int().positive().refine(Number.isSafeInteger),
  currency: z.literal('UZS'),
});

function requireKey(key: string | undefined): string {
  if (!key) throw new BadRequestException('нужен заголовок Idempotency-Key');
  return key;
}

function send(res: Response, response: PspResponse): unknown {
  res.status(response.status);
  return response.body;
}

/** API провайдера для payment (SD-02, п. 3.2). Изменяющие запросы — только с `Idempotency-Key`. */
@Controller('v1/payments')
export class PaymentsController {
  constructor(private readonly store: PspStore) {}

  @Post()
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = CreatePaymentBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    return send(
      res,
      this.store.idempotent(requireKey(key), { op: 'create', ...parsed.data }, () =>
        this.store.create(parsed.data),
      ),
    );
  }

  @Get(':id')
  get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const payment = this.store.get(id);
    return send(res, payment ? { status: 200, body: view(payment) } : { status: 404, body: {} });
  }

  @Post(':id/capture')
  capture(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(
      res,
      this.store.idempotent(requireKey(key), { op: 'capture', id }, () => this.store.capture(id)),
    );
  }

  @Post(':id/refund')
  refund(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = RefundBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    const { amountMinor } = parsed.data;
    return send(
      res,
      this.store.idempotent(requireKey(key), { op: 'refund', id, amountMinor }, () =>
        this.store.refund(id, amountMinor),
      ),
    );
  }

  @Post(':id/void')
  void(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(
      res,
      this.store.idempotent(requireKey(key), { op: 'void', id }, () => this.store.void(id)),
    );
  }
}
