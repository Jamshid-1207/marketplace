import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

export type ProcessOutcome = 'processed' | 'dlq';

/** Границы гистограмм в секундах: у SDK по умолчанию — миллисекундные, до 10 000. */
const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

/**
 * Метрики обработки сообщений (SD-09, п. 4): длительность по обработчику и исходу, повторы
 * после временных ошибок. Создаются вместе с runner'ом — после старта OpenTelemetry SDK; без
 * SDK (unit-тесты) инструменты пустые.
 */
export class ConsumerMetrics {
  private readonly duration: Histogram;
  private readonly retries: Counter;

  constructor(private readonly groupId: string) {
    const meter = metrics.getMeter('@repo/kafka');
    this.duration = meter.createHistogram('messaging.process.duration', {
      description: 'Обработка сообщения одним обработчиком, с повторами',
      unit: 's',
      advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
    });
    this.retries = meter.createCounter('messaging.process.retries', {
      description: 'Повторы обработчика после временной ошибки',
      unit: '{retry}',
    });
  }

  processed(topic: string, handler: string, outcome: ProcessOutcome, startedMs: number): void {
    this.duration.record((performance.now() - startedMs) / 1_000, {
      ...this.attributes(topic, handler),
      outcome,
    });
  }

  retried(topic: string, handler: string): void {
    this.retries.add(1, this.attributes(topic, handler));
  }

  private attributes(topic: string, handler: string) {
    return {
      'messaging.destination.name': topic,
      'messaging.consumer.group.name': this.groupId,
      handler,
    };
  }
}
