import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type CollectionResult,
} from '@opentelemetry/sdk-metrics';
import { RelayMetrics } from './metrics';
import type { OutboxRecord } from './relay';

/** Читатель по запросу: тест сам собирает метрики, без таймеров экспорта. */
class ManualReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const reader = new ManualReader();
const provider = new MeterProvider({ readers: [reader] });

beforeAll(() => metrics.setGlobalMeterProvider(provider));
afterAll(async () => {
  metrics.disable();
  await provider.shutdown();
});

function points(result: CollectionResult, name: string) {
  return result.resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap(
      (metric) => metric.dataPoints as { value: unknown; attributes: Record<string, unknown> }[],
    );
}

const record = (id: string, createdAt: Date, topic = 'order.events'): OutboxRecord => ({
  id,
  eventId: id,
  topic,
  key: 'k',
  payload: {},
  headers: {},
  createdAt,
});

describe('метрики outbox relay (SD-09, п. 4)', () => {
  it('возраст самой старой записи — у лидера; пустая очередь и не лидер — 0', async () => {
    const relayMetrics = new RelayMetrics();
    const now = Date.parse('2026-10-25T10:00:10Z');
    relayMetrics.fetched(
      [record('1', new Date(now - 4_000)), record('2', new Date(now - 1_000))],
      now,
    );
    expect(points(await reader.collect(), 'outbox.oldest_unpublished.age')).toEqual([
      expect.objectContaining({ value: 4 }),
    ]);

    relayMetrics.fetched([], now);
    expect(points(await reader.collect(), 'outbox.oldest_unpublished.age')).toEqual([
      expect.objectContaining({ value: 0 }),
    ]);

    relayMetrics.fetched([record('3', new Date(now - 9_000))], now);
    relayMetrics.notLeader();
    expect(points(await reader.collect(), 'outbox.oldest_unpublished.age')).toEqual([
      expect.objectContaining({ value: 0 }),
    ]);
  });

  it('задержка отправки — по каждой записи с топиком', async () => {
    const relayMetrics = new RelayMetrics();
    const now = Date.parse('2026-10-25T10:00:10Z');
    relayMetrics.published(
      [record('1', new Date(now - 2_000), 'erp.events'), record('2', new Date(now - 500))],
      now,
    );
    const delays = points(await reader.collect(), 'outbox.publish.delay');
    expect(delays.map((p) => p.attributes['messaging.destination.name']).sort()).toEqual([
      'erp.events',
      'order.events',
    ]);
    expect(delays.map((p) => (p.value as { sum: number }).sum).sort()).toEqual([0.5, 2]);
  });
});
