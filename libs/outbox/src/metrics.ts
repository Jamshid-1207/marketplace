import { metrics, type Histogram } from '@opentelemetry/api';
import type { OutboxRecord } from './relay';

/** Границы гистограммы в секундах: у SDK по умолчанию — миллисекундные, до 10 000. */
const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

/**
 * Метрики relay (SD-09, п. 4): задержка от записи в outbox до отправки в Kafka и возраст самой
 * старой неотправленной записи. Очередь читает только лидер, остальные relay сообщают 0:
 * дашборд берёт максимум по сервису, а бывший лидер не держит устаревшее значение.
 */
export class RelayMetrics {
  private readonly delay: Histogram;
  private oldestAgeSeconds = 0;

  constructor() {
    const meter = metrics.getMeter('@repo/outbox');
    this.delay = meter.createHistogram('outbox.publish.delay', {
      description: 'От записи в outbox до отправки в Kafka',
      unit: 's',
      advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
    });
    meter
      .createObservableGauge('outbox.oldest_unpublished.age', {
        description: 'Возраст самой старой неотправленной записи; 0 — очередь пуста',
        unit: 's',
      })
      .addCallback((result) => result.observe(this.oldestAgeSeconds));
  }

  /** Лидер прочитал батч: записи идут по возрастанию `id`, первая — самая старая. */
  fetched(records: readonly OutboxRecord[], nowMs: number): void {
    const oldest = records[0]?.createdAt;
    this.oldestAgeSeconds = oldest ? Math.max(0, (nowMs - oldest.getTime()) / 1_000) : 0;
  }

  published(records: readonly OutboxRecord[], nowMs: number): void {
    for (const record of records) {
      if (!record.createdAt) continue;
      this.delay.record(Math.max(0, (nowMs - record.createdAt.getTime()) / 1_000), {
        'messaging.destination.name': record.topic,
      });
    }
  }

  notLeader(): void {
    this.oldestAgeSeconds = 0;
  }
}
