import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { Public } from '@repo/auth';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { PaymentService, type WebhookResult } from '../application/payment.service';
import { PayoutService } from '../application/payout.service';
import { CONFIG, type Config } from '../config';
import { SIGNATURE_HEADER, verifySignature } from '../infrastructure/psp/signature';

const PspWebhookBody = z.object({
  id: z.string().min(1).max(100),
  type: z.string(),
  data: z.object({ merchantReference: z.string(), reason: z.string().max(200).optional() }),
});

const PAYMENT_TYPES = new Set(['payment.authorized', 'payment.expired']);
const PAYOUT_TYPES = new Set(['payout.paid', 'payout.failed']);

/**
 * Webhook провайдера (SD-02, п. 6.3; SD-04, п. 6). Без JWT: подлинность — подпись HMAC. Ответ
 * не 2xx — провайдер повторит, поэтому временная ошибка — 503, а не потеря события.
 */
@Controller('webhooks')
export class PspWebhookController {
  constructor(
    private readonly payments: PaymentService,
    private readonly payouts: PayoutService,
    @Inject(CONFIG) private readonly config: Config,
    private readonly log: PinoLogger,
  ) {
    this.log.setContext('psp-webhook');
  }

  @Public()
  @Post('psp')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers(SIGNATURE_HEADER) signature: string | undefined,
  ) {
    // подпись — от байтов тела, а не от разобранного JSON
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!verifySignature(raw, signature, this.config.PSP_WEBHOOK_SECRET, Date.now())) {
      throw new UnauthorizedException('неверная подпись webhook');
    }
    const parsed = PspWebhookBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    const event = parsed.data;
    const known = PAYMENT_TYPES.has(event.type) || PAYOUT_TYPES.has(event.type);
    if (!known || !z.uuid().safeParse(event.data.merchantReference).success) {
      this.log.info({ eventId: event.id, type: event.type }, 'webhook не для нас, пропуск');
      return { received: true };
    }

    let result: WebhookResult;
    try {
      result = PAYOUT_TYPES.has(event.type)
        ? await this.payouts
            .onWebhook(
              event.data.merchantReference,
              event.type === 'payout.paid' ? 'paid' : 'failed',
              event.data.reason,
            )
            .then(() => 'processed' as const)
        : await this.payments.handleWebhook({
            id: event.id,
            type: event.type as 'payment.authorized' | 'payment.expired',
            data: { merchantReference: event.data.merchantReference },
          });
    } catch (err) {
      this.log.error({ err, eventId: event.id }, 'webhook не обработан');
      throw new ServiceUnavailableException('webhook не обработан, повторите');
    }
    if (result === 'retry-later') {
      throw new ServiceUnavailableException('платёж ещё создаётся, повторите');
    }
    return { received: true };
  }
}
