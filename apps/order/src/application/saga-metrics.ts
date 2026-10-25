import { metrics, type Counter } from '@opentelemetry/api';
import type { CheckoutState } from '@repo/contracts';

/**
 * Переходы saga оформления (SD-09, п. 4): дашборд показывает поток заказов по состояниям и
 * отмены. Пишется после коммита транзакции перехода — откат не завышает счётчик.
 */
export class SagaMetrics {
  private readonly transitions: Counter = metrics
    .getMeter('order')
    .createCounter('checkout.saga.transitions', {
      description: 'Переходы saga оформления; from=NEW — заказ создан',
      unit: '{transition}',
    });

  record(from: CheckoutState | 'NEW', to: CheckoutState): void {
    if (from !== to) this.transitions.add(1, { from, to });
  }
}
