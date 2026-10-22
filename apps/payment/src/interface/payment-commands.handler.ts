import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CancelPaymentV1, CapturePaymentV1, CreatePaymentV1 } from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { PaymentService } from '../application/payment.service';

/**
 * Команды saga оформления из `payment.commands`. Без `processed_events`: идемпотентность держится
 * на статусе платежа — отметка «обработано» скрыла бы незавершённый вызов провайдера (SD-02, п. 6.2).
 */
@Injectable()
export class PaymentCommandsHandler implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly payments: PaymentService,
  ) {}

  onModuleInit(): void {
    this.runner
      .on(CreatePaymentV1, 'payment.create-payment', (e) => this.payments.create(e.payload))
      .on(CapturePaymentV1, 'payment.capture-payment', (e) => this.payments.capture(e.payload))
      .on(CancelPaymentV1, 'payment.cancel-payment', (e) => this.payments.cancel(e.payload));
  }
}
